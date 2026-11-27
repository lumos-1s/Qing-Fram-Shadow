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

    function log(s) { if (logEl) logEl.textContent += String(s) + '\n'; }
    function clearLog() { if (logEl) logEl.textContent = ''; }

    function evalScript(src) {
        return new Promise((resolve) => {
            if (window.qfMockHost) return window.qfMockHost.eval(src, resolve);
            if (cs && typeof cs.evalScript === 'function') return cs.evalScript(src, resolve);
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
    function tempPath(name) {
        if (window.qfMockHost) return window.qfMockHost.tempPath(name);
        let dir = '';
        try { dir = cs.getSystemPath(SystemPath.USER_DATA); } catch (_) {}
        return (dir ? dir.replace(/[\\/]+$/, '') + '/' : '') + name;
    }

    async function loadLayer(path) {
        const img = new Image();
        await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = () => rej(new Error('图层图片解码失败：' + path));
            // CEP 面板已开 --allow-file-access-from-files；直接走 file://，
            // 不再把 69MB 的 PNG 读成 93MB 的 base64（ cep.fs.readFile 会卡住不回调）
            img.src = window.qfMockHost
                ? 'data:image/png;base64,' + (await0(path))
                : 'file:///' + String(path).replace(/\\/g, '/');
        });
        function await0(p) {
            // 同步占位：mock 的读取在下方 await 之前已完成，这里只用数据 URL
            return window.qfMockFiles ? window.qfMockFiles[p] : '';
        }
        const el = document.createElement('canvas');
        el.width = img.naturalWidth; el.height = img.naturalHeight;
        el.getContext('2d').drawImage(img, 0, 0);
        el.naturalWidth = el.width; el.naturalHeight = el.height; el.complete = true;
        return {
            el, name: 'photoshop-layer.png', w: el.width, h: el.height,
            srcW: el.width, srcH: el.height, grade: null
        };
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
        return t;
    }

    async function apply() {
        clearLog();
        btnBorder.disabled = true;
        try {
            const src = tempPath('qingframe-source.png');
            const got = await evalScript('qfGetLayerPng(' + JSON.stringify(src) + ')');
            log('导出图层：' + got);
            if (String(got).indexOf('ERR') === 0) return;
            const dm = /OK:(\d+)x(\d+)/.exec(String(got));
            const docW = dm ? Number(dm[1]) : 0;
            const docH = dm ? Number(dm[2]) : 0;

            const image = await loadLayer(src);
            log('图层尺寸：' + image.w + '×' + image.h);
            const template = presetAt();
            // 让引擎按文档比例出图；否则模板自己的画布比例会让成品和文档对不上
            if (docW && docH) template.canvasRatio = docW + ':' + docH;
            log('套用风格：' + (template.templateName || '默认'));

            const A = setupApp(image, template, Math.max(docW || image.w, docH || image.h));
            window.__render(A, false);

            // 输出走 JPEG（质量 95）：带边框的成品不需要 alpha，体积比 PNG 小一个量级
            const data = canvas.toDataURL('image/jpeg', 0.95).split(',')[1] || '';
            if (!data || data.length < 128) throw new Error('渲染结果为空');
            const out = tempPath('qingframe-border.jpg');
            const wr = await writeBase64(out, data);
            const ok = wr === true;
            log('写出结果：' + (ok ? out : ('失败：' + (wr && wr.error || '未知错误'))));
            if (!ok) return;
            const placed = await evalScript('qfPlacePng(' + JSON.stringify(out) + ','
                + JSON.stringify('清框影边框') + ')');
            log('放回文档：' + placed);
        } catch (e) {
            log('失败：' + ((e && e.message) || e));
        } finally {
            btnBorder.disabled = false;
        }
    }

    function init() {
        const list = window.QF_PRESETS || [];
        if (presetSel) {
            presetSel.innerHTML = list.map((p, i) =>
                `<option value="${i}">${String(p.templateName || p._fileName || ('风格 ' + (i + 1))).replace(/</g, '&lt;')}</option>`
            ).join('');
        }
        if (btnBorder) btnBorder.addEventListener('click', () => apply());
        log('就绪；共 ' + list.length + ' 款预设。' + (cs ? '已连接 Photoshop。' : '本机测试模式。'));
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.QF_PS_POC = { apply, evalScript, readBase64, writeBase64, tempPath, loadLayer };
})();
