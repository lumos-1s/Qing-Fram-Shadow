// 蒙版「原图预览」回归：
// 加亮度/颜色蒙版时自动显示未调色原图（模板/边框保留），并给出明确提示与返回入口；
// 不能静默换图（用户会当成调色丢了），也不能污染导出/缩略图。
// 覆盖：
//   A. 已调色 + 加亮度蒙版 → 自动进入预览；主画布取到的亮度回到原图；浮层/复选框同步
//   B. 返回调色 → 恢复调色结果，浮层隐藏
//   C. 预览中再加椭圆蒙版 → 自动退出预览（预览只服务亮度/颜色）
//   D. 未调色 + 加亮度蒙版 → 不进入预览（没有可对比的差异，避免无意义提示）
//   E. 主预览渲染结束后 _previewUseOriginal 必须复位（导出/缩略图不会误用未调色源）
// 用法：node tools/run-electron.js tools/test-mask-original-preview.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_event, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name.replace(/\.json$/, '') + '.json'), 'utf8')); } catch (_) { return null; }
});
const EMPTY_LIST = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });
for (const channel of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers']) ipcMain.handle(channel, EMPTY_LIST);
for (const channel of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install',
    'open-wall-covers-dir']) ipcMain.handle(channel, OK);
for (const channel of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files',
    'read-exif', 'open-image']) ipcMain.handle(channel, CANCEL);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('load-acr-tables', () => {
    try {
        const zlib = require('zlib');
        const raw = fs.readFileSync(path.join(ROOT, 'shared', 'acr', 'cr-tables.bin'));
        if (raw.slice(0, 4).toString('ascii') !== 'CRT4') return null;
        const planes = zlib.inflateSync(raw.slice(10));
        return { size: raw.readUInt16LE(4), count: raw.readUInt16LE(6), step: raw.readUInt16LE(8),
            data: planes.buffer.slice(planes.byteOffset, planes.byteOffset + planes.byteLength) };
    } catch (_) { return null; }
});
ipcMain.handle('get-app-info', () => ({
    version: '0.1.21', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT
}));

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

// 纯色底图：中间像素的亮度可精确预测，方便判断当前画布是原图还是压暗后的调色结果
const MAKE_IMAGE = `async (w, h, color) => {
    const c = document.createElement('canvas');
    c.width = w || 600; c.height = h || 400;
    const g = c.getContext('2d');
    g.fillStyle = color || '#808080'; g.fillRect(0, 0, c.width, c.height);
    const el = new Image();
    await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
    return el;
}`;

