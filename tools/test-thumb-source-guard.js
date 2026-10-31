// 胶片条缩略图「必须来自当前底图」回归：
// 症状：切图后缩略图与画布不是同一张照片（缩略图是旧图/别的图）。
// 根因：im.thumb 是异步渲染的成品预览，若底图换过（旋转/裁切/还原）或渲染串了对象，
//       旧 thumb 仍会被 buildThumbnails 当成当前照片显示。
// 修复：renderFramedThumb 记录 im._thumbEl = 渲染时用的 el；buildThumbnails 只认
//       _thumbEl === im.el 的缩略图，对不上就丢弃、先用原图占位并重排一张。
// 用法：node tools/run-electron.js tools/test-thumb-source-guard.js
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
    await exec(`window.__mk = ${MAKE_IMAGE}; true`);

    // ── A：串图缩略图（thumb 指向另一张图）必须被丢弃，先用当前原图占位，再重排 ──
    const sA = await exec(`(async () => {
        const A = window.App;
        const elA = await window.__mk(600, 400, '#c03030');   // 红：当前图
        const elB = await window.__mk(600, 400, '#3050c0');   // 蓝：另一张
        const make = (el, name) => ({ el, name, path: null, w: 600, h: 400, exif: {}, customSettings: null,
            _grade: { neutral: true, canvas: null, low: null, lowKey: '', fullKey: '' } });
        const a = make(elA, 'A'), b = make(elB, 'B');
        A.images = [a, b]; A.image = a; A.currentIdx = 0; A.batchSel = [0];
        A.template = A.defaultTemplate();

        // 模拟串图：a.thumb 实际是 B 渲染的
        a.thumb = elB.src;
        a._thumbEl = elB;

        A.buildThumbnails();
        const first = document.querySelector('#thumbStrip .thumb');
        const usedWrong = first && first.src === elB.src;
        const usedRaw = first && first.src === elA.src;
        const dropped = a.thumb === null;

        // 等后台队列重排完：必须重新变成一张由 elA 渲染的成品缩略图
        await new Promise((r) => setTimeout(r, 500));
        const reRendered = !!a.thumb && a.thumb !== elB.src;
        const sourceOk = a._thumbEl === a.el;
        const domOk = first && first.src === a.thumb;
        return { usedWrong, usedRaw, dropped, reRendered, sourceOk, domOk };
    })()`);
    check(sA.dropped === true, '串图缩略图被丢弃(thumb 置空)', 'dropped=' + sA.dropped);
    check(sA.usedRaw === true && sA.usedWrong === false,
        '丢弃后先用当前原图占位(不是另一张图的缩略图)', JSON.stringify(sA));
    check(sA.reRendered && sA.sourceOk && sA.domOk,
        '后台重排后缩略图来自当前 el，且回写到胶片条',
        JSON.stringify({ reRendered: sA.reRendered, sourceOk: sA.sourceOk, domOk: sA.domOk }));

    // ── B：正常的成品缩略图（_thumbEl === el）必须保留，不能被误杀 ──
    const sB = await exec(`(() => {
        const A = window.App;
        const a = A.images[0];
        const fake = 'data:image/png;base64,AAAA';
        a.thumb = fake; a._thumbEl = a.el;
        A.buildThumbnails();
        const first = document.querySelector('#thumbStrip .thumb');
        return { kept: first && first.src === fake, thumb: a.thumb === fake };
    })()`);
    check(sB.kept && sB.thumb, '来源匹配的缩略图保持原样(不会被重置)', JSON.stringify(sB));

    // ── C：旋转换底图后，旧缩略图必须立即失效并重排 ──
    const sC = await exec(`(async () => {
        const A = window.App;
        const a = A.images[0];
        const oldEl = a.el;
        await A.rotateCurrentPhoto();
        const newEl = a.el;
        const cleared = a.thumb === null && a._thumbEl === null;
        const elChanged = newEl !== oldEl;
        await new Promise((r) => setTimeout(r, 500));
        return { cleared, elChanged, sourceOk: a._thumbEl === a.el, hasThumb: !!a.thumb };
    })()`);
    check(sC.elChanged && sC.cleared,
        '旋转换底图后旧缩略图立即失效', JSON.stringify(sC));
    check(sC.sourceOk && sC.hasThumb,
        '旋转后重新排出的缩略图绑定新底图', JSON.stringify(sC));

    await win.close();
    app.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); app.exit(2); });
