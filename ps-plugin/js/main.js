'use strict';
/* 清框影 PS 桥接 PoC —— CEP 面板侧。
   流程：ExtendScript 导出当前图层 → 面板里用桌面同一份 Canvas 引擎渲染 →
   写回 PNG → ExtendScript 作为新图层贴回文档。
   本机没有 Photoshop 时可用 window.qfMockHost 跑同一条链路做自测。 */
(function () {
    const cs = (typeof CSInterface === 'function') ? new CSInterface() : null;
    const cepFs = (typeof cep !== 'undefined' && cep.fs) ? cep.fs : null;
    const logEl = document.getElementById('log');
    const presetSel = document.getElementById('preset');
    const canvas = document.getElementById('renderCanvas');
    const btnBorder = document.getElementById('btnBorder');
    const btnReset = document.getElementById('btnReset');
    const presetSearch = document.getElementById('presetSearch');

    let busy = false;
    let lastDocPath = '';

    function log(s) {
        if (!logEl) return;
        const line = String(s);
        logEl.textContent += line + '\n';
        // 日志只留最近一段，避免长时间使用后越滚越大
        if (logEl.textContent.length > 24000) logEl.textContent = logEl.textContent.slice(-18000);
        if (/失败|ERR|错误/.test(line)) {
            const panel = document.getElementById('logPanel');
            if (panel) panel.open = true;
        }
    }
    function clearLog() { if (logEl) logEl.textContent = ''; }
    function setStatus(msg, kind) {
        const el = document.getElementById('status');
        if (!el) return;
        el.textContent = msg || '';
        el.className = 'status' + (kind ? ' ' + kind : '');
    }

    function evalScript(src) {
        return new Promise((resolve) => {
            try {
                if (window.qfMockHost) return window.qfMockHost.eval(src, resolve);
                if (cs && typeof cs.evalScript === 'function') return cs.evalScript(src, resolve);
            } catch (e) {
                return resolve('ERR:' + ((e && e.message) || e));
            }
            resolve('ERR:没有 Photoshop 宿主');
        });
    }
    function readBase64(path) {
        return new Promise((resolve, reject) => {
            if (window.qfMockHost) return window.qfMockHost.read(path, resolve);
            if (!cepFs) return reject(new Error('cep.fs 不可用：检查 manifest 的 --enable-nodejs'));
            cepFs.readFile(path, cep.encoding.Base64, (err, data) => {
                if (err) return reject(new Error('读取失败：' + (err.message || err)));
                if (!data) return reject(new Error('文件内容为空：' + path));
                resolve(data);
            });
        });
    }
    function writeBase64(path, b64) {
        return new Promise((resolve) => {
            if (window.qfMockHost) return window.qfMockHost.write(path, b64, resolve);
            // CEP 开了 --enable-nodejs/--mixed-context，优先用 Node fs 直接写二进制，
            // 比 cep.fs.writeFile(base64) 稳定；失败再退回 cep.fs。
            try {
                const nodeFs = require('fs');
                nodeFs.writeFile(path, Buffer.from(b64, 'base64'), (err) => {
                    resolve(err ? { error: err.message || String(err) } : true);
                });
                return;
            } catch (e) { /* 没有 require 时走 cep.fs */ }
            if (cepFs) cepFs.writeFile(path, b64, cep.encoding.Base64, (err) => {
                resolve(err ? { error: String(err && err.message || err) } : true);
            });
            else resolve({ error: 'cep.fs 不可用' });
        });
    }
    let exifInfo = null;
    let previewSource = null;
    let liveTemplate = null;
    let lastTemplate = null;
    let sourceCache = { key: '', loaded: null, path: '' };
    let previewTimer = 0;
    let lastPreviewAt = 0;
    const PREVIEW_GAP = 90; // 拖动滑块时最多约 11 帧/秒，避免每个 input 都重渲染

    function doPreviewRender() {
        if (!previewSource || !liveTemplate) return;
        try {
            const pc = document.getElementById('previewCanvas');
            if (!pc) return;
            const A = window.App;
            A.dom = { canvas: pc };
            A.image = previewSource;
            A.images = [previewSource];
            A.template = liveTemplate;
            A.selectedEls = [];
            A.displayMax = Math.max(previewSource.w, previewSource.h);
            A.uiDprOverride = 1;
            A._gesture = false;
            A._forceFitNext = true;
            delete A.exportScale;
            syncImageExif(liveTemplate, previewSource);
            window.__render(A, false);
            const meta = document.getElementById('previewMeta');
            if (meta) {
                meta.textContent = (liveTemplate.templateName || '自定义风格')
                    + ' · 预览 ' + pc.width + '×' + pc.height;
            }
        } catch (e) {
            log('预览失败：' + ((e && e.message) || e));
        }
    }

    // 节流而不是防抖：拖动过程中也能持续看到变化，同时不会把主线程塞满。
    function renderPreviewLive() {
        if (!previewSource || !liveTemplate) return;
        if (previewTimer) return;
        const wait = Math.max(0, PREVIEW_GAP - (performance.now() - lastPreviewAt));
        previewTimer = setTimeout(() => {
            previewTimer = 0;
            lastPreviewAt = performance.now();
            doPreviewRender();
        }, wait);
    }

    async function readBytes(path) {
        if (window.qfMockHost) {
            const b64 = await readBase64(path);
            if (!b64) throw new Error('读不到源文件');
            const bin = atob(b64);
            const out = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return out;
        }
        const nodeFs = require('fs');
        const buf = nodeFs.readFileSync(path);
        return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    }

    const EXIF_FIELDS = [
        ['make', '品牌'], ['model', '型号'], ['focal', '焦距'],
        ['aperture', '光圈'], ['iso', 'ISO'], ['shutter', '快门']
    ];
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }
    function renderExifFields(msg) {
        const host = document.getElementById('exifFields');
        if (!host) return;
        host.innerHTML = EXIF_FIELDS.map(([k, l]) =>
            `<div class="exif-row"><label>${l}</label>`
            + `<input data-exif="${k}" value="${esc(exifInfo && exifInfo[k] || '')}"></div>`
        ).join('') + (msg ? `<div class="exif-text">${esc(msg)}</div>` : '');
        host.querySelectorAll('[data-exif]').forEach((el) => {
            el.addEventListener('input', () => {
                if (!exifInfo) exifInfo = {};
                exifInfo[el.dataset.exif] = el.value;
                if (liveTemplate) { applyExif(liveTemplate); renderPreviewLive(); }
            });
        });
    }

    function applyDocProfile(profile) {
        const sel = document.getElementById('selColorSpace');
        if (!sel || !profile) return;
        const lower = String(profile).toLowerCase();
        let cs = 'srgb';
        if (/adobe/.test(lower) && /rgb/.test(lower)) cs = 'adobergb';
        else if (/p3/.test(lower)) cs = 'p3';
        sel.value = cs;
        const opt = sel.options[sel.selectedIndex];
        log('文档色彩配置：' + profile + ' → 输出 ' + (opt ? opt.text : cs));
    }

    async function detectExif() {
        try {
            const r = await evalScript('qfGetDocPath()');
            if (String(r).indexOf('ERR') === 0) { renderExifFields(r); return; }
            const parts = String(r).split('|');
            applyDocProfile(parts[1] || '');
            lastDocPath = parts[0].slice(3);
            const bytes = await readBytes(parts[0].slice(3));
            const raw = window.__parseExif(bytes.buffer);
            const info = window.__exifSummary(raw) || {};
            exifInfo = info;
            if (liveTemplate) {
                applyExif(liveTemplate);
                syncImageExif(liveTemplate, previewSource);
                renderPreviewLive();
            }
            renderExifFields(info.focal35 ? `等效 ${info.focal35}mm · 可手动修改` : '可手动修改');
        } catch (e) {
            renderExifFields('识别失败：' + ((e && e.message) || e));
        }
    }

    function applyExif(t) {
        const chk = document.getElementById('chkExifAuto');
        if (!exifInfo || !chk || !chk.checked) return;
        const decor = t.decorConfig || (t.decorConfig = {});
        t.manualExif = Object.assign({}, t.manualExif || {}, {
            brand: exifInfo.make || '', model: exifInfo.model || '',
            focal: exifInfo.focal || '', aperture: exifInfo.aperture || '',
            iso: exifInfo.iso || '', shutter: exifInfo.shutter || ''
        });
        decor.exifAutoText = 1;
    }

    // 相框引擎从 image.exif 读相机型号/参数；把 EXIF 面板和模板里的手改值都同步过去
    function syncImageExif(t, im) {
        if (!im) return;
        const m = (t && t.manualExif) || {};
        const src = exifInfo || {};
        im.exif = {
            make: m.brand || src.make || '',
            model: m.model || src.model || '',
            focal: m.focal || src.focal || '',
            aperture: m.aperture || src.aperture || '',
            iso: m.iso || src.iso || '',
            shutter: m.shutter || src.shutter || '',
            focal35: src.focal35 || 0
        };
    }

    function tempDir() {
        if (window.qfMockHost) return '';
        let dir = '';
        try { dir = cs.getSystemPath(SystemPath.USER_DATA); } catch (_) {}
        return dir ? dir.replace(/[\\/]+$/, '') + '/' : '';
    }

    function tempPath(name) {
        if (window.qfMockHost) return window.qfMockHost.tempPath(name);
        return tempDir() + name;
    }

    // 面板重开时清掉上一轮留下的源图，避免临时目录越积越多
    function cleanupSourceFiles() {
        if (window.qfMockHost) return;
        try {
            const dir = tempDir();
            if (!dir) return;
            const nodeFs = require('fs');
            nodeFs.readdirSync(dir).forEach((name) => {
                if (/^qingframe-source.*\.(jpg|png)$/i.test(name)) {
                    try { nodeFs.unlinkSync(dir + name); } catch (_) { /* 可能被占用 */ }
                }
            });
        } catch (_) { /* 忽略 */ }
    }

    async function loadLayer(path) {
        const img = new Image();
        await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = () => rej(new Error('图层图片解码失败：' + path));
            // CEP 面板已开 --allow-file-access-from-files；直接走 file://，
            // 不再把 69MB 的 PNG 读成 93MB 的 base64（ cep.fs.readFile 会卡住不回调）
            img.src = window.qfMockHost
                ? 'data:image/jpeg;base64,' + (window.qfMockFiles ? window.qfMockFiles[path] : '')
                : 'file:///' + String(path).replace(/\\/g, '/');
        });
        const iw = img.naturalWidth || img.width;
        const ih = img.naturalHeight || img.height;

        // 预览底图：面板显示高度只有 ~170px，700px 已经足够（约 2x DPR），
        // 渲染量只有原来的三分之一，拖滑块明显更跟手。
        const k = Math.min(1, 700 / Math.max(1, iw, ih));
        const pv = document.createElement('canvas');
        pv.width = Math.max(1, Math.round(iw * k));
        pv.height = Math.max(1, Math.round(ih * k));
        pv.getContext('2d').drawImage(img, 0, 0, pv.width, pv.height);
        pv.naturalWidth = pv.width; pv.naturalHeight = pv.height; pv.complete = true;

        const mk = (el, w, h) => ({
            el, name: 'photoshop-layer.png', w, h,
            srcW: iw, srcH: ih, grade: null
        });
        // 全尺寸直接用已解码的 Image：不再复制一张与源图等大的 Canvas（大图约 100MB）。
        return { full: mk(img, iw, ih), preview: mk(pv, pv.width, pv.height) };
    }

    let sourceSeq = 0;
    function nextSourcePath() {
        sourceSeq += 1;
        return tempPath('qingframe-source-' + Date.now().toString(36) + '-' + sourceSeq + '.jpg');
    }

    async function getSource() {
        // 先问宿主拿一个轻量 key（文档路径 + 图层 + 历史步数）。
        // 文档没改动时直接复用已解码的源图，连 PS 侧的复制/合成/存盘都省掉。
        const keyRes = String(await evalScript('qfGetDocKey()'));
        const cachedKey = keyRes.indexOf('OK:') === 0 ? keyRes.slice(3) : '';
        if (cachedKey && sourceCache.key === cachedKey && sourceCache.loaded) {
            return { got: 'OK:' + cachedKey, loaded: sourceCache.loaded, cached: true };
        }

        const src = nextSourcePath();
        const got = await evalScript('qfGetLayerPng(' + JSON.stringify(src) + ')');
        if (String(got).indexOf('ERR') === 0) return { got, loaded: null, cached: false };
        const key = String(got).slice(3) || cachedKey; // 去掉 OK:，与 qfGetDocKey 的 key 同格式
        const loaded = await loadLayer(src);
        if (sourceCache.path && sourceCache.path !== src) removeTemp(sourceCache.path);
        sourceCache = { key, loaded, path: src };
        return { got, loaded, cached: false };
    }

    function removeTemp(path) {
        try {
            if (window.qfMockHost && window.qfMockHost.unlink) window.qfMockHost.unlink(path);
            else require('fs').unlinkSync(path);
        } catch (_) { /* 临时文件删不掉不影响功能 */ }
    }

    function setupApp(image, template, targetPx) {
        const A = window.App;
        A.dom = { canvas };
        A.image = image;
        A.images = [image];
        A.template = template;
        A.selectedEls = [];
        A.displayMax = targetPx;
        A.uiDprOverride = 1;
        A._gesture = false;
        A._forceFitNext = true;
        delete A.exportScale;
        return A;
    }

    function presetAt() {
        const list = window.QF_PRESETS || [];
        const i = Number(presetSel && presetSel.value) || 0;
        const p = list[i] || list[0] || {};
        const t = JSON.parse(JSON.stringify(p));
        t.templateName = p.templateName || p._fileName || '';
        // 多数预设没写 userSignature；引擎只在非空时才画签名，这里补默认值，
        // 与桌面/手机端行为一致。用户在个性签名面板里改过的值优先。
        try {
            const saved = localStorage.getItem('qfs_user_signature');
            // 注意区分「没存过」和「用户主动清空」：空字符串也要尊重
            if (saved != null) t.userSignature = saved;
            else if (!t.userSignature) {
                const style = String(t.photoFrameStyle || '').toUpperCase();
                const defaultOff = ['TICKET_VINTAGE', 'TICKET_SCRAP', 'TICKET_CONCERT',
                    'MOVIE_TICKET', 'BOARDING_PASS'].indexOf(style) >= 0;
                if (!defaultOff) t.userSignature = '清框影';
            }
        } catch (_) { /* 本地存储不可用就用空签名 */ }
        return t;
    }

    async function apply() {
        if (busy) return;
        busy = true;
        clearLog();
        btnBorder.disabled = true;
        btnReset.disabled = true;
        btnBorder.textContent = '处理中…';
        setStatus('正在读取当前文档…', 'busy');
        try {
            const { got, loaded, cached } = await getSource();
            log('导出图层：' + got + (cached ? '（缓存）' : ''));
            if (!loaded) {
                setStatus(String(got).replace(/^ERR:/, '失败：'), 'err');
                return;
            }
            const dm = /OK:(\d+)x(\d+)/.exec(String(got));
            const docW = dm ? Number(dm[1]) : 0;
            const docH = dm ? Number(dm[2]) : 0;

            const image = loaded.full;
            previewSource = loaded.preview;
            log('图层尺寸：' + image.w + '×' + image.h);

            // 换文档后重新识别 EXIF，避免把上一张照片的相机参数写进新图
            const docPath = String(got).split('|')[1] || '';
            const docPathOnly = docPath.split('#')[0]; // key 里可能带文档 id
            if (docPathOnly && docPathOnly !== lastDocPath) {
                await detectExif();
                lastDocPath = docPathOnly; // 未保存文档读不到 EXIF 时也别每次都重试
            }

            const template = presetAt();
            applyExif(template);
            syncImageExif(template, image);
            syncImageExif(template, previewSource);
            liveTemplate = template;
            lastTemplate = template;
            if (window.QF_BorderParams) window.QF_BorderParams.setTemplate(template);
            if (window.QF_TextParams) window.QF_TextParams.setTemplate(template);
            // 让引擎按文档比例出图；否则模板自己的画布比例会让成品和文档对不上
            if (docW && docH) {
                template.canvasRatio = docW + ':' + docH;
                template.__qfDocW = docW; template.__qfDocH = docH;
            }
            log('套用风格：' + (template.templateName || '默认'));

            renderPreviewLive();
            setStatus('正在渲染边框…', 'busy');
            const A = setupApp(image, template, Math.max(docW || image.w, docH || image.h));
            window.__render(A, false);

            // 输出走 JPEG（质量 95）：带边框的成品不需要 alpha，体积比 PNG 小一个量级。
            // 色域转换直接在输出画布上原地做，省掉一张与成品等大的临时 Canvas。
            const csSel = document.getElementById('selColorSpace');
            let cs = (csSel && csSel.value) || 'adobergb';
            if ((cs === 'adobergb' || cs === 'p3') && window.QfsColorSpace) {
                try {
                    const g = canvas.getContext('2d', { willReadFrequently: true });
                    const img = g.getImageData(0, 0, canvas.width, canvas.height);
                    window.QfsColorSpace.convertRgbaInPlace(img.data, cs);
                    g.putImageData(img, 0, 0);
                } catch (e) {
                    log('色域转换失败，按 sRGB 输出：' + ((e && e.message) || e));
                    cs = 'srgb';
                }
            }
            let data = canvas.toDataURL('image/jpeg', 0.95).split(',')[1] || '';
            const profileB64 = cs === 'adobergb' ? window.QF_ICC_ADOBERGB
                : (cs === 'p3' ? window.QF_ICC_P3 : null);
            if (profileB64 && window.QF_IccEmbed) {
                data = window.QF_IccEmbed.embed(data, profileB64);
            }
            if (!data || data.length < 128) throw new Error('渲染结果为空');
            const csOpt = csSel && csSel.options[csSel.selectedIndex];
            log('输出色域：' + (csOpt ? csOpt.text : cs));

            setStatus('正在写回 Photoshop…', 'busy');
            const out = tempPath('qingframe-border.jpg');
            const wr = await writeBase64(out, data);
            const ok = wr === true;
            log('写出结果：' + (ok ? out : ('失败：' + (wr && wr.error || '未知错误'))));
            if (!ok) {
                setStatus('写临时文件失败：' + (wr && wr.error || '未知错误'), 'err');
                return;
            }
            const hideSrc = document.getElementById('chkHideSrc');
            const hide = hideSrc && hideSrc.checked ? 'true' : 'false';
            const smartEl = document.getElementById('chkSmart');
            const smart = smartEl && smartEl.checked ? 'true' : 'false';
            const placed = await evalScript('qfPlacePng(' + JSON.stringify(out) + ','
                + JSON.stringify('清框影边框') + ',' + JSON.stringify(hide) + ','
                + JSON.stringify(smart) + ')');
            log('放回文档：' + placed);
            if (String(placed).indexOf('OK') === 0) {
                setStatus('已放回文档：' + placed, 'ok');
                // 刚加进去的边框图层会改变历史步数。刷新缓存 key，
                // 继续调参数再套用时仍复用同一张原始合成，不会把上一次的边框再套一层。
                try {
                    const fresh = String(await evalScript('qfGetDocKey()'));
                    if (fresh.indexOf('OK:') === 0 && sourceCache.loaded) {
                        sourceCache.key = fresh.slice(3);
                    }
                } catch (_) { /* 刷新失败就下次重新导出 */ }
            } else {
                setStatus('写回失败：' + placed, 'err');
            }
            removeTemp(out); // 结果已经贴进文档，临时 JPEG 不再需要
        } catch (e) {
            const msg = (e && e.message) || e;
            log('失败：' + msg);
            setStatus('失败：' + msg, 'err');
        } finally {
            busy = false;
            btnBorder.disabled = false;
            btnReset.disabled = false;
            btnBorder.textContent = '套用边框 → 新图层';
        }
    }

    async function prepareSource() {
        if (!cs && !window.qfMockHost) return; // 本地回归不在这里预加载
        const { got, loaded } = await getSource();
        if (!loaded) {
            setStatus('请先在 Photoshop 打开文档', '');
            return;
        }
        previewSource = loaded.preview;
        liveTemplate = window.QF_BorderParams ? window.QF_BorderParams.current() : presetAt();
        const dm = /OK:(\d+)x(\d+)/.exec(String(got));
        if (dm && liveTemplate) {
            liveTemplate.__qfDocW = Number(dm[1]);
            liveTemplate.__qfDocH = Number(dm[2]);
        }
        renderPreviewLive();
        setStatus('就绪', 'ok');
    }

    // 缩略图：只渲染可见区域，其余滚动到时再补；结果缓存在 localStorage，
    // 下次打开面板几乎瞬时出图（91 款全渲染在主线程上要几秒）。
    const THUMB_VERSION = 3;
    const THUMB_KEY = 'qfs_thumbs_v' + THUMB_VERSION;
    const thumbCache = [];
    const thumbErrors = [];
    const thumbQueue = [];
    let thumbRunning = false;
    let thumbObserver = null;
    let thumbSaveTimer = 0;
    let thumbSigValue = '';
    let thumbSample = null;

    function presetSignature() {
        const presets = window.QF_PRESETS || [];
        let h = 2166136261;
        for (const p of presets) {
            const s = (p.templateName || '') + '|' + (p.photoFrameStyle || '')
                + '|' + (p._fileName || '');
            for (let i = 0; i < s.length; i++) {
                h ^= s.charCodeAt(i);
                h = Math.imul(h, 16777619);
            }
        }
        return presets.length + '-' + (h >>> 0).toString(36);
    }

    function readThumbCache() {
        try {
            const raw = localStorage.getItem(THUMB_KEY);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (!obj || obj.sig !== thumbSigValue || !Array.isArray(obj.thumbs)) return null;
            if (obj.thumbs.length !== (window.QF_PRESETS || []).length) return null;
            return obj.thumbs;
        } catch (_) { return null; }
    }

    function scheduleThumbSave() {
        clearTimeout(thumbSaveTimer);
        thumbSaveTimer = setTimeout(() => {
            try {
                localStorage.setItem(THUMB_KEY,
                    JSON.stringify({ sig: thumbSigValue, thumbs: thumbCache }));
            } catch (_) { /* 配额不足时放弃缓存，不影响功能 */ }
        }, 1200);
    }

    function makeThumbSample() {
        if (thumbSample) return thumbSample;
        const sample = document.createElement('canvas');
        sample.width = 200; sample.height = 200;
        sample.naturalWidth = 200; sample.naturalHeight = 200; sample.complete = true;
        const g = sample.getContext('2d');
        const gr = g.createLinearGradient(0, 0, 200, 200);
        gr.addColorStop(0, '#d97757'); gr.addColorStop(0.5, '#e7c177'); gr.addColorStop(1, '#3d7a83');
        g.fillStyle = gr; g.fillRect(0, 0, 200, 200);
        g.fillStyle = 'rgba(255,255,255,.7)';
        g.fillRect(40, 40, 40, 40); g.fillRect(110, 80, 28, 28);
        thumbSample = { el: sample, w: 200, h: 200, srcW: 200, srcH: 200, grade: null };
        return thumbSample;
    }

    function renderThumb(i) {
        const presets = window.QF_PRESETS || [];
        const p = presets[i];
        if (!p || thumbCache[i]) return;
        try {
            const t = JSON.parse(JSON.stringify(p));
            t.templateName = p.templateName || p._fileName || '';
            const cv = document.createElement('canvas');
            cv.width = 160; cv.height = 160;
            const A = window.App;
            delete A._canvasBaseW; delete A._canvasBaseH; delete A._canvasScale;
            delete A._fitStyleName; delete A._photoRect;
            A.dom = { canvas: cv };
            const im = makeThumbSample();
            A.image = im; A.images = [im]; A.template = t;
            A.selectedEls = []; A.displayMax = 160; A.uiDprOverride = 1;
            A._gesture = false; A._forceFitNext = true;
            delete A.exportScale;
            window.__render(A, false);
            thumbCache[i] = cv.toDataURL('image/jpeg', 0.6);
        } catch (e) {
            thumbCache[i] = '';
            thumbErrors[i] = String(e && e.stack || e);
        }
        const btn = document.querySelector(`#presetWall [data-wall="${i}"]`);
        if (btn) {
            btn.classList.remove('pending');
            let img = btn.querySelector('img');
            if (thumbCache[i]) {
                if (!img) {
                    img = document.createElement('img');
                    img.alt = '';
                    btn.insertBefore(img, btn.firstChild);
                }
                img.src = thumbCache[i];
            }
        }
        // 部分缓存也有用：下次打开时可见区域先出图，其余滚动到时再补
        scheduleThumbSave();
    }

    function runThumbQueue() {
        if (thumbRunning) return;
        thumbRunning = true;
        const step = () => {
            const i = thumbQueue.shift();
            if (i == null) { thumbRunning = false; return; }
            renderThumb(i);
            setTimeout(step, 0);
        };
        step();
    }

    function queueThumb(i) {
        const presets = window.QF_PRESETS || [];
        if (i < 0 || i >= presets.length || thumbCache[i] || thumbErrors[i]) return;
        if (thumbQueue.indexOf(i) >= 0) return;
        thumbQueue.push(i);
        runThumbQueue();
    }

    function setupThumbObserver(wall) {
        if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
        if (typeof IntersectionObserver !== 'function') {
            (window.QF_PRESETS || []).forEach((_, i) => queueThumb(i));
            return;
        }
        thumbObserver = new IntersectionObserver((entries) => {
            entries.forEach((e) => {
                if (e.isIntersecting) queueThumb(Number(e.target.dataset.wall));
            });
        }, { root: wall, rootMargin: '160px' });
        wall.querySelectorAll('[data-wall]').forEach((b) => thumbObserver.observe(b));
    }

    function syncWallActive() {
        const wall = document.getElementById('presetWall');
        if (!wall || !presetSel) return;
        const cur = String(presetSel.value);
        wall.querySelectorAll('[data-wall]').forEach((b) => {
            b.classList.toggle('active', b.dataset.wall === cur);
        });
        const active = wall.querySelector(`[data-wall="${cur}"]`);
        if (!active || active.hidden) return;
        const wr = wall.getBoundingClientRect();
        const ar = active.getBoundingClientRect();
        if (ar.top < wr.top) wall.scrollTop -= (wr.top - ar.top);
        else if (ar.bottom > wr.bottom) wall.scrollTop += (ar.bottom - wr.bottom);
    }

    function filterWall(q) {
        const wall = document.getElementById('presetWall');
        if (!wall) return;
        const presets = window.QF_PRESETS || [];
        const term = String(q || '').trim().toLowerCase();
        let shown = 0;
        wall.querySelectorAll('[data-wall]').forEach((b) => {
            const hit = !term || (b.dataset.name || '').toLowerCase().indexOf(term) >= 0;
            b.hidden = !hit;
            if (hit) shown++;
        });
        const count = document.getElementById('presetCount');
        if (count) count.textContent = term ? `${shown} / ${presets.length}` : String(presets.length);
        const empty = document.getElementById('wallEmpty');
        if (empty) empty.hidden = shown > 0;
        syncWallActive();
    }

    function paintWall() {
        const wall = document.getElementById('presetWall');
        if (!wall) return;
        const presets = window.QF_PRESETS || [];
        wall.innerHTML = presets.map((p, i) => {
            const name = p.templateName || p._fileName || ('风格 ' + (i + 1));
            const thumb = thumbCache[i];
            return `<button type="button" data-wall="${i}" data-name="${esc(name)}"`
                + ` title="${esc(name)}"${thumb ? '' : ' class="pending"'}>`
                + (thumb ? `<img src="${thumb}" alt="">` : '')
                + `<span>${esc(name)}</span></button>`;
        }).join('');
        if (!wall.dataset.bound) {
            wall.dataset.bound = '1';
            wall.addEventListener('click', (e) => {
                const b = e.target.closest('[data-wall]');
                if (!b || !presetSel) return;
                presetSel.value = b.dataset.wall;
                presetSel.dispatchEvent(new Event('change', { bubbles: true }));
            });
        }
        setupThumbObserver(wall);
        filterWall(presetSearch ? presetSearch.value : '');
    }

    function buildPresetWall() {
        thumbSigValue = presetSignature();
        thumbCache.length = 0;
        thumbErrors.length = 0;
        thumbQueue.length = 0;
        // 清掉旧版本缓存，避免 localStorage 里堆着几份 91 张图
        try {
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const k = localStorage.key(i);
                if (k && k.indexOf('qfs_thumbs_') === 0 && k !== THUMB_KEY) localStorage.removeItem(k);
            }
        } catch (_) { /* 忽略 */ }
        const cached = readThumbCache();
        if (cached) {
            for (let i = 0; i < cached.length; i++) thumbCache[i] = cached[i] || '';
        }
        paintWall();
    }

    function ensureAllThumbs() {
        const presets = window.QF_PRESETS || [];
        for (let i = 0; i < presets.length; i++) queueThumb(i);
        if (!thumbQueue.length && !thumbRunning) return Promise.resolve(true);
        return new Promise((resolve) => {
            const timer = setInterval(() => {
                if (!thumbQueue.length && !thumbRunning) {
                    clearInterval(timer);
                    resolve(true);
                }
            }, 40);
        });
    }

    function resetCurrent() {
        if (busy) return;
        const prev = liveTemplate || {};
        const t = presetAt();
        if (prev.__qfDocW && prev.__qfDocH) {
            t.__qfDocW = prev.__qfDocW;
            t.__qfDocH = prev.__qfDocH;
            t.canvasRatio = prev.canvasRatio;
        }
        applyExif(t);
        syncImageExif(t, previewSource);
        liveTemplate = t;
        lastTemplate = t;
        if (window.QF_BorderParams) window.QF_BorderParams.setTemplate(t);
        if (window.QF_TextParams) window.QF_TextParams.setTemplate(t);
        renderPreviewLive();
        setStatus('已重置为预设默认参数', 'ok');
    }

    function init() {
        const list = window.QF_PRESETS || [];
        if (presetSel) {
            presetSel.innerHTML = list.map((p, i) =>
                `<option value="${i}">${String(p.templateName || p._fileName || ('风格 ' + (i + 1))).replace(/</g, '&lt;')}</option>`
            ).join('');
            // 恢复上次用的风格，省得每次重开都从头翻
            try {
                const saved = Number(localStorage.getItem('qfs_last_preset'));
                if (Number.isFinite(saved) && saved >= 0 && saved < list.length) {
                    presetSel.value = String(saved);
                }
            } catch (_) { /* 忽略 */ }
        }
        if (btnBorder) btnBorder.addEventListener('click', () => apply());
        if (btnReset) btnReset.addEventListener('click', resetCurrent);
        if (presetSearch) presetSearch.addEventListener('input', () => filterWall(presetSearch.value));
        const exifBtn = document.getElementById('btnExifDetect');
        if (exifBtn) exifBtn.addEventListener('click', () => detectExif().catch(() => {}));
        if (presetSel) presetSel.addEventListener('change', () => {
            try { localStorage.setItem('qfs_last_preset', presetSel.value); } catch (_) { /* 忽略 */ }
            const tpl = presetAt();
            if (window.QF_BorderParams) window.QF_BorderParams.setTemplate(tpl);
            if (window.QF_TextParams) window.QF_TextParams.setTemplate(tpl);
            liveTemplate = tpl;
            syncWallActive();
            renderPreviewLive();
        });
        const changed = () => {
            liveTemplate = window.QF_BorderParams ? window.QF_BorderParams.current()
                : (window.QF_TextParams ? window.QF_TextParams.current() : presetAt());
            renderPreviewLive();
        };
        if (window.QF_BorderParams) {
            window.QF_BorderParams.onChange(changed);
            window.QF_BorderParams.setTemplate(presetAt());
        }
        if (window.QF_TextParams) {
            window.QF_TextParams.onChange(changed);
            window.QF_TextParams.setTemplate(window.QF_BorderParams ? window.QF_BorderParams.current() : presetAt());
        }
        // 恢复上次选的个性签名头像（引擎从 window.__qfsAvatarImg 读）
        try {
            const av = localStorage.getItem('qfs_user_avatar');
            if (av) {
                const im = new Image();
                im.onload = () => { window.__qfsAvatarImg = im; renderPreviewLive(); };
                im.src = av;
            }
        } catch (_) { /* 本地存储不可用时忽略 */ }
        cleanupSourceFiles();
        log('就绪；共 ' + list.length + ' 款预设。' + (cs ? '已连接 Photoshop。' : '本机测试模式。'));
        buildPresetWall();
        detectExif().catch(() => {});
        prepareSource().catch(() => {});
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.QF_PS_POC = {
        apply, detectExif, renderPreviewLive, evalScript, readBase64, writeBase64, tempPath, loadLayer,
        lastTemplate: () => lastTemplate,
        buildPresetWall, paintWall, applyDocProfile, thumbErrors,
        ensureAllThumbs, resetCurrent, filterWall,
        searchPresets: (q) => filterWall(q),
        isBusy: () => busy,
        invalidateSource: () => {
            if (sourceCache.path) removeTemp(sourceCache.path);
            sourceCache = { key: '', loaded: null, path: '' };
        }
    };
})();
