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
        return new Promise((resolve) => {
            if (window.qfMockHost) return window.qfMockHost.read(path, resolve);
            if (cepFs) cepFs.readFile(path, cep.encoding.Base64, (err, data) => resolve(err ? null : data));
            resolve(null);
        });
    }
    function writeBase64(path, b64) {
        return new Promise((resolve) => {
            if (window.qfMockHost) return window.qfMockHost.write(path, b64, resolve);
            if (cepFs) cepFs.writeFile(path, b64, cep.encoding.Base64, (err) => resolve(!err));
            resolve(false);
        });
    }
    function tempPath(name) {
        if (window.qfMockHost) return window.qfMockHost.tempPath(name);
        let dir = '';
        try { dir = cs.getSystemPath(SystemPath.USER_DATA); } catch (_) {}
        return (dir ? dir.replace(/[\\/]+$/, '') + '/' : '') + name;
    }

    async function loadLayer(path) {
        const b64 = await readBase64(path);
        if (!b64) throw new Error('读不到导出的图层 PNG：' + path);
        const img = new Image();
        await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = () => rej(new Error('图层 PNG 解码失败'));
            img.src = 'data:image/png;base64,' + b64;
        });
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

            const image = await loadLayer(src);
            log('图层尺寸：' + image.w + '×' + image.h);
            const template = presetAt();
            log('套用风格：' + (template.templateName || '默认'));

            const A = setupApp(image, template, Math.max(image.w, image.h));
            window.__render(A, false);

            const data = canvas.toDataURL('image/png').split(',')[1] || '';
            if (!data || data.length < 128) throw new Error('渲染结果为空');
            const out = tempPath('qingframe-border.png');
            const ok = await writeBase64(out, data);
            log('写出结果：' + (ok ? out : '失败'));
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
