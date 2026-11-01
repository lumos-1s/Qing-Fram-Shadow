// 「对比原图后，加过边框的图变小」回归：
// 症状：按住空格（或点对比）看原图，松手后整张带边框的画布明显缩小。
// 根因：对比分支把画布临时改成原图尺寸（6000px），又调用 fitZoom() 重算 zoom
//       并写进 this.zoom（≈0.13）；松手回到边框态，画布逻辑宽度只有 1800px，
//       仍按 0.13 显示 → 1800×0.13≈240px，看起来就是缩成一小块。
// 修复：对比态不改 zoom，逻辑尺寸按「边框态同一个 uiScale」折算，照片屏幕尺寸不变。
// 用法：node tools/run-electron.js tools/test-compare-zoom.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR)
    .filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name.replace(/\.json$/, '') + '.json'), 'utf8')); } catch (_) { return null; }
});
const EMPTY_LIST = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers']) ipcMain.handle(c, EMPTY_LIST);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install',
    'open-wall-covers-dir']) ipcMain.handle(c, OK);
for (const c of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files',
    'read-exif', 'open-image']) ipcMain.handle(c, CANCEL);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('load-acr-tables', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.22', electron: '31', chrome: '126', node: '20',
    platform: 'win32', arch: 'x64', packaged: false, portable: false,
    userData: process.env.TEMP, appPath: ROOT
}));

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

const MAKE_IMAGE = `async (w, h, color) => {
    const c = document.createElement('canvas');
    c.width = w || 600; c.height = h || 400;
    const g = c.getContext('2d');
    g.fillStyle = color || '#808080'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(255,255,255,.35)';
    g.fillRect(c.width * 0.2, c.height * 0.2, c.width * 0.6, c.height * 0.6);
    const el = new Image();
    await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
    return el;
}`;

async function main() {
    await app.whenReady();
    const win = new BrowserWindow({
        width: 1280, height: 900, show: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload-about.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.stage)')) break;
        await sleep(200);
    }
    const exec = (expr) => win.webContents.executeJavaScript(expr);

    // 同步渲染补丁：隐藏/节流的 rAF 会让采样落在同一帧
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

    // 一张比 displayMax 大的图 + 带边距的默认模板：边框态画布 1800 级别，原图 3000 级别
    const s = await exec(`(async () => {
        const A = window.App;
        const el = await window.__mk(3000, 2000, '#3c6e5a');
        const im = { el, name: 'big', path: null, w: 3000, h: 2000, exif: {}, customSettings: null,
            _grade: { neutral: true, canvas: null, low: null, lowKey: '', fullKey: '' } };
        A.images = [im]; A.image = im; A.currentIdx = 0; A.batchSel = [0];
        A.template = A.defaultTemplate();
        A.selectedEls = [];
        A.displayMax = 1800;
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 80));
        A.fitZoom();
        const cv = A.dom.canvas;

        const before = {
            zoom: A.zoom,
            cssW: parseFloat(cv.style.width) || 0,
            cssH: parseFloat(cv.style.height) || 0,
            backingW: cv.width,
            logW: cv._logW
        };

        // 进入对比（等价于按住空格）
        A.setCompare(true);
        await new Promise((r) => setTimeout(r, 80));
        const during = {
            zoom: A.zoom,
            cssW: parseFloat(cv.style.width) || 0,
            backingW: cv.width,
            logW: cv._logW,
            dragging: !!A.draggingCompare
        };

        // 松手回到边框态
        A.setCompare(false);
        await new Promise((r) => setTimeout(r, 120));
        const after = {
            zoom: A.zoom,
            cssW: parseFloat(cv.style.width) || 0,
            cssH: parseFloat(cv.style.height) || 0,
            backingW: cv.width,
            logW: cv._logW
        };
        return { before, during, after, photoW: el.naturalWidth };
    })()`);

    const { before, during, after } = s;
    console.log('采样:', JSON.stringify(s));

    check(before.zoom > 0 && before.cssW > 100,
        '前置：边框态已正常适配（有 zoom 与可见宽度）', JSON.stringify(before));
    check(during.backingW === s.photoW,
        '对比态画布按原图尺寸渲染', `${during.backingW} vs ${s.photoW}`);
    check(Math.abs(during.zoom - before.zoom) < 1e-6,
        '对比态不修改用户缩放', `${before.zoom} → ${during.zoom}`);
    check(Math.abs(after.zoom - before.zoom) < 1e-6,
        '松手后缩放回到原值（核心回归）', `${before.zoom} → ${after.zoom}`);
    check(Math.abs(after.cssW - before.cssW) <= 1 && Math.abs(after.cssH - before.cssH) <= 1,
        '松手后画布显示尺寸与对比前一致（不再缩小）',
        `before ${before.cssW}×${before.cssH} → after ${after.cssW}×${after.cssH}`);

    await win.close();
    app.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); app.exit(2); });
