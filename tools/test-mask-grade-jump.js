// 蒙版调色时照片跳跃(位置/大小突变)回归：
// 根因是 renderToCanvas 的「后备尺寸变化即自动 fitZoom」在调色滑块手势期被误触发。
// 拖调色滑块会触发 beginGesture → displayMax 临时降到 900、松手复原 1800，画布后备尺寸随之变化；
// 旧守卫只看 selectedEls(空)，蒙版选择不属于元素选择，于是 fitZoom 被调用，
// 把用户的平移/缩放回退成「适应窗口」，照片即发生位置/大小突变(跳跃)。
// 修复后只在「内容基尺寸(_canvasBaseW/H)变化」时重新适配，
// displayMax/DPR/exportScale 这类只改分辨率的调整不再触发 fitZoom。
// 复现：选中照片→平移/缩放(非适应)→加蒙版→beginGesture→setGrade→endGesture，
// 期间 fitZoom 不应被调用、zoom/pan 不应改变；而真实内容尺寸变化(换不同尺寸底图)仍应触发 fitZoom。
// 用法：node tools/run-electron.js tools/test-mask-grade-jump.js
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
    c.width = w || 600; c.height = h || 400;
    const g = c.getContext('2d');
    g.fillStyle = '#808080'; g.fillRect(0, 0, c.width, c.height);
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
    // 同步合成补丁（与 test-grade-intermittent.js 一致），避免隐藏窗口 rAF 节流导致采样同一帧
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

    // ── 场景 A：蒙版激活 + 调色滑块手势,fitZoom 不得被触发,zoom/pan 不得改变 ──
    const sA = await exec(`(async () => {
        const A = window.App;
        window.__fitZoomCalls = 0;
        const _fz = A.fitZoom.bind(A);
        A.fitZoom = function () { window.__fitZoomCalls++; return _fz.apply(this, arguments); };

        const el = await window.__mk(1200, 800);
        const im = { el, name: 'm1', path: null, w: 1200, h: 800, exif: {}, customSettings: null, grade: null };
        A.images = [im]; A.image = im; A.currentIdx = 0;
        A.template = A.defaultTemplate(); A.setTpl(im, A.template);
        A.setGrade({ exp: 1, con: 0, sat: 0, temp: 0, tint: 0, hi: 0, sh: 0 }, { full: true });
        A.addMask('ellipse');
        const id = A._activeMaskId;
        A.setActiveMask(id);

        // 先渲染一帧,让 _canvasBaseW/H 写入(此前 prev 为 0,自动适配守卫不触发)
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 80));

        // 模拟用户为摆蒙版而平移/缩放(非适应状态),这是跳跃最容易被察觉的现场
        A._followFit = false;
        A.zoom = 1.6; A.panX = 40; A.panY = 24;
        A.applyZoomStyle();

        const before = { zoom: A.zoom, panX: A.panX, panY: A.panY, calls: window.__fitZoomCalls };

        // 复刻拖调色滑块的手势:pointerdown→input→pointerup
        A.beginGesture();                       // displayMax 降到 900
        A.setGrade({ exp: 0.5 }, {});           // 调色 + 重渲(后备尺寸变化)
        await new Promise((r) => setTimeout(r, 60));
        A.endGesture();                         // displayMax 复原 1800 + 重渲
        await new Promise((r) => setTimeout(r, 140)); // 让任何 rAF(fitZoom) 真正跑完

        const after = { zoom: A.zoom, panX: A.panX, panY: A.panY, calls: window.__fitZoomCalls };
        return { before, after, hadMask: !!id };
    })()`);
    check(sA.hadMask, '场景A前置:蒙版已添加并激活', JSON.stringify(sA));
    check(sA.after.calls === sA.before.calls,
        '蒙版调色手势期间 fitZoom 未被触发(修复前会被调用→照片跳跃)', `calls ${sA.before.calls}→${sA.after.calls}`);
    check(sA.after.zoom === sA.before.zoom && sA.after.panX === sA.before.panX && sA.after.panY === sA.before.panY,
        '蒙版调色手势期间 zoom/pan 保持不变(照片不发生位置/大小突变)',
        `zoom ${sA.before.zoom}→${sA.after.zoom}, pan ${sA.before.panX},${sA.before.panY}→${sA.after.panX},${sA.after.panY}`);

    // ── 场景 B(健全性):真实内容尺寸变化(换不同尺寸底图)仍应触发 fitZoom ──
    const sB = await exec(`(async () => {
        const A = window.App;
        const callsBefore = window.__fitZoomCalls;
        const el2 = await window.__mk(2000, 1400);   // 不同尺寸
        A.image.el = el2; A.image.w = 2000; A.image.h = 1400;
        if (A.invalidateGrade) A.invalidateGrade(A.image);
        if (A.rebuildGrade) A.rebuildGrade('full');
        A.scheduleRender(true);
        await new Promise((r) => setTimeout(r, 140)); // 让 rAF(fitZoom) 跑完
        return { callsBefore, callsAfter: window.__fitZoomCalls };
    })()`);
    check(sB.callsAfter > sB.callsBefore,
        '健全性:换不同尺寸底图后内容基尺寸变化,fitZoom 仍被触发(自动适配未被误杀)',
        `calls ${sB.callsBefore}→${sB.callsAfter}`);

    await win.close();
    app.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); app.exit(2); });
