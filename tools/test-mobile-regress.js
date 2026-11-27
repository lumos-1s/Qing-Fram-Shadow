'use strict';
// 手机版回归：把这一批抓到的逻辑 bug 逐条钉住，避免以后又改回去。
// 依赖 `npm run mobile:serve`（4173 端口）：RAW 桥是 ES module，file:// 会被 CORS 拦。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
// 测试图来自 strukturag/libheif 的 tests/data/rainbow-451x461.heic（BSD 许可），只用于回归
const heicB64 = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'rainbow-451x461.heic')).toString('base64');
// RAW 样本在 .tmp（不入库）：有就顺手验一次全尺寸重解，没有就跳过这一条
const rawSample = path.join(ROOT, '.tmp', 'rawspike', 'sample.ARW');
const rawTestName = '.tmp-raw-full.ARW';
const rawTestFile = path.join(ROOT, 'mobile', 'www', rawTestName);
if (fs.existsSync(rawSample)) fs.copyFileSync(rawSample, rawTestFile);

const fails = [];
// 控制台报错收集器：注入脚本抛错时，catch 里要能把真实原因打出来
const errors = [];
const check = (ok, label, extra) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) fails.push(label);
};

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 420, height: 860, show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    win.webContents.on('console-message', (_e, level, message) => {
        if (level >= 2 || /未注册的相框风格|render failed|Uncaught/.test(message)) errors.push(message);
    });
    await win.loadURL('http://127.0.0.1:4173/');
    await new Promise((r) => setTimeout(r, 700));

    const r = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const mk = () => {
            const c = document.createElement('canvas'); c.width = 400; c.height = 300;
            const g = c.getContext('2d');
            const gr = g.createLinearGradient(0, 0, 400, 300);
            gr.addColorStop(0, '#d33'); gr.addColorStop(1, '#223');
            g.fillStyle = gr; g.fillRect(0, 0, 400, 300);
            c.naturalWidth = 400; c.naturalHeight = 300; c.complete = true;
            return { el: c, name: 'regress.jpg', w: 400, h: 300, grade: null };
        };
        const cv = document.getElementById('previewCanvas');
        window.qfsNative.pickImages = async () => [mk()];
        document.getElementById('btnPick').click();
        await wait(350);

        // 1) 预设没有 photoFrameStyle 时，不能拿 templateName 去冒充相框风格。
        //    之前「极简细线」等 23 个预设因此被渲染成灰占位图。
        const presets = window.QF_PRESETS || [];
        const idx = presets.findIndex((p) => p.templateName === '极简细线');
        const card = document.querySelector('[data-preset="' + idx + '"]');
        if (card) card.click();
        await wait(300);
        const tplPf = String((window.App.template && window.App.template.photoFrameStyle) || '');
        const presetPf = String(presets[idx].photoFrameStyle || '');
        const styleW = cv.width, styleH = cv.height;

        // 2) 从拼图切回风格页，画布必须重画成当前照片，导出文件名也不能还是「拼图」。
        document.querySelector('[data-tab="puzzle"]').click();
        await wait(400);
        const puzzleW = cv.width;
        document.querySelector('[data-tab="style"]').click();
        await wait(400);
        const backW = cv.width, backH = cv.height;
        let exported = '';
        const origSave = window.qfsNative.saveImage;
        window.qfsNative.saveImage = async (d, n) => { exported = n; return { ok: true, mode: 'test' }; };
        document.getElementById('btnExport').click();
        await wait(350);
        window.qfsNative.saveImage = origSave;

        // 3) 切图要切「加了风格/调色」的成品画布，且 9 块文件名不能互相覆盖。
        const saved = [];
        window.qfsNative.saveImage = async (d, n) => {
            const dims = await new Promise((res) => {
                const im = new Image();
                im.onload = () => res(im.naturalWidth + 'x' + im.naturalHeight);
                im.onerror = () => res('bad');
                im.src = d;
            });
            saved.push({ n, dims });
            return { ok: true };
        };
        document.querySelector('[data-tab="crop"]').click();
        await wait(400);
        document.getElementById('btnExport').click();
        await wait(1600);
        window.qfsNative.saveImage = origSave;

        // 4) 调色页切走再切回：直方图必须画在新面板的画布上，而且统计的是调色后像素。
        document.querySelector('[data-tab="grade"]').click();
        await wait(350);
        const exp = document.querySelector('[data-grade="exp"]');
        exp.value = '1.5';
        exp.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(450);
        document.querySelector('[data-tab="style"]').click();
        await wait(300);
        document.querySelector('[data-tab="grade"]').click();
        await wait(450);
        const histo = document.getElementById('gradeHisto');
        const hd = histo.getContext('2d').getImageData(0, 0, histo.width, histo.height).data;
        let hsum = 0;
        for (let i = 3; i < hd.length; i += 4) hsum += hd[i];
        // 后面还会再导入一张图并重绘面板，这里必须当场取样，不能等到 return 时再读
        const histoConnected = histo.isConnected;
        const gradeExp = Number((window.App.image.grade && window.App.image.grade.exp) || 0);

        // 5) libraw-wasm 的 3 通道像素不能再按 w*h*4 取（之前 100% 抛 RangeError）。
        let rawErr = '';
        let rawPx = [];
        try {
            const rawCv = window.qfRawRgbToCanvas(new Uint8Array([255, 0, 0, 0, 255, 0]), 2, 1);
            rawPx = Array.from(rawCv.getContext('2d').getImageData(0, 0, 2, 1).data);
        } catch (e) { rawErr = String(e && e.message || e); }

        // 8) HEIC 系统解不了时，libheif(WASM) 兜底必须真能解出像素
        let heic = {}, heicErr = '', heicBytes = null, heicFull = {}, heicFullErr = '';
        try {
            const bin = atob(${JSON.stringify(heicB64)});
            heicBytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) heicBytes[i] = bin.charCodeAt(i);
            const cv = await window.qfHeicDecode(heicBytes);
            heic = {
                w: cv.width, h: cv.height,
                px: Array.from(cv.getContext('2d').getImageData(0, 0, 1, 1).data)
            };
            cv.width = 0; cv.height = 0;
        } catch (e) { heicErr = String(e && e.message || e); }

        try {
            const small = document.createElement('canvas');
            small.width = 160; small.height = 160;
            small.naturalWidth = 160; small.naturalHeight = 160; small.complete = true;
            const file = new File([heicBytes], 'sample.heic', { type: 'image/heic' });
            const src = await window.qfFullSource({
                el: small, name: 'sample.heic', w: 160, h: 160,
                srcW: 451, srcH: 461, heic: true, grade: null, file
            });
            heicFull = { w: src.canvas.width, h: src.canvas.height, changed: src.changed };
            src.release();
        } catch (e) { heicFullErr = String(e && e.message || e); }

        // 9) 导出必须按原图尺寸，不能把 3000×2000 的图停在 1600px 预览
        let fullExport = {}, fullExportErr = '';
        try {
            const big = document.createElement('canvas');
            big.width = 3000; big.height = 2000;
            const bg = big.getContext('2d');
            bg.fillStyle = '#345'; bg.fillRect(0, 0, 3000, 2000);
            bg.fillStyle = '#fff'; bg.fillRect(100, 100, 800, 800);
            const blob = await new Promise((res) => big.toBlob(res, 'image/jpeg', 0.9));
            const file = new File([blob], 'full.jpg', { type: 'image/jpeg' });
            const pv = document.createElement('canvas');
            pv.width = 1600; pv.height = 1067;
            pv.getContext('2d').drawImage(big, 0, 0, 1600, 1067);
            pv.naturalWidth = 1600; pv.naturalHeight = 1067; pv.complete = true;
            window.qfsNative.pickImages = async () => [{
                el: pv, name: 'full.jpg', w: 1600, h: 1067,
                srcW: 3000, srcH: 2000, grade: null, file
            }];
            document.getElementById('btnPick').click();
            await wait(600);
            let dims = '', name = '';
            const save0 = window.qfsNative.saveImage;
            window.qfsNative.saveImage = async (d, n) => {
                name = n;
                dims = await new Promise((res) => {
                    const im = new Image();
                    im.onload = () => res(im.naturalWidth + 'x' + im.naturalHeight);
                    im.onerror = () => res('bad');
                    im.src = d;
                });
                return { ok: true, mode: 'test' };
            };
            document.getElementById('btnExport').click();
            await wait(4500);
            window.qfsNative.saveImage = save0;
            fullExport = {
                dims, name,
                after: document.getElementById('previewCanvas').width,
                exportScale: window.App.exportScale
            };
        } catch (e) { fullExportErr = String(e && e.message || e); }

        // 10) 拼图导出走 4000px 版式，不能停在 1600px 预览
        let puzzleExport = {}, puzzleExportErr = '';
        try {
            document.querySelector('[data-tab="puzzle"]').click();
            await wait(450);
            let pdims = '';
            const save1 = window.qfsNative.saveImage;
            window.qfsNative.saveImage = async (d) => {
                pdims = await new Promise((res) => {
                    const im = new Image();
                    im.onload = () => res(im.naturalWidth + 'x' + im.naturalHeight);
                    im.onerror = () => res('bad');
                    im.src = d;
                });
                return { ok: true, mode: 'test' };
            };
            document.getElementById('btnExport').click();
            await wait(2500);
            window.qfsNative.saveImage = save1;
            puzzleExport = {
                dims: pdims,
                after: document.getElementById('previewCanvas').width,
                exportScale: window.App.exportScale
            };
        } catch (e) { puzzleExportErr = String(e && e.message || e); }

        // 11) 切图从全尺寸成品上切，而不是 1600px 预览块
        let cropFull = {}, cropFullErr = '';
        try {
            document.querySelector('[data-tab="crop"]').click();
            await wait(550);
            const dims = [];
            const save2 = window.qfsNative.saveImage;
            window.qfsNative.saveImage = async (d) => {
                dims.push(await new Promise((res) => {
                    const im = new Image();
                    im.onload = () => res(im.naturalWidth + 'x' + im.naturalHeight);
                    im.onerror = () => res('bad');
                    im.src = d;
                }));
                return { ok: true };
            };
            document.getElementById('btnExport').click();
            await wait(3500);
            window.qfsNative.saveImage = save2;
            cropFull = { dims: dims.slice(0, 2), count: dims.length };
        } catch (e) { cropFullErr = String(e && e.message || e); }

        // 12) 编辑 › 边框页：控件能改到模板，且状态条跟着切换
        let edit = {}, editErr = '';
        try {
            document.querySelector('[data-tab="edit"]').click();
            await wait(450);
            edit = {
                tabs: document.querySelectorAll('#tabs .tab[data-tab]').length,
                subs: document.querySelectorAll('[data-edit-sub]').length,
                ctls: document.querySelectorAll('[data-ctl]').length,
                stageName: document.getElementById('hdrName').textContent,
                stageMeta: document.getElementById('hdrMeta').textContent
            };
            const setByLabel = (label, value) => {
                const row = Array.from(document.querySelectorAll('.ctl-row')).find((x) => {
                    const l = x.querySelector('label');
                    return l && l.textContent === label;
                });
                const el = row && row.querySelector('[data-ctl]');
                if (!el) return false;
                el.value = String(value);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            };
            edit.changedStroke = setByLabel('描边宽度', 40);
            edit.changedFill = setByLabel('填充颜色', '#00ff00');
            await wait(350);
            const layer = (window.App.template.layerList || [])[0] || {};
            edit.stroke = (layer.strokeConfig || {}).strokeWidth;
            edit.fill = (layer.fillConfig || {}).fillHex;
            document.querySelector('[data-edit-sub="text"]').click();
            await wait(200);
            edit.textCtls = document.querySelectorAll('[data-ctl]').length;
            document.querySelector('[data-tab="crop"]').click();
            await wait(250);
        } catch (e) { editErr = String(e && e.message || e); }

        // 13) 编辑 › 文字：自由文字/署名/EXIF 都能写回模板
        let text = {}, textErr = '';
        try {
            document.querySelector('[data-tab="edit"]').click();
            await wait(300);
            document.querySelector('[data-edit-sub="text"]').click();
            await wait(300);
            const byLabel = (label) => {
                const row = Array.from(document.querySelectorAll('.ctl-row')).find((x) => {
                    const l = x.querySelector('label');
                    return l && l.textContent === label;
                });
                return row && row.querySelector('[data-ctl]');
            };
            text.baseline = (window.App.template.decorConfig.textLines || []).length;
            document.getElementById('btnAddText').click();
            await wait(250);
            text.lines = (window.App.template.decorConfig.textLines || []).length;
            const content = byLabel('内容');
            if (content) { content.value = '回归文字'; content.dispatchEvent(new Event('input', { bubbles: true })); }
            const size = byLabel('字号');
            if (size) { size.value = '80'; size.dispatchEvent(new Event('input', { bubbles: true })); }
            const sig = byLabel('署名内容');
            text.hasSigRow = !!sig;
            if (sig) { sig.value = '回归署名'; sig.dispatchEvent(new Event('input', { bubbles: true })); }
            const exif = byLabel('EXIF 参数条');
            if (exif) { exif.checked = true; exif.dispatchEvent(new Event('change', { bubbles: true })); }
            await wait(400);
            const lines2 = window.App.template.decorConfig.textLines || [];
            const line = lines2[lines2.length - 1] || {};
            text.text = line.text;
            text.fontSize = line.fontSize;
            text.signature = window.App.template.userSignature;
            text.exifAutoText = window.App.template.decorConfig.exifAutoText;
            document.getElementById('btnDeleteText') && document.getElementById('btnDeleteText').click();
            await wait(250);
            text.afterDelete = (window.App.template.decorConfig.textLines || []).length;
            document.querySelector('[data-tab="crop"]').click();
            await wait(200);
        } catch (e) { textErr = String(e && e.message || e); }

        // 14) 编辑 › 元素：文字 Logo / 贴纸 / 复制删除清空
        let el = {}, elErr = '';
        try {
            document.querySelector('[data-tab="edit"]').click();
            await wait(300);
            document.querySelector('[data-edit-sub="element"]').click();
            await wait(300);
            const draft = document.querySelector('[data-draft-logo]');
            if (draft) { draft.value = '回归LOGO'; draft.dispatchEvent(new Event('input', { bubbles: true })); }
            el.baseline = (window.App.template.logoElements || []).length;
            document.getElementById('btnAddTextLogo').click();
            await wait(250);
            el.logos = (window.App.template.logoElements || []).length;
            el.name = ((window.App.template.logoElements || [])[el.logos - 1] || {}).name;
            const byLabel = (label) => {
                const row = Array.from(document.querySelectorAll('.ctl-row')).find((x) => {
                    const l = x.querySelector('label'); return l && l.textContent === label;
                });
                return row && row.querySelector('[data-ctl]');
            };
            const size = byLabel('大小');
            if (size) { size.value = '300'; size.dispatchEvent(new Event('input', { bubbles: true })); }
            const opacity = byLabel('透明度');
            if (opacity) { opacity.value = '60'; opacity.dispatchEvent(new Event('input', { bubbles: true })); }
            await wait(250);
            el.size = ((window.App.template.logoElements || [])[el.logos - 1] || {}).size;
            el.opacity = ((window.App.template.logoElements || [])[el.logos - 1] || {}).opacity;
            document.getElementById('btnAddSticker').click();
            await wait(200);
            el.stickers = ((window.App.template.decorConfig || {}).stickers || []).length;
            document.getElementById('btnClearEls').click();
            await wait(200);
            el.afterClear = ((window.App.template.logoElements || []).length)
                + (((window.App.template.decorConfig || {}).stickers || []).length);
            document.querySelector('[data-tab="crop"]').click();
            await wait(200);
        } catch (e) { elErr = String(e && e.message || e); }

        // 15) 编辑 › 样式：保存/载入/导出配置/分享码往返
        let tpl = {}, tplErr = '';
        try {
            document.querySelector('[data-tab="edit"]').click();
            await wait(300);
            document.querySelector('[data-edit-sub="style"]').click();
            await wait(300);
            const name = document.querySelector('[data-tpl-name]');
            if (name) { name.value = '回归模板'; name.dispatchEvent(new Event('input', { bubbles: true })); }
            document.getElementById('btnTplSave').click();
            await wait(300);
            tpl.saved = (await window.qfsNative.listTemplates()).indexOf('回归模板') >= 0;
            tpl.savedChips = document.querySelectorAll('[data-load-template]').length;

            let exported = '';
            const saveText0 = window.qfsNative.saveText;
            window.qfsNative.saveText = async (text) => { exported = text; return { ok: true, mode: 'test' }; };
            document.getElementById('btnTplExport').click();
            await wait(250);
            window.qfsNative.saveText = saveText0;
            tpl.kind = (() => { try { return JSON.parse(exported).kind; } catch (e) { return 'bad'; } })();

            const clone = JSON.parse(JSON.stringify(window.App.template));
            clone.templateName = '码导入';
            clone.baseMargin = clone.baseMargin || {};
            clone.baseMargin.globalMargin = 1.7;
            const json = JSON.stringify({ v: 1, kind: 'qfs-config', app: 'qingframe-web', name: '码导入', template: clone });
            const bytes = new TextEncoder().encode(json);
            let bin = '';
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            const ta = document.querySelector('[data-share-input]');
            ta.value = 'QFSCFG1:' + btoa(bin);
            tpl.codeLen = ta.value.length;
            document.getElementById('btnTplPaste').click();
            await wait(350);
            tpl.hint = document.getElementById('toast').textContent;
            tpl.importedName = window.App.template.templateName;
            tpl.importedMargin = (window.App.template.baseMargin || {}).globalMargin;

            const chip = document.querySelector('[data-load-template="回归模板"]');
            if (chip) chip.click();
            await wait(300);
            tpl.loadedName = window.App.template.templateName;
            document.querySelector('[data-tab="crop"]').click();
            await wait(200);
        } catch (e) { tplErr = String(e && e.message || e); }

        // 16) 画布点选 / 拖动元素
        let drag = {}, dragErr = '';
        try {
            document.querySelector('[data-tab="edit"]').click();
            await wait(250);
            document.querySelector('[data-edit-sub="element"]').click();
            await wait(250);
            const draft = document.querySelector('[data-draft-logo]');
            draft.value = '拖动回归';
            draft.dispatchEvent(new Event('input', { bubbles: true }));
            document.getElementById('btnAddTextLogo').click();
            await wait(250);
            const logo = (window.App.template.logoElements || [])[0];
            drag.before = { x: logo.x, y: logo.y };
            document.querySelector('[data-tab="style"]').click();
            await wait(300);
            const cv = document.getElementById('previewCanvas');
            const rect = cv.getBoundingClientRect();
            const at = (cx, cy) => ({
                clientX: rect.left + cx / cv.width * rect.width,
                clientY: rect.top + cy / cv.height * rect.height,
                pointerId: 1, bubbles: true
            });
            cv.dispatchEvent(new PointerEvent('pointerdown', at(logo.x, logo.y)));
            await wait(200);
            drag.tab = document.querySelector('#tabs .tab.active').dataset.tab;
            drag.activeChip = (document.querySelector('[data-el-key].active') || {}).dataset
                ? document.querySelector('[data-el-key].active').dataset.elKey : '';
            cv.dispatchEvent(new PointerEvent('pointermove', at(logo.x + 80, logo.y + 50)));
            await wait(300);
            cv.dispatchEvent(new PointerEvent('pointerup', at(logo.x + 80, logo.y + 50)));
            drag.after = { x: logo.x, y: logo.y };
            document.querySelector('[data-tab="crop"]').click();
            await wait(200);
        } catch (e) { dragErr = String(e && e.message || e); }

        // 17) 画布旋转 / 缩放手柄
        let handle = {}, handleErr = '';
        try {
            const logo = (window.App.template.logoElements || [])[0];
            document.querySelector('[data-tab="style"]').click();
            await wait(300);
            const cv = document.getElementById('previewCanvas');
            const rect = cv.getBoundingClientRect();
            const at = (x, y) => ({
                clientX: rect.left + x / cv.width * rect.width,
                clientY: rect.top + y / cv.height * rect.height,
                pointerId: 1, bubbles: true
            });
            cv.dispatchEvent(new PointerEvent('pointerdown', at(logo.x, logo.y)));
            cv.dispatchEvent(new PointerEvent('pointerup', at(logo.x, logo.y)));
            await wait(200);
            const size = logo.size, h = size * 0.3, cx = logo.x, cy = logo.y;
            cv.dispatchEvent(new PointerEvent('pointerdown', at(cx, cy - h / 2 - 28)));
            cv.dispatchEvent(new PointerEvent('pointermove', at(cx + 100, cy)));
            cv.dispatchEvent(new PointerEvent('pointerup', at(cx + 100, cy)));
            await wait(200);
            handle.rotation = logo.rotation;
            const cornerX = cx + size / 2, cornerY = cy + h / 2;
            cv.dispatchEvent(new PointerEvent('pointerdown', at(cornerX, cornerY)));
            cv.dispatchEvent(new PointerEvent('pointermove', at(cx + (cornerX - cx) * 1.5, cy + (cornerY - cy) * 1.5)));
            cv.dispatchEvent(new PointerEvent('pointerup', at(cx + (cornerX - cx) * 1.5, cy + (cornerY - cy) * 1.5)));
            await wait(200);
            handle.size = logo.size;
            handle.origSize = size;
            document.querySelector('[data-tab="crop"]').click();
            await wait(200);
        } catch (e) { handleErr = String(e && e.message || e); }

        // 18) 双击文字就地编辑
        let dbl = {}, dblErr = '';
        try {
            document.querySelector('[data-tab="edit"]').click();
            await wait(250);
            document.querySelector('[data-edit-sub="text"]').click();
            await wait(250);
            document.getElementById('btnAddText').click();
            await wait(250);
            const lines = ((window.App.template.decorConfig || {}).textLines || []).filter((l) => l.align === 'free');
            const line = lines[lines.length - 1];
            line.text = '双击前'; line.fontSize = 80; line.x = 600; line.y = 800;
            document.querySelector('[data-tab="style"]').click();
            await wait(300);
            const cv = document.getElementById('previewCanvas');
            const baseW = window.App._canvasBaseW || cv.width;
            const scl = cv.width / Math.max(1, baseW);
            const m = window.textLineMetrics(line, cv.width, cv.height, false, 0, 0, scl);
            const rect = cv.getBoundingClientRect();
            const at = (x, y) => ({
                clientX: rect.left + x / cv.width * rect.width,
                clientY: rect.top + y / cv.height * rect.height,
                pointerId: 1, bubbles: true
            });
            const cx = m.x + m.w / 2, cy = m.y + m.h / 2;
            cv.dispatchEvent(new PointerEvent('pointerdown', at(cx, cy)));
            cv.dispatchEvent(new PointerEvent('pointerup', at(cx, cy)));
            await wait(120);
            cv.dispatchEvent(new PointerEvent('pointerdown', at(cx, cy)));
            cv.dispatchEvent(new PointerEvent('pointerup', at(cx, cy)));
            await wait(200);
            const ed = document.getElementById('textEditor');
            dbl.opened = !ed.hidden;
            dbl.value = ed.value;
            ed.value = '双击后';
            ed.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(150);
            dbl.live = line.text;
            ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await wait(200);
            dbl.closed = ed.hidden;
            dbl.after = line.text;
            document.querySelector('[data-tab="crop"]').click();
            await wait(200);
        } catch (e) { dblErr = String(e && e.message || e); }

        // 19) 双指缩放预览 + 双击空白复位
        let pinch = {}, pinchErr = '';
        try {
            document.querySelector('[data-tab="style"]').click();
            await wait(300);
            const cv = document.getElementById('previewCanvas');
            const rect = cv.getBoundingClientRect();
            const at = (x, y, id) => ({
                clientX: rect.left + x, clientY: rect.top + y,
                pointerId: id, bubbles: true
            });
            cv.dispatchEvent(new PointerEvent('pointerdown', at(20, 20, 1)));
            cv.dispatchEvent(new PointerEvent('pointerdown', at(80, 20, 2)));
            await wait(80);
            cv.dispatchEvent(new PointerEvent('pointermove', at(0, 20, 1)));
            cv.dispatchEvent(new PointerEvent('pointermove', at(100, 20, 2)));
            await wait(180);
            pinch.during = cv.style.transform;
            const s = cv.style.transform;
            const i = s.indexOf('scale(');
            pinch.zoom = i >= 0 ? parseFloat(s.slice(i + 6)) : 0;
            cv.dispatchEvent(new PointerEvent('pointerup', at(0, 20, 1)));
            cv.dispatchEvent(new PointerEvent('pointerup', at(100, 20, 2)));
            await wait(120);
            const empty = at(8, 8, 3);
            cv.dispatchEvent(new PointerEvent('pointerdown', empty));
            cv.dispatchEvent(new PointerEvent('pointerup', empty));
            await wait(80);
            cv.dispatchEvent(new PointerEvent('pointerdown', empty));
            cv.dispatchEvent(new PointerEvent('pointerup', empty));
            await wait(180);
            pinch.reset = cv.style.transform;
        } catch (e) { pinchErr = String(e && e.message || e); }

        // 20) EXIF 自动识别：JPEG 的拍摄参数写进 image.exif
        const parse0 = window.__parseExif;
        let exif = {}, exifErr = '';
        try {
            window.__parseExif = () => ({
                0x010F: 'SONY', 0x0110: 'ILCE-6000', 0x0112: 1,
                0x829A: { num: 1, den: 125 }, 0x829D: { num: 56, den: 10 },
                0x8827: 100, 0x920A: { num: 35, den: 1 }, 0xA405: 52
            });
            const cc = document.createElement('canvas');
            cc.width = 16; cc.height = 16;
            const blob = await new Promise((res) => cc.toBlob(res, 'image/jpeg', 0.8));
            const dec = await window.qfsNative.decodeStill(new File([blob], 'exif.jpg', { type: 'image/jpeg' }));
            exif = dec.exif || {};
        } catch (e) { exifErr = String(e && e.message || e); }
        finally { window.__parseExif = parse0; }

        // 21) 元素多选 / 对齐 / 层级
        let multi = {}, multiErr = '';
        try {
            document.querySelector('[data-tab="edit"]').click();
            await wait(250);
            document.querySelector('[data-edit-sub="element"]').click();
            await wait(250);
            document.getElementById('btnClearEls').click();
            await wait(200);
            const draft = document.querySelector('[data-draft-logo]');
            for (const txt of ['A', 'B']) {
                draft.value = txt;
                draft.dispatchEvent(new Event('input', { bubbles: true }));
                document.getElementById('btnAddTextLogo').click();
                await wait(200);
            }
            const logos = window.App.template.logoElements || [];
            multi.count = logos.length;
            document.querySelector('[data-el-key="logo:0"]').click();
            await wait(200);
            document.getElementById('btnMultiEl').click();
            await wait(200);
            document.querySelector('[data-el-key="logo:1"]').click();
            await wait(200);
            multi.selected = window.QF_EditPanel.getSelectedKeys().length;
            multi.hasAlign = !!document.querySelector('[data-align="left"]');
            const z0 = Number(logos[0].z || 0);
            document.querySelector('[data-align="left"]').click();
            await wait(250);
            multi.aligned = Math.abs((logos[0].x || 0) - (logos[1].x || 0)) <= 2;
            document.getElementById('btnZUp').click();
            await wait(250);
            multi.zAfter = logos[0].z;
            multi.zBefore = z0;
            document.getElementById('btnDeleteEl').click();
            await wait(250);
            multi.afterDelete = (window.App.template.logoElements || []).length;
            document.querySelector('[data-tab="crop"]').click();
            await wait(200);
        } catch (e) { multiErr = String(e && e.message || e); }

        // 22) 预设文字字号跟随照片大小
        let autofs = {}, autofsErr = '';
        try {
            const importSize = async (size, proxy) => {
                const elSize = proxy || size;
                const c = document.createElement('canvas');
                c.width = elSize; c.height = elSize;
                c.naturalWidth = elSize; c.naturalHeight = elSize; c.complete = true;
                window.qfsNative.pickImages = async () => [{
                    el: c, name: 'auto' + size + '.jpg', w: elSize, h: elSize,
                    srcW: size, srcH: size, grade: null, file: null
                }];
                document.getElementById('btnPick').click();
                await wait(350);
                const card = document.querySelector('[data-preset="1"]');
                if (card) card.click();
                await wait(350);
                const t = window.App.template;
                const line = (t.decorConfig.textLines || [])[0];
                return { fs: line && line.fontSize, pf: t.paramFontSize };
            };
            autofs.small = await importSize(1000);
            autofs.large = await importSize(4000);
            // 手机真实链路：原图 4000、预览代理 1600。字号必须按 1600/4000 缩回，
            // 否则预览里的字比成片大 2.5 倍（用户看到的「预览字巨大、导出变小」）。
            autofs.proxy = await importSize(4000, 1600);

            // 布局同一条链路：NOMO 的胶片边是绝对像素（baseMargin.marginTop=64），
            // 预览代理渲染时必须折成 64×0.4；导出（el=原图）保持 64。
            const importNamed = async (name, size, proxy) => {
                const elSize = proxy || size;
                const c = document.createElement('canvas');
                c.width = elSize; c.height = elSize;
                c.naturalWidth = elSize; c.naturalHeight = elSize; c.complete = true;
                window.qfsNative.pickImages = async () => [{
                    el: c, name: 'lay' + size + '.jpg', w: elSize, h: elSize,
                    srcW: size, srcH: size, grade: null, file: null
                }];
                document.getElementById('btnPick').click();
                await wait(350);
                const idx = (window.QF_PRESETS || []).findIndex(p => (p.templateName || p._fileName) === name);
                const card = idx >= 0 ? document.querySelector('[data-preset="' + idx + '"]') : null;
                if (card) card.click();
                await wait(350);
                // 渲染用的「代理尺度模板」是临时副本，从公开入口取，别读被还原过的 App.template
                const t = (typeof window.qfScaledTemplate === 'function')
                    ? window.qfScaledTemplate(window.App.template, window.App.image)
                    : window.App.template;
                return { marginTop: t.baseMargin && t.baseMargin.marginTop, baseW: window.App._canvasBaseW, k: window.qfProxyRatio(window.App.image) };
            };
            autofs.layoutFull = await importNamed('NOMO复古相机', 4000);
            autofs.layoutProxy = await importNamed('NOMO复古相机', 4000, 1600);
            document.querySelector('[data-tab="crop"]').click();
            await wait(150);
        } catch (e) { autofsErr = String(e && e.message || e); }

        // 23) 三页布局：首页风格墙 / 编辑页 / 我的 + 胶囊导航
        let layout = {}, layoutErr = '';
        try {
            document.querySelector('#tabbar [data-page="home"]').click();
            await wait(300);
            layout.home = {
                page: document.getElementById('app').dataset.page,
                sections: document.querySelectorAll('.home-section').length,
                cards: document.querySelectorAll('.home-card').length,
                nav: document.querySelectorAll('#tabbar .nav-item').length,
                hero: !!document.getElementById('homeHero')
            };
            const homeSearch = document.getElementById('homeQuery');
            homeSearch.value = '拍立得';
            homeSearch.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(260);
            layout.searchCards = document.querySelectorAll('.home-card').length;
            homeSearch.value = '';
            homeSearch.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(260);

            const first = document.querySelector('.home-card[data-home-preset]');
            const wantIdx = first ? Number(first.dataset.homePreset) : -1;
            if (first) first.click();
            await wait(700);
            layout.afterCard = {
                page: document.getElementById('app').dataset.page,
                title: document.getElementById('hdrName').textContent,
                template: String(window.App.template.templateName || ''),
                wantIdx
            };
            document.querySelector('#tabbar [data-page="mine"]').click();
            await wait(360);
            layout.mine = {
                page: document.getElementById('app').dataset.page,
                rows: document.querySelectorAll('.mine-row').length,
                platform: document.getElementById('minePlatform').textContent
            };
            document.querySelector('#tabbar [data-page="edit"]').click();
            await wait(360);
            layout.backEdit = {
                page: document.getElementById('app').dataset.page,
                exportBtn: !!document.querySelector('#mHeader #btnExport'),
                navHidden: getComputedStyle(document.getElementById('tabbar')).display === 'none'
            };
        } catch (e) { layoutErr = String(e && e.message || e); }

        // 23.5) 撤销 / 重做、导出选项、长按对比原图
        let extras = {}, extrasErr = '';
        try {
            document.querySelector('[data-tab="style"]').click();
            await wait(200);
            const beforeName = String(window.App.template.templateName || '');
            const card = document.querySelector('[data-preset="2"]');
            if (card) card.click();
            await wait(320);
            const applied = String(window.App.template.templateName || '');
            document.getElementById('btnUndo').click();
            await wait(320);
            const undone = String(window.App.template.templateName || '');
            document.getElementById('btnRedo').click();
            await wait(320);
            extras.undo = {
                beforeName, applied, undone,
                redone: String(window.App.template.templateName || ''),
                canUndo: !document.getElementById('btnUndo').disabled
            };

            // 长按导出 = 选项弹层；改档位后记住，再恢复默认，免得污染后续导出用例
            const ex = document.getElementById('btnExport');
            ex.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 11, button: 0 }));
            await wait(620);
            extras.exportOpened = !document.getElementById('exportSheet').hidden;
            document.querySelector('#optSize [data-size="2000"]').click();
            document.querySelector('#optFormat [data-format="png"]').click();
            extras.exportHint = (document.getElementById('exportHint').textContent || '');
            extras.exportStored = localStorage.getItem('qfm_export') || '';
            document.querySelector('#optSize [data-size="0"]').click();
            document.querySelector('#optFormat [data-format="jpeg"]').click();
            document.querySelector('#optQuality [data-quality="0.92"]').click();
            document.getElementById('btnExportCancel').click();
            await wait(120);
            extras.exportClosed = document.getElementById('exportSheet').hidden;

            // 长按画布 = 看原图（状态位由 mobile.js 暴露）
            const cv = document.getElementById('previewCanvas');
            const r = cv.getBoundingClientRect();
            const opts2 = { bubbles: true, pointerId: 12, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
            cv.dispatchEvent(new PointerEvent('pointerdown', opts2));
            await wait(560);
            extras.compareOn = !!window.qfCompareActive;
            cv.dispatchEvent(new PointerEvent('pointerup', opts2));
            await wait(200);
            extras.compareOff = !window.qfCompareActive;
        } catch (e) { extrasErr = String(e && e.message || e); }

        // 23.6) 导出选项真的落到成品：1080 长边 + PNG
        let exportOpt = {}, exportOptErr = '';
        try {
            const ex = document.getElementById('btnExport');
            ex.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 13, button: 0 }));
            await wait(620);
            document.querySelector('#optSize [data-size="1080"]').click();
            document.querySelector('#optFormat [data-format="png"]').click();
            let saved = null;
            const orig = window.qfsNative.saveImage;
            window.qfsNative.saveImage = async (d, n) => { saved = { d, n }; return { ok: true, mode: 'download' }; };
            document.getElementById('btnExportGo').click();
            for (let i = 0; i < 120 && !saved; i++) await wait(150);
            window.qfsNative.saveImage = orig;
            const d = (saved && saved.d) || '';
            const b64 = d.split(',')[1] || '';
            const bin = atob(b64.slice(0, 48));
            const pngW = ((bin.charCodeAt(16) << 24) | (bin.charCodeAt(17) << 16)
                | (bin.charCodeAt(18) << 8) | bin.charCodeAt(19)) >>> 0;
            const pngH = ((bin.charCodeAt(20) << 24) | (bin.charCodeAt(21) << 16)
                | (bin.charCodeAt(22) << 8) | bin.charCodeAt(23)) >>> 0;
            exportOpt = { mime: d.slice(0, 15), name: saved && saved.n, pngW, pngH, len: d.length };
            // 还原默认，别把 1080/PNG 留给下一次运行
            ex.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 14, button: 0 }));
            await wait(620);
            document.querySelector('#optSize [data-size="0"]').click();
            document.querySelector('#optFormat [data-format="jpeg"]').click();
            document.querySelector('#optQuality [data-quality="0.92"]').click();
            document.getElementById('btnExportCancel').click();
            await wait(200);
        } catch (e) { exportOptErr = String(e && e.message || e); }

        // 24) 桌面功能同步第一批：自动调色 / 效果 / 拼图选项 / 切图自定义 / 背景模糊
        let sync1 = {}, sync1Err = '';
        try {
            document.querySelector('[data-tab="grade"]').click();
            await wait(300);
            sync1.autoBtn = !!document.getElementById('btnGradeAuto');
            sync1.fx = Array.from(document.querySelectorAll('.ctl-group > summary')).some((s) => s.textContent.trim() === '效果');
            const before = JSON.stringify(window.App.image.grade || {});
            if (sync1.autoBtn) document.getElementById('btnGradeAuto').click();
            await wait(400);
            sync1.gradeChanged = JSON.stringify(window.App.image.grade || {}) !== before;
            const row = Array.from(document.querySelectorAll('.ctl-row')).find((x) => {
                const l = x.querySelector('label'); return l && l.textContent === '暗角强度';
            });
            const vg = row && row.querySelector('[data-ctl]');
            if (vg) { vg.value = '60'; vg.dispatchEvent(new Event('input', { bubbles: true })); }
            await wait(200);
            sync1.vignette = (window.App.template.lightEffect || {}).vignetteStrength;

            document.querySelector('[data-tab="puzzle"]').click();
            await wait(250);
            const gap = document.querySelector('[data-puzzle-opt="gap"]');
            if (gap) { gap.value = '18'; gap.dispatchEvent(new Event('input', { bubbles: true })); }
            await wait(250);
            sync1.gap = (window.App.template.puzzle || {}).gap;

            document.querySelector('[data-tab="crop"]').click();
            await wait(250);
            const rows = document.getElementById('cropRows');
            if (rows) { rows.value = '2'; rows.dispatchEvent(new Event('change', { bubbles: true })); }
            await wait(300);
            sync1.cropCells = document.querySelectorAll('[data-block]').length;

            document.querySelector('[data-tab="style"]').click();
            await wait(200);
            const blurCard = document.querySelector('[data-preset="78"]');
            if (blurCard) { blurCard.click(); await wait(300); }
            document.querySelector('[data-tab="edit"]').click();
            await wait(250);
            document.querySelector('[data-edit-sub="border"]').click();
            await wait(250);
            sync1.blurGroup = Array.from(document.querySelectorAll('.ctl-group > summary')).some((s) => s.textContent.trim() === '背景模糊');
        } catch (e) { sync1Err = String(e && e.message || e); }

        // 24.2) 我的调色：存当前、重置、套用、长按删除
        let gp = {}, gpErr = '';
        try {
            document.querySelector('[data-tab="grade"]').click();
            await wait(320);
            const setS = (k, v) => {
                const el = document.querySelector('[data-grade="' + k + '"]');
                el.value = String(v);
                el.dispatchEvent(new Event('input', { bubbles: true }));
            };
            setS('exp', 1.1); setS('sat', 33);
            await wait(320);
            document.getElementById('btnSaveGrade').click();
            await wait(380);
            gp.saved = JSON.parse(localStorage.getItem('qfm_grades') || '[]').length;
            gp.chips = document.querySelectorAll('[data-grade-preset]').length;
            document.getElementById('btnGradeReset').click();
            await wait(320);
            gp.resetExp = Number(window.App.image.grade.exp);
            document.querySelector('[data-grade-preset="0"]').click();
            await wait(460);
            gp.appliedExp = Number(window.App.image.grade.exp);
            gp.appliedSat = Number(window.App.image.grade.sat);
            document.querySelector('[data-grade-preset="0"]').dispatchEvent(
                new PointerEvent('pointerdown', { bubbles: true, pointerId: 41, button: 0 }));
            await wait(780);
            gp.afterDel = JSON.parse(localStorage.getItem('qfm_grades') || '[]').length;
        } catch (e) { gpErr = String(e && e.message || e); }

        // 24.5) 风格搜索 / 收藏 / 照片库移除
        let lib = {}, libErr = '';
        try {
            document.querySelector('[data-tab="style"]').click();
            await wait(300);
            const qEl = document.getElementById('styleQuery');
            const vis = () => document.querySelectorAll('.style-cell:not([hidden])').length;
            qEl.value = '拍立得';
            qEl.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(220);
            lib.searchHits = vis();
            lib.searchTotal = document.querySelectorAll('.style-cell[data-q]').length;
            lib.searchCount = (document.getElementById('styleCount').textContent || '').trim();
            lib.emptyHidden = document.getElementById('styleEmpty').hidden;
            qEl.value = '不存在的风格xyz';
            qEl.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(220);
            lib.searchZero = vis();
            lib.emptyShown = !document.getElementById('styleEmpty').hidden;
            qEl.value = '';
            qEl.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(220);

            const stars = document.querySelectorAll('.fav-btn');
            stars[0].click(); stars[1].click();
            await wait(180);
            lib.favStored = JSON.parse(localStorage.getItem('qfm_favs') || '[]').length;
            document.querySelector('[data-fav-toggle]').click();
            await wait(360);
            lib.favCards = document.querySelectorAll('.style-cell[data-q]').length;
            lib.favChipOn = document.querySelector('[data-fav-toggle]').classList.contains('on');
            for (let k = 0; k < 2; k++) {
                const on = document.querySelector('.fav-btn.on');
                if (on) { on.click(); await wait(260); }
            }
            document.querySelector('[data-fav-toggle]').click();
            await wait(320);
            lib.favCleared = JSON.parse(localStorage.getItem('qfm_favs') || '[]').length;
            lib.cardsBack = document.querySelectorAll('.style-cell[data-q]').length;

            document.querySelector('[data-tab="puzzle"]').click();
            await wait(380);
            lib.photosBefore = window.App.images.length;
            const delBtn = () => {
                const all = document.querySelectorAll('[data-del-photo]');
                return all[all.length - 1];
            };
            delBtn().click();
            await wait(220);
            lib.armed = document.querySelectorAll('.photo-cell.armed').length;
            delBtn().click();
            await wait(460);
            lib.photosAfter = window.App.images.length;
            lib.stillHasImage = !!window.App.image;
            lib.slotsValid = Object.keys(window.App.template.puzzle ? window.App.template.puzzle.slots : {})
                .every((k) => {
                    const sc = window.App.template.puzzle.slots[k];
                    return sc && Number(sc.imageIndex) >= 0 && Number(sc.imageIndex) < window.App.images.length;
                });

            document.querySelector('[data-tab="style"]').click();
            await wait(320);
            const plainBtn = document.getElementById('btnPlainStyle');
            if (plainBtn) plainBtn.click();
            await wait(360);
            lib.plain = {
                name: String(window.App.template.templateName || ''),
                pf: String(window.App.template.photoFrameStyle || ''),
                margin: Number(window.App.template.baseMargin && window.App.template.baseMargin.marginTop) || 0,
                active: !!(plainBtn && plainBtn.classList.contains('active'))
            };
        } catch (e) { libErr = String(e && e.message || e); }

        // 24.7) 批量导出：范围=全部时逐张出片，拼图页不掺和
        let bt = {}, btErr = '';
        try {
            document.querySelector('[data-tab="style"]').click();
            await wait(320);
            const ex = document.getElementById('btnExport');
            ex.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 81, button: 0 }));
            await wait(620);
            bt.scopeShown = !document.getElementById('rowScope').hidden;
            const allChip = document.querySelector('#optScope [data-scope="all"]');
            bt.allLabel = allChip ? allChip.textContent.trim() : '';
            allChip.click();
            await wait(220);
            bt.hint = document.getElementById('exportHint').textContent;

            const saved = [];
            const origSave = window.qfsNative.saveImage;
            window.qfsNative.saveImage = async (d, n) => { saved.push({ n, len: d.length }); return { ok: true, mode: 'download' }; };
            document.getElementById('btnExportGo').click();
            const expect = window.App.images.length;
            for (let k = 0; k < 200 && saved.length < expect; k++) await wait(150);
            await wait(600);
            window.qfsNative.saveImage = origSave;
            bt.expect = expect;
            bt.count = saved.length;
            bt.names = saved.map((x) => x.n);
            bt.allFramed = saved.every((x) => /_清框影\.jpg$/.test(x.n));
            bt.allNonEmpty = saved.every((x) => x.len > 2000);
            bt.previewBack = window.App.image && window.App.image.name === 'regress.jpg'
                ? true : !!window.App.image;

            // 拼图页的「全部」语义不同，不该出现范围行
            document.querySelector('[data-tab="puzzle"]').click();
            await wait(380);
            ex.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 82, button: 0 }));
            await wait(620);
            bt.scopeOnPuzzle = !document.getElementById('rowScope').hidden;
            document.getElementById('btnExportCancel').click();
            await wait(220);

            // 恢复默认「当前一张」，别把偏好留给下一次运行
            document.querySelector('[data-tab="style"]').click();
            await wait(320);
            ex.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 83, button: 0 }));
            await wait(620);
            const curChip = document.querySelector('#optScope [data-scope="current"]');
            if (curChip) curChip.click();
            document.getElementById('btnExportCancel').click();
            await wait(220);
        } catch (e) { btErr = String(e && e.message || e); }

        // 24.8) 我的风格：存当前 → 长廊出现 → 套回 → 分享码 → 导入 → 长按删除
        let ms = {}, msErr = '';
        try {
            const readStore = () => {
                try { return JSON.parse(localStorage.getItem('qfm_styles') || '[]'); } catch (_) { return []; }
            };
            ms.before = readStore().length;
            const uniq = '回归风格' + (Date.now() % 10000);
            document.querySelector('[data-tab="style"]').click();
            await wait(320);
            const pIdx = (window.QF_PRESETS || []).findIndex((p) => p.templateName === '极简细线');
            document.querySelector('[data-preset="' + pIdx + '"]').click();
            await wait(420);
            const tplNow = window.App.template || {};
            ms.sig = {
                style: String(tplNow.photoFrameStyle || ''),
                margin: Number(tplNow.baseMargin && tplNow.baseMargin.marginTop) || 0,
                lines: ((tplNow.decorConfig && tplNow.decorConfig.textLines) || []).length
            };
            document.getElementById('btnSaveStyle').click();
            await wait(320);
            ms.modalOpen = !!document.getElementById('styleModal');
            document.getElementById('styleNameInput').value = uniq;
            document.querySelector('#styleModal [data-modal-act="1"]').click();
            await wait(620);
            const store1 = readStore();
            ms.saved = store1.length - ms.before;
            ms.storedName = store1[0] && store1[0].name;
            // 注意：这段脚本是嵌在模板字符串里下发的，正则里的 \/ 会被模板字符串吃掉，
            // 退化成 /^data:image/ + jpeg/ 直接语法错误 —— 用 startsWith 更稳
            ms.hasCover = String((store1[0] && store1[0].cover) || '').startsWith('data:image/jpeg');
            ms.coverData = (store1[0] && store1[0].cover || '').slice(0, 22);
            ms.badge = !!document.querySelector('.own-badge');
            ms.cards = document.querySelectorAll('[data-my-style]').length;

            // 换个风格再把我的风格套回来：边框要回到存的时候那套
            const nIdx = (window.QF_PRESETS || []).findIndex((p) => p.templateName === 'NOMO复古相机');
            document.querySelector('[data-preset="' + nIdx + '"]').click();
            await wait(420);
            const afterOther = window.App.template.templateName;
            document.querySelector('[data-my-style="0"]').click();
            await wait(520);
            const tplBack = window.App.template || {};
            ms.apply = {
                from: afterOther,
                name: tplBack.templateName,
                style: String(tplBack.photoFrameStyle || ''),
                margin: Number(tplBack.baseMargin && tplBack.baseMargin.marginTop) || 0,
                lines: ((tplBack.decorConfig && tplBack.decorConfig.textLines) || []).length,
                active: document.querySelector('[data-my-style="0"]').classList.contains('active')
            };

            // 分享码：设置页入口 → 文本域里应是 QFSCFG1: 开头
            document.getElementById('btnSettings').click();
            await wait(320);
            document.getElementById('btnShareStyle').click();
            await wait(420);
            const codeBox = document.getElementById('styleCodeBox');
            ms.codeHead = codeBox ? codeBox.value.slice(0, 8) : '';
            ms.codeLen = codeBox ? codeBox.value.length : 0;
            const code = codeBox ? codeBox.value : '';
            document.querySelector('#styleModal [data-modal-act="0"]').click();
            await wait(220);

            // 导入同一段码：名字自动去重，条数 +1
            document.getElementById('btnImportStyle').click();
            await wait(320);
            document.getElementById('styleImportBox').value = code;
            document.querySelector('#styleModal [data-modal-act="1"]').click();
            await wait(720);
            const store2 = readStore();
            ms.imported = store2.length - store1.length;
            ms.importedName = store2[0] && store2[0].name;

            // 长按删除两条，恢复原状
            document.querySelector('[data-tab="style"]').click();
            await wait(420);
            for (let k = 0; k < 2; k++) {
                const cardEl = document.querySelector('[data-my-style="0"]');
                if (!cardEl) break;
                cardEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 71 + k, button: 0 }));
                await wait(780);
                const m = document.getElementById('styleModal');
                if (m) document.querySelector('#styleModal [data-modal-act="1"]').click();
                await wait(520);
            }
            ms.afterDelete = readStore().length;
        } catch (e) { msErr = String(e && e.message || e); }

        // 24.9) 撤销要能撤掉拼图版式（否则点了撤销会去撤更早的模板改动）
        let uz = {}, uzErr = '';
        try {
            document.querySelector('[data-tab="puzzle"]').click();
            await wait(420);
            const activeLayout = () => {
                const b = document.querySelector('[data-layout].active');
                return b ? b.dataset.layout : '';
            };
            const first = activeLayout();
            const other = Array.from(document.querySelectorAll('[data-layout]'))
                .find((b) => b.dataset.layout !== first);
            other.click();
            await wait(420);
            uz.changed = activeLayout();
            document.getElementById('btnUndo').click();
            await wait(520);
            uz.afterUndo = activeLayout();
            document.getElementById('btnRedo').click();
            await wait(520);
            uz.afterRedo = activeLayout();
            uz.first = first;
            uz.other = other.dataset.layout;
        } catch (e) { uzErr = String(e && e.message || e); }

        // 24.95) 照片方向：旋转/翻转、撤销、导出全尺寸重放、重置
        let rot = {}, rotErr = '';
        try {
            const cvEl = document.getElementById('previewCanvas');
            const size = () => ({ w: cvEl.width, h: cvEl.height });
            document.querySelector('[data-tab="edit"]').click();
            await wait(320);
            document.querySelector('[data-edit-sub="photo"]').click();
            await wait(260);
            rot.buttons = document.querySelectorAll('[data-img-op]').length;
            rot.before = size();
            document.querySelector('[data-img-op="r"]').click();
            await wait(560);
            rot.afterR = size();
            rot.ops = (window.App.image.ops || []).join('');
            rot.dimsText = document.getElementById('hdrMeta').textContent;
            document.getElementById('btnUndo').click();
            await wait(560);
            rot.undone = size();

            // 导出时要在全尺寸上重放方向：挂一张 1600×1200 的假「原图」
            document.querySelector('[data-edit-sub="photo"]').click();
            await wait(220);
            document.querySelector('[data-img-op="r"]').click();
            await wait(520);
            // 换成「原图」再导出：带相框的模板会额外加边距，画布尺寸就不再等于照片本身
            document.querySelector('[data-tab="style"]').click();
            await wait(420);
            const plainBtn = document.getElementById('btnPlainStyle');
            if (plainBtn) plainBtn.click();
            await wait(420);
            const full = document.createElement('canvas');
            full.width = 1600; full.height = 1200;
            const fg = full.getContext('2d');
            fg.fillStyle = '#234'; fg.fillRect(0, 0, 1600, 1200);
            const origFull = window.qfFullSource;
            const origSave = window.qfsNative.saveImage;
            window.qfFullSource = async () => ({ canvas: full, changed: true, capped: false, fallback: false, release() {} });
            let saved = null;
            window.qfsNative.saveImage = async (d, n) => { saved = { d, n }; return { ok: true, mode: 'download' }; };
            const ex = document.getElementById('btnExport');
            ex.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 91, button: 0 }));
            await wait(620);
            document.querySelector('#optFormat [data-format="png"]').click();
            document.getElementById('btnExportGo').click();
            for (let i = 0; i < 140 && !saved; i++) await wait(150);
            const b64 = ((saved && saved.d) || '').split(',')[1] || '';
            const bin = atob(b64.slice(0, 48));
            rot.expW = ((bin.charCodeAt(16) << 24) | (bin.charCodeAt(17) << 16)
                | (bin.charCodeAt(18) << 8) | bin.charCodeAt(19)) >>> 0;
            rot.expH = ((bin.charCodeAt(20) << 24) | (bin.charCodeAt(21) << 16)
                | (bin.charCodeAt(22) << 8) | bin.charCodeAt(23)) >>> 0;
            window.qfFullSource = origFull;
            window.qfsNative.saveImage = origSave;
            // 格式改回默认，别影响下一次运行
            ex.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 92, button: 0 }));
            await wait(620);
            document.querySelector('#optFormat [data-format="jpeg"]').click();
            document.querySelector('#optSize [data-size="0"]').click();
            document.querySelector('#optQuality [data-quality="0.92"]').click();
            document.getElementById('btnExportCancel').click();
            await wait(320);

            document.querySelector('[data-tab="edit"]').click();
            await wait(300);
            document.querySelector('[data-edit-sub="photo"]').click();
            await wait(250);
            const rb = document.getElementById('btnImgReset');
            rot.hasReset = !!rb;
            if (rb) rb.click();
            await wait(480);
            rot.afterReset = size();
            rot.resetOps = (window.App.image.ops || []).length;
        } catch (e) { rotErr = String(e && e.message || e); }

        // 24.97) 居中等比裁剪：预览/导出/撤销/恢复
        let cp = {}, cpErr = '';
        try {
            const cvEl = document.getElementById('previewCanvas');
            const size = () => ({ w: cvEl.width, h: cvEl.height });
            document.querySelector('[data-tab="edit"]').click();
            await wait(320);
            document.querySelector('[data-edit-sub="photo"]').click();
            await wait(260);
            cp.chips = document.querySelectorAll('[data-crop-ratio]').length;
            cp.before = size();
            document.querySelector('[data-crop-ratio="1:1"]').click();
            await wait(600);
            cp.square = size();
            cp.src = [window.App.image.srcW, window.App.image.srcH];

            // 导出：1600×1200 的「原图」按 0.75 的裁剪比例应出 1200×1200
            const full = document.createElement('canvas');
            full.width = 1600; full.height = 1200;
            full.getContext('2d').fillRect(0, 0, 1600, 1200);
            const origFull = window.qfFullSource;
            const origSave = window.qfsNative.saveImage;
            window.qfFullSource = async () => ({ canvas: full, changed: true, capped: false, fallback: false, release() {} });
            let saved = null;
            window.qfsNative.saveImage = async (d, n) => { saved = { d, n }; return { ok: true, mode: 'download' }; };
            const ex = document.getElementById('btnExport');
            ex.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 95, button: 0 }));
            await wait(620);
            document.querySelector('#optFormat [data-format="png"]').click();
            document.getElementById('btnExportGo').click();
            for (let i = 0; i < 160 && !saved; i++) await wait(150);
            const b64 = ((saved && saved.d) || '').split(',')[1] || '';
            const bin = atob(b64.slice(0, 48));
            cp.expW = ((bin.charCodeAt(16) << 24) | (bin.charCodeAt(17) << 16)
                | (bin.charCodeAt(18) << 8) | bin.charCodeAt(19)) >>> 0;
            cp.expH = ((bin.charCodeAt(20) << 24) | (bin.charCodeAt(21) << 16)
                | (bin.charCodeAt(22) << 8) | bin.charCodeAt(23)) >>> 0;
            window.qfFullSource = origFull;
            window.qfsNative.saveImage = origSave;
            ex.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 96, button: 0 }));
            await wait(620);
            document.querySelector('#optFormat [data-format="jpeg"]').click();
            document.getElementById('btnExportCancel').click();
            await wait(300);

            document.querySelector('[data-tab="edit"]').click();
            await wait(300);
            document.querySelector('[data-edit-sub="photo"]').click();
            await wait(240);
            document.querySelector('[data-crop-ratio="4:5"]').click();
            await wait(600);
            cp.r45 = size();
            document.getElementById('btnUndo').click();
            await wait(600);
            cp.undone = size();
            document.querySelector('[data-edit-sub="photo"]').click();
            await wait(220);
            document.querySelector('[data-crop-ratio="orig"]').click();
            await wait(600);
            cp.restored = size();
        } catch (e) { cpErr = String(e && e.message || e); }

        // 24.98) 自由裁剪：取景框、锁定比例、应用、导出、撤销
        let fc = {}, fcErr = '';
        try {
            const cvEl = document.getElementById('previewCanvas');
            document.querySelector('[data-tab="edit"]').click();
            await wait(320);
            document.querySelector('[data-edit-sub="photo"]').click();
            await wait(240);
            document.querySelector('[data-crop-ratio="free"]').click();
            await wait(700);
            fc.open = {
                layer: !document.getElementById('cropLayer').hidden,
                bar: !document.getElementById('cropBar').hidden,
                handles: document.querySelectorAll('.crop-h').length,
                box: Math.round(document.getElementById('cropBox').getBoundingClientRect().width)
            };
            // 锁定 1:1：框应变成正方形（贴满短边）
            document.querySelector('#cropRatios [data-crop-lock="1:1"]').click();
            await wait(280);
            const rb = document.getElementById('cropBox').getBoundingClientRect();
            fc.locked = { w: Math.round(rb.width), h: Math.round(rb.height) };
            document.getElementById('btnCropApply').click();
            await wait(800);
            fc.applied = {
                w: cvEl.width, h: cvEl.height,
                src: [window.App.image.srcW, window.App.image.srcH],
                ratio: window.App.image.cropRatio,
                ops: (window.App.image.ops || []).map((o) => (typeof o === 'string' ? o : 'crop')),
                layerHidden: document.getElementById('cropLayer').hidden
            };

            // 导出：400×300 的夹具按 1:1 裁完，再用 1600×1200 的「原图」重放，应出 1200×1200
            const full = document.createElement('canvas');
            full.width = 1600; full.height = 1200;
            full.getContext('2d').fillRect(0, 0, 1600, 1200);
            const origFull = window.qfFullSource;
            const origSave = window.qfsNative.saveImage;
            window.qfFullSource = async () => ({ canvas: full, changed: true, capped: false, fallback: false, release() {} });
            let saved = null;
            window.qfsNative.saveImage = async (d, n) => { saved = { d, n }; return { ok: true, mode: 'download' }; };
            const ex = document.getElementById('btnExport');
            ex.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 97, button: 0 }));
            await wait(620);
            document.querySelector('#optFormat [data-format="png"]').click();
            document.getElementById('btnExportGo').click();
            for (let i = 0; i < 160 && !saved; i++) await wait(150);
            const b64 = ((saved && saved.d) || '').split(',')[1] || '';
            const bin = atob(b64.slice(0, 48));
            fc.expW = ((bin.charCodeAt(16) << 24) | (bin.charCodeAt(17) << 16)
                | (bin.charCodeAt(18) << 8) | bin.charCodeAt(19)) >>> 0;
            fc.expH = ((bin.charCodeAt(20) << 24) | (bin.charCodeAt(21) << 16)
                | (bin.charCodeAt(22) << 8) | bin.charCodeAt(23)) >>> 0;
            window.qfFullSource = origFull;
            window.qfsNative.saveImage = origSave;
            ex.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 98, button: 0 }));
            await wait(620);
            document.querySelector('#optFormat [data-format="jpeg"]').click();
            document.getElementById('btnExportCancel').click();
            await wait(260);

            document.getElementById('btnUndo').click();
            await wait(700);
            fc.undone = { w: cvEl.width, h: cvEl.height };
        } catch (e) { fcErr = String(e && e.message || e); }

        // 25) RAW 全尺寸重解（本地有样本时）
        let rawFull = {}, rawFullErr = '';
        if (${JSON.stringify(fs.existsSync(rawSample))}) {
            try {
                const resp = await fetch('/' + ${JSON.stringify(rawTestName)});
                if (!resp.ok) throw new Error('RAW 样本 HTTP ' + resp.status);
                const blob = await resp.blob();
                const file = new File([blob], 'sample.ARW');
                const cv = await window.qfRawDecodeFull(file);
                rawFull = {
                    w: cv.width, h: cv.height,
                    px: Array.from(cv.getContext('2d').getImageData(0, 0, 1, 1).data)
                };
                cv.width = 0; cv.height = 0;
            } catch (e) { rawFullErr = String(e && e.message || e); }
        }

        return {
            idx, tplPf, presetPf, styleW, styleH, puzzleW, backW, backH, exported,
            cropNames: saved.map((s) => s.n), cropDims: saved.map((s) => s.dims), cropCount: saved.length,
            histoConnected, histoSum: hsum,
            gradeExp,
            rawErr, rawPx,
            rawBridge: typeof window.qfRawDecode === 'function',
            heic, heicErr, heicFull, heicFullErr, fullExport, fullExportErr,
            puzzleExport, puzzleExportErr, cropFull, cropFullErr,
            edit, editErr, text, textErr, el, elErr, tpl, tplErr, drag, dragErr, handle, handleErr, dbl, dblErr,
            pinch, pinchErr, exif, exifErr, multi, multiErr, autofs, autofsErr, layout, layoutErr,
            extras, extrasErr, exportOpt, exportOptErr, bt, btErr, gp, gpErr, lib, libErr, ms, msErr, uz, uzErr, rot, rotErr, cp, cpErr, fc, fcErr, sync1, sync1Err, rawFull, rawFullErr
        };
    })()`);

    check(r.idx >= 0 && r.tplPf === r.presetPf,
        '预设没有 photoFrameStyle 时不伪造相框风格', JSON.stringify({ preset: r.idx, tplPf: r.tplPf, presetPf: r.presetPf }));
    check(r.styleW > 0 && r.styleH > 0 && r.backW === r.styleW && r.backH === r.styleH && r.backW !== r.puzzleW,
        '拼图切回风格页后画布按当前照片重画', JSON.stringify({ style: r.styleW + 'x' + r.styleH, puzzleW: r.puzzleW, back: r.backW + 'x' + r.backH }));
    check(/_清框影\.jpg$/.test(r.exported) && !/_拼图\.jpg$/.test(r.exported),
        '切回后导出的是当前照片而不是上一页拼图', r.exported);

    check(r.cropCount === 9 && new Set(r.cropNames).size === 9,
        '切图 9 块文件名互不重复（不再都叫 IMG_1234.jpg）', JSON.stringify(r.cropNames.slice(0, 3)));
    check(r.cropDims.every((d) => d !== 'bad' && Number(String(d).split('x')[0]) > 100),
        '切图块来自加风格后的成品画布而不是原图', JSON.stringify(r.cropDims.slice(0, 3)));

    check(r.gradeExp > 1.4 && r.histoConnected && r.histoSum > 0,
        '调色页切走再切回后直方图仍画在新画布上', JSON.stringify({ exp: r.gradeExp, connected: r.histoConnected, sum: r.histoSum }));

    check(r.rawBridge && !r.rawErr && r.rawPx.join(',') === '255,0,0,255,0,255,0,255',
        'RAW 3 通道像素补 alpha 后正确（不再 RangeError）', JSON.stringify({ err: r.rawErr, px: r.rawPx.slice(0, 8) }));

    check(!r.heicErr && r.heic.w === 451 && r.heic.h === 461 && r.heic.px.some((v) => v > 0),
        'HEIC 系统解码失败时 libheif(WASM) 兜底解出正确像素', JSON.stringify({ heic: r.heic, err: r.heicErr }));
    check(!r.heicFullErr && r.heicFull.w === 451 && r.heicFull.h === 461 && r.heicFull.changed,
        '全尺寸导出从 HEIC 原文件重解而不是放大 1600px 预览', JSON.stringify({ heicFull: r.heicFull, err: r.heicFullErr }));

    check(!r.fullExportErr && Number(String(r.fullExport.dims).split('x')[0]) >= 2400,
        '导出按原图尺寸而不是 1600px 预览', JSON.stringify({ export: r.fullExport, err: r.fullExportErr }));
    check(Number(r.fullExport.after) < 1800 && !r.fullExport.exportScale,
        '导出后画布和临时档位都回到 1600px 预览', JSON.stringify(r.fullExport));

    check(!r.puzzleExportErr && Number(String(r.puzzleExport.dims).split('x')[0]) >= 3000
        && Number(r.puzzleExport.after) < 1800 && !r.puzzleExport.exportScale,
        '拼图导出按 4000px 版式且导出后回到 1600px 预览', JSON.stringify({ puzzle: r.puzzleExport, err: r.puzzleExportErr }));

    check(!r.cropFullErr && Number(String(r.cropFull.dims[0]).split('x')[0]) >= 800 && r.cropFull.count === 9,
        '切图从全尺寸成品上切出 9 块', JSON.stringify({ crop: r.cropFull, err: r.cropFullErr }));

    check(!r.editErr && r.edit.tabs === 5 && r.edit.subs === 5 && r.edit.ctls > 10
        && r.edit.textCtls > 10 && /编辑 · 边框/.test(r.edit.stageMeta),
        '编辑页五个页签、五个子页（含照片方向）与边框/文字控件都在', JSON.stringify({ edit: r.edit, err: r.editErr }));
    check(!r.editErr && r.edit.changedStroke && r.edit.changedFill && r.edit.stroke === 40 && r.edit.fill === '00ff00',
        '边框控件写入 template.layerList（描边宽度/填充颜色）', JSON.stringify({ edit: r.edit, err: r.editErr }));

    check(!r.textErr && r.text.lines === r.text.baseline + 1 && r.text.text === '回归文字' && r.text.fontSize === 80,
        '编辑 › 文字能添加并修改自由文字', JSON.stringify({ text: r.text, err: r.textErr }));
    check(!r.textErr && r.text.hasSigRow === false && r.text.exifAutoText === 1
        && r.text.afterDelete === r.text.baseline,
        '图层模板隐藏无效署名行；EXIF 写回且删除文字生效',
        JSON.stringify({ text: r.text, err: r.textErr }));

    check(!r.elErr && r.el.logos === r.el.baseline + 1 && /回归LOGO/.test(String(r.el.name))
        && r.el.size === 300 && r.el.opacity === 60 && r.el.stickers >= 1 && r.el.afterClear === 0,
        '编辑 › 元素能加 Logo/贴纸、调几何并清空', JSON.stringify({ el: r.el, err: r.elErr }));

    check(!r.tplErr && r.tpl.saved && r.tpl.savedChips >= 1 && r.tpl.kind === 'qfs-config'
        && r.tpl.importedName === '码导入' && r.tpl.importedMargin === 1.7 && r.tpl.loadedName === '回归模板',
        '编辑 › 样式能保存/导出/分享码导入/载入模板', JSON.stringify({ tpl: r.tpl, err: r.tplErr }));

    check(!r.dragErr && r.drag.tab === 'edit' && r.drag.activeChip === 'logo:0'
        && r.drag.after.x === r.drag.before.x + 80 && r.drag.after.y === r.drag.before.y + 50,
        '画布点选 Logo 会切到编辑页并可拖动', JSON.stringify({ drag: r.drag, err: r.dragErr }));

    check(!r.handleErr && r.handle.rotation === 90 && Math.abs(r.handle.size - r.handle.origSize * 1.5) <= 2,
        '画布手柄能旋转并放大 Logo', JSON.stringify({ handle: r.handle, err: r.handleErr }));

    check(!r.dblErr && r.dbl.opened && r.dbl.value === '双击前' && r.dbl.live === '双击后'
        && r.dbl.closed && r.dbl.after === '双击后',
        '双击文字就地编辑并实时写回', JSON.stringify({ dbl: r.dbl, err: r.dblErr }));

    check(!r.pinchErr && r.pinch.zoom > 1.5 && r.pinch.zoom < 2.2 && r.pinch.reset.indexOf('scale(1)') >= 0,
        '双指缩放预览、双击空白复位', JSON.stringify({ pinch: r.pinch, err: r.pinchErr }));

    check(!r.exifErr && r.exif.make === 'SONY' && r.exif.model === 'ILCE-6000'
        && r.exif.shutter === '1/125s' && r.exif.aperture === 'f/5.6' && r.exif.iso === 'ISO100'
        && r.exif.focal === '35mm' && r.exif.focal35 === 52,
        '导入照片自动识别 EXIF 拍摄参数', JSON.stringify({ exif: r.exif, err: r.exifErr }));

    check(!r.multiErr && r.multi.count === 2 && r.multi.selected === 2 && r.multi.hasAlign
        && r.multi.aligned && r.multi.zAfter === r.multi.zBefore + 1 && r.multi.afterDelete === 0,
        '元素多选、对齐、层级与批量删除', JSON.stringify({ multi: r.multi, err: r.multiErr }));

    check(!r.autofsErr && r.autofs.large.fs > r.autofs.small.fs && r.autofs.small.pf !== 0,
        '预设文字字号按照片短边缩放，相框品牌字号不被重复放大', JSON.stringify({ autofs: r.autofs, err: r.autofsErr }));

    // 预览代理的字号必须按 1600/4000 缩回，否则预览与成品比例对不上（用户报的「字忽大忽小」）
    const proxyFs = r.autofs && r.autofs.proxy && r.autofs.proxy.fs;
    const expectProxy = r.autofs && r.autofs.large && r.autofs.large.fs * 1600 / 4000;
    check(!r.autofsErr && proxyFs > 0 && Math.abs(proxyFs - expectProxy) <= 1,
        '预览代理字号按代理/原图比例缩回（预览与导出同比例）',
        JSON.stringify({ proxy: proxyFs, expect: expectProxy, autofs: r.autofs, err: r.autofsErr }));

    // 模板类预设的绝对边距也要按同一比例折：预览的胶片边厚度必须和成片一致
    const mFull = r.autofs && r.autofs.layoutFull && r.autofs.layoutFull.marginTop;
    const mProxy = r.autofs && r.autofs.layoutProxy && r.autofs.layoutProxy.marginTop;
    const mExpect = (typeof mFull === 'number') ? Math.round(mFull * 1600 / 4000) : NaN;
    check(!r.autofsErr && mFull > 0 && Math.abs(mProxy - mExpect) <= 1,
        '模板绝对边距按代理/原图比例折回（预览边框与成片同厚）',
        JSON.stringify({ full: mFull, proxy: mProxy, expect: mExpect, autofs: r.autofs, err: r.autofsErr }));

    check(!r.layoutErr && r.layout.home.page === 'home' && r.layout.home.nav === 3
        && r.layout.home.sections >= 3 && r.layout.home.cards > 20 && r.layout.home.hero
        && r.layout.searchCards > 0 && r.layout.searchCards < r.layout.home.cards,
        '首页：分区风格墙 + 搜索收窄 + 胶囊导航',
        JSON.stringify({ layout: r.layout, err: r.layoutErr }));

    check(!r.layoutErr && r.layout.afterCard.page === 'edit'
        && r.layout.afterCard.template
        && r.layout.afterCard.title === r.layout.afterCard.template,
        '首页点卡片：套用风格并跳到编辑页',
        JSON.stringify({ layout: r.layout, err: r.layoutErr }));

    check(!r.layoutErr && r.layout.mine.page === 'mine' && r.layout.mine.rows >= 8
        && r.layout.mine.platform && r.layout.backEdit.page === 'edit'
        && r.layout.backEdit.exportBtn && r.layout.backEdit.navHidden,
        '我的页分组完整；编辑页隐藏底部导航、导出回到顶栏',
        JSON.stringify({ layout: r.layout, err: r.layoutErr }));

    check(!r.extrasErr && r.extras.undo && r.extras.undo.applied !== r.extras.undo.beforeName
        && r.extras.undo.undone === r.extras.undo.beforeName
        && r.extras.undo.redone === r.extras.undo.applied && r.extras.undo.canUndo,
        '撤销/重做：套预设一步、撤销回原模板、重做再回来',
        JSON.stringify({ undo: r.extras && r.extras.undo, err: r.extrasErr }));

    check(!r.extrasErr && r.extras.exportOpened && /2000/.test(r.extras.exportHint)
        && /PNG/.test(r.extras.exportHint) && /"maxEdge":2000/.test(r.extras.exportStored)
        && r.extras.exportClosed,
        '导出选项：长按打开、长边/格式写入偏好、取消关闭',
        JSON.stringify({ extras: r.extras, err: r.extrasErr }));

    check(!r.extrasErr && r.extras.compareOn && r.extras.compareOff,
        '长按画布看原图、松手恢复', JSON.stringify({ extras: r.extras, err: r.extrasErr }));

    check(!r.fcErr && r.fc.open && r.fc.open.layer && r.fc.open.bar && r.fc.open.handles === 4
        && Math.abs(r.fc.locked.w - r.fc.locked.h) <= 2
        && Math.abs(r.fc.applied.src[0] - r.fc.applied.src[1]) < 0.5 && r.fc.applied.ratio === '1:1'
        && r.fc.applied.layerHidden,
        '自由裁剪：取景框就位、锁 1:1 后成方图并写回照片',
        JSON.stringify({ fc: r.fc, err: r.fcErr }));

    check(!r.fcErr && r.fc.expW === 1200 && r.fc.expH === 1200
        && r.fc.undone.w === r.fc.applied.w * 4 / 3,
        '自由裁剪：导出按取景框比例重放，撤销回到裁前尺寸',
        JSON.stringify({ fc: r.fc, err: r.fcErr }));

    check(!r.cpErr && r.cp.chips === 6 && r.cp.square.w === r.cp.square.h
        && r.cp.src[0] === r.cp.src[1] && r.cp.expW === 1200 && r.cp.expH === 1200,
        '居中等比裁剪：1:1 出方图，导出按同一裁剪比例重放',
        JSON.stringify({ cp: r.cp, err: r.cpErr }));

    check(!r.cpErr && r.cp.r45.w < r.cp.r45.h && r.cp.undone.w === r.cp.square.w
        && r.cp.restored.w === r.cp.before.w && r.cp.restored.h === r.cp.before.h,
        '居中等比裁剪：4:5 收窄、撤销回上一步、原图恢复完整画面',
        JSON.stringify({ cp: r.cp, err: r.cpErr }));

    check(!r.btErr && r.bt.scopeShown && /全部 \d+ 张/.test(r.bt.allLabel)
        && r.bt.count === r.bt.expect && r.bt.allFramed && r.bt.allNonEmpty
        && !r.bt.scopeOnPuzzle && r.bt.previewBack,
        '批量导出：范围=全部时逐张出片，拼图页不出现该选项',
        JSON.stringify({ bt: r.bt, err: r.btErr }));

    check(!r.rotErr && r.rot.buttons === 4 && r.rot.afterR.w === r.rot.before.h
        && r.rot.afterR.h === r.rot.before.w && r.rot.ops === 'r' && r.rot.undone.w === r.rot.before.w,
        '照片方向：右转 90° 换宽高、撤销能转回去',
        JSON.stringify({ rot: r.rot, err: r.rotErr }));

    check(!r.rotErr && r.rot.expW === 1200 && r.rot.expH === 1600,
        '照片方向：导出时在全尺寸上重放旋转（1600×1200 → 1200×1600）',
        JSON.stringify({ expW: r.rot && r.rot.expW, expH: r.rot && r.rot.expH, err: r.rotErr }));

    // 重置时画布已经换成「原图」模板，尺寸等于夹具本身（400×300），
    // 不能拿旋转前带相框的 660×560 来比
    check(!r.rotErr && r.rot.hasReset && r.rot.afterReset.w === 400
        && r.rot.afterReset.h === 300 && r.rot.resetOps === 0,
        '照片方向：可一键恢复原始方向', JSON.stringify({ rot: r.rot, err: r.rotErr }));

    check(!r.uzErr && r.uz.changed === r.uz.other && r.uz.afterUndo === r.uz.first
        && r.uz.afterRedo === r.uz.other,
        '撤销/重做覆盖拼图版式，不会误撤到更早的模板改动',
        JSON.stringify({ uz: r.uz, err: r.uzErr }));

    check(!r.msErr && r.ms.modalOpen && r.ms.saved === 1 && /^回归风格/.test(r.ms.storedName || '')
        && r.ms.hasCover && r.ms.badge && r.ms.cards >= 1,
        '我的风格：命名保存、封面离屏渲染、长廊出现「我的」角标',
        JSON.stringify({ ms: r.ms, err: r.msErr }));

    check(!r.msErr && r.ms.apply.name === r.ms.storedName
        && r.ms.apply.style === r.ms.sig.style && r.ms.apply.margin === r.ms.sig.margin
        && r.ms.apply.lines === r.ms.sig.lines && r.ms.apply.active,
        '我的风格：换风格后能套回，边框与高亮都跟着回来',
        JSON.stringify({ apply: r.ms && r.ms.apply, err: r.msErr }));

    check(!r.msErr && r.ms.codeHead === 'QFSCFG1:' && r.ms.codeLen > 200
        && r.ms.imported === 1 && / 2$/.test(r.ms.importedName || '') && r.ms.afterDelete === r.ms.before,
        '我的风格：分享码可生成、可导入（同名自动加序号），长按可删',
        JSON.stringify({ ms: r.ms, err: r.msErr }));

    check(!r.gpErr && r.gp.saved === 1 && r.gp.chips === 1 && Math.abs(r.gp.resetExp) < 1e-6
        && Math.abs(r.gp.appliedExp - 1.1) < 0.02 && Math.abs(r.gp.appliedSat - 33) < 0.5
        && r.gp.afterDel === 0,
        '我的调色：存预设、重置、套用、长按删除',
        JSON.stringify({ gp: r.gp, err: r.gpErr }));

    check(!r.libErr && r.lib.searchHits > 0 && r.lib.searchHits < r.lib.searchTotal
        && r.lib.emptyHidden && r.lib.searchZero === 0 && r.lib.emptyShown
        && new RegExp('^' + r.lib.searchHits + ' / ' + r.lib.searchTotal).test(r.lib.searchCount),
        '风格搜索：实时收窄、计数同步、无结果给提示',
        JSON.stringify({ lib: r.lib, err: r.libErr }));

    check(!r.libErr && r.lib.favStored === 2 && r.lib.favCards === 2 && r.lib.favChipOn
        && r.lib.favCleared === 0 && r.lib.cardsBack === r.lib.searchTotal,
        '风格收藏：星标持久化、只看收藏、取消后回到全部',
        JSON.stringify({ lib: r.lib, err: r.libErr }));

    check(!r.libErr && r.lib.plain && !r.lib.plain.name && !r.lib.plain.pf
        && r.lib.plain.margin === 0 && r.lib.plain.active,
        '原图卡：一键去掉边框/文字，回到无风格',
        JSON.stringify({ plain: r.lib && r.lib.plain, err: r.libErr }));

    check(!r.libErr && r.lib.armed === 1 && r.lib.photosAfter === r.lib.photosBefore - 1
        && r.lib.stillHasImage && r.lib.slotsValid,
        '照片库：两下确认才移除、槽位索引跟着重排',
        JSON.stringify({ lib: r.lib, err: r.libErr }));

    check(!r.exportOptErr && /^data:image\/png/.test(r.exportOpt.mime || '')
        && Math.max(r.exportOpt.pngW || 0, r.exportOpt.pngH || 0) === 1080
        && /\.png$/.test(r.exportOpt.name || ''),
        '导出选项生效：1080 长边 + PNG 真落到成品',
        JSON.stringify({ exportOpt: r.exportOpt, err: r.exportOptErr }));

    check(!r.sync1Err && r.sync1.autoBtn && r.sync1.fx && r.sync1.gradeChanged && r.sync1.vignette === 60,
        '自动调色与效果滑块已同步到手机', JSON.stringify({ sync1: r.sync1, err: r.sync1Err }));
    check(!r.sync1Err && r.sync1.gap === 18 && r.sync1.cropCells === 6 && r.sync1.blurGroup,
        '拼图选项/切图自定义/背景模糊已同步到手机', JSON.stringify({ sync1: r.sync1, err: r.sync1Err }));

    if (fs.existsSync(rawSample)) {
        check(!r.rawFullErr && r.rawFull.w >= 3000 && r.rawFull.h >= 2000 && r.rawFull.px.some((v) => v > 0),
            'RAW 导出前能按原图尺寸重解（不再是半尺寸代理）', JSON.stringify({ raw: r.rawFull, err: r.rawFullErr }));
    }

    check(errors.length === 0, '本次回归全程无相框占位/渲染失败警告', errors.slice(0, 3).join(' / '));

    console.log(fails.length ? `\n${fails.length} FAILURE(S)` : '\nALL PASS');
    win.destroy();
    // 沙箱里 safe-delete 偶尔会 EPERM，清理失败不能盖住测试结果、更不能中断后续测试链
    try { if (fs.existsSync(rawTestFile)) fs.unlinkSync(rawTestFile); } catch (_) {}
    app.exit(fails.length ? 1 : 0);
}).catch((e) => {
    console.error(e && e.stack || e);
    // 注入脚本抛错时，真正的原因在渲染器控制台里，不打出来只能看到
    // 一句「Script failed to execute」
    if (errors.length) console.error('渲染器报错:\n' + errors.slice(-6).join('\n'));
    // 清理失败不能盖住原始错误（沙箱里的 safe-delete 有时会 EPERM）
    try { if (fs.existsSync(rawTestFile)) fs.unlinkSync(rawTestFile); } catch (_) {}
    app.exit(1);
});