async function main() {
    await app.whenReady();
    const win = new BrowserWindow({
        width: 1280, height: 900, show: false, paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(500);
    win.showInactive();
    const exec = (expr) => win.webContents.executeJavaScript(expr);

    await exec(`(async () => { if (window.QfsAcr) await QfsAcr.ensure(); return QfsAcr && QfsAcr.ready(); })()`)
        .then((r) => console.log('ACR tables ready=' + r));
    // 同步合成补丁：隐藏窗口 rAF 会被节流，采样会落在同一帧
    await exec(`(() => {
        const A = window.App;
        if (!A || A.__syncRenderPatched) return true;
        A.__syncRenderPatched = true;
        const orig = A.scheduleRender.bind(A);
        let busy = false;
        A.scheduleRender = function (immediate) {
            orig(immediate);
            if (busy) return;
            busy = true;
            try { A._renderDirty = true; if (typeof A._drainRenderQueue === 'function') A._drainRenderQueue(); }
            finally { busy = false; }
        };
        return true;
    })()`);
    await exec(`window.__mk = ${MAKE_IMAGE}; true`);

    // ── A/B：已调色 + 亮度蒙版 → 自动预览原图；返回调色恢复 ──
    const sAB = await exec(`(async () => {
        const A = window.App;
        const el = await window.__mk(600, 400, '#be8246');
        const im = { el, name: 'p1', path: null, w: 600, h: 400, exif: {}, customSettings: null, grade: null };
        A.images = [im]; A.image = im; A.currentIdx = 0;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        // 压暗 60 档：原图与调色结果的亮度差足够大，采样不会模棱两可
        A.setGrade({ exp: -60, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 140));

        const lumAt = () => {
            const cv = A.dom.canvas, base = A._baseSize(), pr = A._photoRect;
            if (!cv || !pr) return -1;
            const k = cv.width / Math.max(1, base.w);
            const d = cv.getContext('2d').getImageData(
                Math.round((pr.x + pr.w / 2) * k),
                Math.round((pr.y + pr.h / 2) * k), 1, 1).data;
            return Math.round(0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2]);
        };
        const lumGraded = lumAt();

        A.addMask('lum');
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 140));
        const lumPreview = lumAt();
        const onFlag = A._maskPreviewOriginal;
        const hint = document.getElementById('maskOrigHint');
        const hintShown = !!hint && hint.hidden === false;
        const cbChecked = !!document.getElementById('cbMaskViewOrig')
            && document.getElementById('cbMaskViewOrig').checked;
        const transientAfter = A._previewUseOriginal;   // 帧结束后必须复位

        A.setMaskOriginalPreview(false);
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 140));
        const lumBack = lumAt();
        const hintHidden = !!hint && hint.hidden === true;
        return { lumGraded, lumPreview, lumBack, onFlag, hintShown, cbChecked, hintHidden, transientAfter };
    })()`);
    check(sAB.onFlag === true, '加亮度蒙版 → 自动进入原图预览', 'flag=' + sAB.onFlag);
    check(sAB.hintShown === true && sAB.cbChecked === true,
        '原图预览有明确提示(浮层可见、查看原图勾选)', JSON.stringify({ hint: sAB.hintShown, cb: sAB.cbChecked }));
    check(sAB.lumPreview > sAB.lumGraded + 25,
        '原图预览确实换回未调色源(画布中心亮度回到原图)',
        `graded=${sAB.lumGraded}, preview=${sAB.lumPreview}`);
    check(sAB.lumBack < sAB.lumPreview - 25,
        '点「返回调色」恢复调色结果', `preview=${sAB.lumPreview}, back=${sAB.lumBack}`);
    check(sAB.hintHidden === true, '返回调色后浮层隐藏', 'hidden=' + sAB.hintHidden);
    check(sAB.transientAfter === false,
        '预览帧结束后 _previewUseOriginal 已复位(导出/缩略图不会误用原图)', 'flag=' + sAB.transientAfter);

    // ── C：预览中再加椭圆蒙版 → 自动退出（预览只服务亮度/颜色） ──
    const sC = await exec(`(async () => {
        const A = window.App;
        const im = A.image;
        A.setMaskOriginalPreview(true);
        await new Promise((r) => setTimeout(r, 60));
        const before = A._maskPreviewOriginal;
        A.addMask('radial');
        await new Promise((r) => setTimeout(r, 100));
        const act = A.activeMask(im) || {};
        return { before, after: A._maskPreviewOriginal, type: act.type,
            hintHidden: document.getElementById('maskOrigHint').hidden };
    })()`);
    check(sC.before === true && sC.after === false,
        '预览中再加椭圆蒙版 → 自动退出预览', JSON.stringify(sC));
    check(sC.type === 'radial' && sC.hintHidden === true,
        '切到椭圆后浮层隐藏(不残留原图提示)', JSON.stringify({ type: sC.type, hidden: sC.hintHidden }));

    // ── D：未调色 + 亮度蒙版 → 不进入预览 ──
    const sD = await exec(`(async () => {
        const A = window.App;
        A.resetGrade();
        await new Promise((r) => setTimeout(r, 100));
        A.addMask('lum');
        await new Promise((r) => setTimeout(r, 100));
        return { flag: A._maskPreviewOriginal,
            hintHidden: document.getElementById('maskOrigHint').hidden,
            cb: document.getElementById('cbMaskViewOrig').checked };
    })()`);
    check(sD.flag === false && sD.hintHidden === true && sD.cb === false,
        '未调色时加亮度蒙版不进入预览(没有可对比的差异)', JSON.stringify(sD));

    await win.close();
    app.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); app.exit(2); });
