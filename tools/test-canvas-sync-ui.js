// 照片/边框画幅自动同步 —— UI 绑定层回归(真实 Electron 渲染进程)
//   node tools/run-electron.js tools/test-canvas-sync-ui.js
//
// 验证:
//  ① 开关存在且默认关闭
//  ② 勾选 cbCanvasSync → syncModelFromUI → template.canvasSync === 1
//  ③ 勾选 + 画布比例 1:1 → 渲染后照片 cover 内容区(photoRect 覆盖内容区,比例=原图)
//  ④ 取消勾选 → photoRect 回到完整原图比例(不放大)
//  ⑤ template.canvasSync=1 → syncUI 回显勾选状态
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

const MAKE_IMAGE = `async (w, h) => {
    const c = document.createElement('canvas');
    c.width = w || 800; c.height = h || 500;
    const g = c.getContext('2d');
    g.fillStyle = '#c33'; g.fillRect(0, 0, c.width, c.height);
    const el = new Image();
    await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
    return el;
}`;

async function main() {
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
    const exec = (expr) => win.webContents.executeJavaScript(expr);
    await exec(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(1200);

    // 造 800×500 (8:5) 图并摆成已导入状态
    const s = await exec(`(async () => {
        const A = window.App;
        const makeImage = ${MAKE_IMAGE};
        const el = await makeImage(800, 500);
        const im = { el, name: '同步测试.png', path: null, w: 800, h: 500, exif: {}, customSettings: null };
        A.images = [im]; A.image = im; A.currentIdx = 0;
        A.selectedIdx = [0]; A.batchSel = [0];
        A.template = A.defaultTemplate();
        A.setTpl(im, A.template);
        A.updateEmptyState();
        A.scheduleRender(true);
        return { w: el.naturalWidth, h: el.naturalHeight };
    })()`);
    check(s.w === 800 && s.h === 500, '造图 800×500 已导入', `w=${s.w} h=${s.h}`);

    /* ① 开关存在且默认关闭 */
    const box = await exec(`(() => {
        const b = document.getElementById('cbCanvasSync');
        if (!b) return { exists: false };
        const row = document.getElementById('rowCanvasSync');
        return { exists: true, checked: b.checked, inCanvasTab: !!b.closest('#panel-canvas'),
                 label: row ? row.textContent.trim().replace(/\\s+/g, ' ') : '' };
    })()`);
    check(box.exists && box.inCanvasTab, '① 开关存在于画布 Tab', `inCanvas=${box.inCanvasTab}`);
    check(box.checked === false, '① 开关默认关闭(保持原行为)', `checked=${box.checked}`);

    /* ② 勾选 → syncModelFromUI → template.canvasSync === 1 */
    const on = await exec(`(async () => {
        const A = window.App;
        const b = document.getElementById('cbCanvasSync');
        b.checked = true;
        A.syncModelFromUI();
        return { canvasSync: A.template.canvasSync };
    })()`);
    check(on.canvasSync === 1, '② 勾选后模型 canvasSync=1', `canvasSync=${on.canvasSync}`);

    /* ③ 勾选 + 1:1 画布 → 渲染后照片 cover 内容区(photoRect 覆盖,无留白) */
    const renderOn = await exec(`(async () => {
        const A = window.App;
        const ratio = document.getElementById('cbCanvasRatio');
        ratio.value = '1:1';
        A.syncModelFromUI();
        A.template.canvasSync = 1;
        A.refreshUI();
        A.scheduleRender(true);
        await A.flushRender();
        await new Promise((r) => setTimeout(r, 120));
        const cv = A.dom.canvas;
        const pr = A._photoRect || {};
        const t = A.template;
        // 逻辑画布尺寸(_logW/_logH)与 photoRect 同空间;canvas.width 是 DPR×2 的像素缓冲
        const L = { w: cv._logW || cv.width, h: cv._logH || cv.height };
        const usableW = L.w - (t.baseMargin.marginLeft || 0) - (t.baseMargin.marginRight || 0);
        const usableH = L.h - (t.baseMargin.marginTop || 0) - (t.baseMargin.marginBottom || 0);
        return { cw: cv.width, ch: cv.height, logW: L.w, logH: L.h,
                 rect: { x: pr.x, y: pr.y, w: pr.w, h: pr.h },
                 usableW, usableH, checked: document.getElementById('cbCanvasSync').checked,
                 ratio: L.w / L.h, canvasRatio: A.template.canvasRatio,
                 pf: A.template.photoFrameStyle, canvasSync: A.template.canvasSync,
                 imgScale: t.baseMargin.imgScale };
    })()`);
    const r43 = renderOn.rect;
    check(Math.abs(renderOn.ratio - 1) < 0.02, '③ 画布按 1:1 补齐', `canvasRatio=${renderOn.ratio.toFixed(3)}`);
    check(r43.w >= renderOn.usableW - 1 && r43.h >= renderOn.usableH - 1,
        '③ 照片 cover 内容区(无留白)', `rect=${r43.w.toFixed(0)}×${r43.h.toFixed(0)} vs content=${renderOn.usableW.toFixed(0)}×${renderOn.usableH.toFixed(0)}`);
    check(Math.abs(r43.w / r43.h - 800 / 500) < 0.01,
        '③ cover 不变形(比例=原图 8:5)', `rectRatio=${(r43.w / r43.h).toFixed(3)}`);
    check(renderOn.checked === true, '③ syncUI 回显勾选态', `checked=${renderOn.checked}`);

    /* ④ 取消勾选 → 照片回到完整原图比例,不放大 */
    const off = await exec(`(async () => {
        const A = window.App;
        const b = document.getElementById('cbCanvasSync');
        b.checked = false;
        A.syncModelFromUI();
        A.scheduleRender(true);
        await A.flushRender();
        await new Promise((r) => setTimeout(r, 120));
        const cv = A.dom.canvas;
        const pr = A._photoRect || {};
        const t = A.template;
        const L = { w: cv._logW || cv.width, h: cv._logH || cv.height };
        const usableW = L.w - (t.baseMargin.marginLeft || 0) - (t.baseMargin.marginRight || 0);
        const usableH = L.h - (t.baseMargin.marginTop || 0) - (t.baseMargin.marginBottom || 0);
        return { rect: { x: pr.x, y: pr.y, w: pr.w, h: pr.h }, canvasSync: A.template.canvasSync,
                 usableW, usableH, ratio: L.w / L.h };
    })()`);
    check(off.canvasSync === 0, '④ 取消后模型 canvasSync=0', `canvasSync=${off.canvasSync}`);
    check(Math.abs(off.rect.w / off.rect.h - 800 / 500) < 0.01,
        '④ 照片恢复完整 8:5 比例', `rectRatio=${(off.rect.w / off.rect.h).toFixed(3)}`);
    check(off.rect.w <= off.usableW + 1 && off.rect.h <= off.usableH + 1,
        '④ 照片不再放大超出内容区', `rect=${off.rect.w.toFixed(0)}×${off.rect.h.toFixed(0)} vs content=${off.usableW.toFixed(0)}×${off.usableH.toFixed(0)}`);

    /* ⑤ 模板自带 canvasSync=1 → syncUI 勾选回显 */
    const echo = await exec(`(() => {
        const A = window.App;
        A.template.canvasSync = 1;
        A.refreshUI();
        return { checked: document.getElementById('cbCanvasSync').checked };
    })()`);
    check(echo.checked === true, '⑤ 模型 canvasSync=1 时 UI 回显勾选', `checked=${echo.checked}`);

    app.quit();
    if (failures.length) {
        console.log(`FAILED: ${failures.length}`);
        app.exit(1);
    } else {
        console.log('ALL PASS');
        app.exit(0);
    }
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
