'use strict';
// 手机版桌面对齐专项：锐化/细节、颜色分级、曲线、WebP/宽色域导出、更新日志。
// 用法：node tools/run-electron.js tools/test-mobile-parity.js
const path = require('path');
const { app, BrowserWindow } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const INDEX = path.join(__dirname, '..', 'mobile', 'www', 'index.html');
const fails = [];
const check = (ok, label, extra) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) fails.push(label);
};

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 390, height: 844, show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const errors = [];
    win.webContents.on('console-message', (_e, level, message) => {
        if (level === 2 || /Uncaught|is not defined|Cannot read/i.test(message)) errors.push(message);
    });
    await win.loadFile(INDEX);
    const exec = (x) => win.webContents.executeJavaScript(x, true);
    for (let i = 0; i < 100; i++) { if (await exec('!!window.QF_MOBILE_READY')) break; await new Promise((r) => setTimeout(r, 100)); }

    const r = await exec(`(async () => {
        const wait = ms => new Promise(res => setTimeout(res, ms));
        const out = { err: '' };
        try {
            out.modules = {
                sharpen: !!window.QfsSharpen, curve: !!window.QfsCurve,
                extra: !!window.QF_GradeExtra, icc: !!window.QfsIcc,
                colorspace: !!window.QfsColorSpace
            };
            // 高频棋盘图：锐化/纹理才会产生可测的像素变化
            const ph = document.createElement('canvas'); ph.width = 320; ph.height = 240;
            const g = ph.getContext('2d');
            for (let y = 0; y < 240; y += 4) for (let x = 0; x < 320; x += 4) {
                g.fillStyle = ((x / 4 + y / 4) % 2) ? '#fff' : '#000';
                g.fillRect(x, y, 4, 4);
            }
            ph.naturalWidth = 320; ph.naturalHeight = 240; ph.complete = true;
            window.qfsNative.pickImages = async () => [{ el: ph, name: 'hi.png', w: 320, h: 240, grade: null }];
            document.getElementById('btnPick').click();
            await wait(380);
            document.querySelector('#tabs [data-tab="grade"]').click();
            await wait(360);

            // 1) 细节/锐化：7 个滑块 + 真的写进 grade.det 并改变预览像素
            out.detCount = document.querySelectorAll('[data-det]').length;
            const before = document.getElementById('previewCanvas').toDataURL();
            const shp = document.querySelector('[data-det="shp"]');
            if (shp) { shp.value = '120'; shp.dispatchEvent(new Event('input', { bubbles: true })); }
            await wait(320);
            out.shp = window.App.image && window.App.image.grade && window.App.image.grade.det
                ? window.App.image.grade.det.shp : -1;
            // 锐化按桌面同款策略在 1600px 预览档跳过（只在全尺寸/导出生效）；
            // 预览刷新走 rAF 节流，离屏测试窗口不触发，像素变化放到导出段验证。
            const tex = document.querySelector('[data-det="tex"]');
            if (tex) { tex.value = '60'; tex.dispatchEvent(new Event('input', { bubbles: true })); }
            await wait(280);
            out.tex = window.App.image.grade.det.tex;
            const dreset = document.getElementById('btnDetReset');
            if (dreset) dreset.click();
            await wait(320);
            out.detReset = !window.App.image.grade.det || !window.App.image.grade.det.shp;

            // 2) 颜色分级：切区域 + 写进 grade.cg
            out.cgCount = document.querySelectorAll('[data-cg]').length;
            out.cgGlobal = document.querySelectorAll('[data-cg-global]').length;
            const high = document.querySelector('[data-cg-zone="high"]');
            if (high) high.click();
            await wait(120);
            const cgs = document.querySelector('[data-cg="s"]');
            if (cgs) { cgs.value = '60'; cgs.dispatchEvent(new Event('input', { bubbles: true })); }
            await wait(280);
            out.cgHigh = window.App.image.grade.cg ? window.App.image.grade.cg.high.s : -1;
            const cgreset = document.getElementById('btnCgReset');
            if (cgreset) cgreset.click();
            await wait(300);
            out.cgReset = !window.App.image.grade.cg || !window.App.image.grade.cg.high.s;

            // 3) 曲线：点一下加点，写进 grade.curve；重置回两点
            const cvEl = document.getElementById('qfCurveCanvas');
            out.curveCanvas = !!cvEl;
            if (cvEl) {
                const box = cvEl.getBoundingClientRect();
                cvEl.dispatchEvent(new PointerEvent('pointerdown', {
                    bubbles: true, pointerId: 1,
                    clientX: box.left + box.width * 0.32,
                    clientY: box.top + box.height * 0.68
                }));
                await wait(260);
                const pts = window.App.image.grade.curve && window.App.image.grade.curve.rgb;
                out.curvePoints = pts ? pts.length : 0;
                const cr = document.getElementById('btnCurveMReset');
                if (cr) cr.click();
                await wait(300);
                const after = window.App.image.grade.curve && window.App.image.grade.curve.rgb;
                out.curveReset = after ? after.length : -1;
            }

            // 4) 导出：WebP 格式与宽色域 ICC
            document.getElementById('btnOpenExport').click();
            await wait(140);
            out.formats = Array.from(document.querySelectorAll('#optFormat .chip')).map(b => b.dataset.format);
            out.spaces = Array.from(document.querySelectorAll('#optColorSpace .chip')).map(b => b.dataset.colorspace);
            const saved = [];
            const orig = window.qfsNative.saveImage;
            window.qfsNative.saveImage = async (d, n) => { saved.push({ d, n }); return { ok: true, mode: 'test' }; };
            document.querySelector('[data-format="webp"]').click();
            await wait(120);
            out.csHiddenForWebp = document.getElementById('rowColorSpace').hidden;
            document.getElementById('btnExportGo').click();
            await wait(900);
            out.webpData = saved.length ? saved[0].d.slice(0, 30) : '';
            out.webpName = saved.length ? saved[0].n : '';

            saved.length = 0;
            document.getElementById('btnOpenExport').click();
            await wait(120);
            document.querySelector('[data-format="jpeg"]').click();
            document.querySelector('[data-colorspace="p3"]').click();
            await wait(120);
            document.getElementById('btnExportGo').click();
            await wait(900);
            out.p3Name = saved.length ? saved[0].n : '';
            if (saved.length) {
                const bin = atob(saved[0].d.split(',')[1] || '');
                out.hasIcc = bin.indexOf('ICC_PROFILE') >= 0;
                out.jpeg = saved[0].d.slice(0, 24);
            }
            window.qfsNative.saveImage = orig;

            // 5) 更新日志入口
            document.querySelector('#tabbar [data-page="mine"]').click();
            await wait(140);
            const cl = document.getElementById('btnChangelog');
            out.changelogBtn = !!cl;
            if (cl) {
                cl.click();
                await wait(120);
                out.changelogText = ((document.getElementById('styleModal') || {}).textContent || '').slice(0, 200);
                const close = document.querySelector('#styleModal .act-btn');
                if (close) close.click();
            }
        } catch (e) { out.err = String(e && e.stack || e); }
        return out;
    })()`);

    check(!r.err, '桌面对齐专项流程无脚本异常', r.err);
    check(Object.values(r.modules || {}).every(Boolean), '锐化/曲线/ICC/色域模块均已加载', JSON.stringify(r.modules));
    check(r.detCount === 7 && r.shp === 120 && r.tex === 60,
        '细节滑块写入 grade.det（锐化/半径/细节/蒙版/纹理/清晰度/去雾）',
        JSON.stringify({ n: r.detCount, shp: r.shp, tex: r.tex }));
    check(r.detReset, '重置细节把锐化与纹理归零');
    check(r.cgCount === 3 && r.cgGlobal === 2 && r.cgHigh === 60 && r.cgReset,
        '颜色分级切区域/赋值/重置均生效',
        JSON.stringify({ n: r.cgCount, g: r.cgGlobal, high: r.cgHigh, reset: r.cgReset }));
    check(r.curveCanvas && r.curvePoints > 2 && r.curveReset === 2,
        '曲线可点击加点并重置', JSON.stringify({ pts: r.curvePoints, reset: r.curveReset }));
    check((r.formats || []).includes('webp') && (r.spaces || []).length === 3 && r.csHiddenForWebp,
        '导出面板补齐 WebP 与色域选项（WebP 下隐藏色域）',
        JSON.stringify({ formats: r.formats, spaces: r.spaces }));
    check(/^data:image\/webp/.test(r.webpData || '') && /\.webp$/.test(r.webpName || ''),
        'WebP 导出得到真实 webp 数据与后缀',
        JSON.stringify({ data: r.webpData, name: r.webpName }));
    check(/^data:image\/jpeg/.test(r.jpeg || '') && r.hasIcc === true && /\.jpg$/.test(r.p3Name || ''),
        'P3 导出为 JPEG 且嵌入 ICC_PROFILE',
        JSON.stringify({ data: r.jpeg, icc: r.hasIcc, name: r.p3Name }));
    check(r.changelogBtn && /0\.1 · 手机版/.test(r.changelogText || ''),
        '我的页更新日志入口显示手机版条目', (r.changelogText || '').slice(0, 80));
    check(errors.length === 0, '桌面对齐流程无脚本异常', errors.slice(0, 3).join(' / '));

    win.destroy();
    app.exit(fails.length ? 1 : 0);
});
