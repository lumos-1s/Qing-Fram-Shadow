// 调色烘焙「每张图各持一张画布」回归：
// 症状：两张照片串了 —— 切到某张图，画布上显示的却是另一张照片的像素。
// 根因：QfsColor.pass 的 GL 通道返回 app-color-grade.js 里的模块级共享画布 glc，
//       bakeOne 直接把它当成 im._grade.canvas。于是所有照片的烘焙结果指向同一张画布，
//       后烘的图覆盖先烘的，切回去时 selectImage 看到 g.canvas 有值就不再重烘，
//       画布于是显示另一张照片。
// 修复：bakeOne 发现 pass 返回的不是自建画布时，拷一份到自有画布再返回。
// 用法：node tools/run-electron.js tools/test-grade-canvas-isolation.js
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

// 页面侧公共准备：两张纯色图（红/蓝）+ 一份会走调色通道的 grade（vib 保证即使没有
// WebGL/LUT 也会进入 QfsColor.pass 分支），返回取样工具。
const SETUP = `(() => {
    window.__mk = ${MAKE_IMAGE};
    const sample = (src) => {
        const c = document.createElement('canvas');
        c.width = 8; c.height = 8;
        const g = c.getContext('2d');
        g.drawImage(src, 0, 0, 8, 8);
        const d = g.getImageData(4, 4, 1, 1).data;
        return [d[0], d[1], d[2]];
    };
    window.__sampleSrc = sample;
    window.__mkPair = async () => {
        const A = window.App;
        const elA = await window.__mk(600, 400, '#c03030');
        const elB = await window.__mk(600, 400, '#3050c0');
        const make = (el, name) => ({ el, name, path: null, w: 600, h: 400, exif: {}, customSettings: null,
            _grade: { neutral: true, canvas: null, low: null, lowKey: '', fullKey: '' } });
        const a = make(elA, 'A'), b = make(elB, 'B');
        const gradeOf = () => {
            const g = JSON.parse(JSON.stringify(A.gradeOf({})));
            g.exp = -30; g.vib = 20;
            return g;
        };
        a.grade = gradeOf(); b.grade = gradeOf();
        A.images = [a, b]; A.image = a; A.currentIdx = 0; A.batchSel = [0];
        A.template = A.defaultTemplate();
        A.selectedEls = [];
        A.invalidateGrade(a); A.invalidateGrade(b);
        return { a, b };
    };
    return true;
})()`;

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
    // 隐藏窗口 rAF 会被节流：让 scheduleRender 当帧就跑完，采样才落在同一帧
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
    await exec(SETUP);

    // ── A：模拟 GL 通道（永远返回同一张共享画布）时，两张图的烘焙结果必须各自独立 ──
    const sA = await exec(`(async () => {
        const A = window.App;
        const { a, b } = await window.__mkPair();
        const pass = window.QfsColor.pass;
        const shared = document.createElement('canvas');
        // 桩：行为与 app-color-grade.js 的 passGL 一致 —— 同一张画布反复复用，
        // 并且像 glc 一样打上 __qfsShared 标记（bakeOne 靠它判断"必须拷走"）
        shared.__qfsShared = true;
        window.QfsColor.pass = function (src, p, w, h) {
            if (shared.width !== w || shared.height !== h) { shared.width = w; shared.height = h; }
            const g = shared.getContext('2d');
            g.clearRect(0, 0, w, h);
            g.drawImage(src, 0, 0, w, h);
            return shared;
        };
        let ca = null, cb = null, colorA = null, colorB = null, colorAAfterB = null;
        try {
            A.image = a; A.rebuildGrade('full');
            ca = window.photoSrcOf(a);
            colorA = window.__sampleSrc(ca);
            A.image = b; A.rebuildGrade('full');
            cb = window.photoSrcOf(b);
            colorB = window.__sampleSrc(cb);
            // 关键：烘完 b 之后，a 的源不能跟着变（共享画布时会变成 b 的像素）
            colorAAfterB = window.__sampleSrc(window.photoSrcOf(a));
        } finally {
            window.QfsColor.pass = pass;
        }
        return {
            distinct: !!ca && !!cb && ca !== cb,
            colorA, colorB, colorAAfterB,
            aIsRed: colorA && colorA[0] > colorA[2] + 20,
            bIsBlue: colorB && colorB[2] > colorB[0] + 20,
            aStillRed: colorAAfterB && colorAAfterB[0] > colorAAfterB[2] + 20
        };
    })()`);
    check(sA.distinct, '共享 GL 画布下：两张图的烘焙结果不是同一个画布对象', JSON.stringify(sA));
    check(sA.aIsRed && sA.bIsBlue,
        '共享 GL 画布下：各自烘焙出各自照片的像素(A 红 / B 蓝)', JSON.stringify(sA));
    check(sA.aStillRed,
        '烘完 B 之后 A 的源仍是 A（不会被后烘的图覆盖）', JSON.stringify(sA));

    // ── B：真实通道（不桩）也要各自独立，且颜色正确 ──
    const sB = await exec(`(async () => {
        const A = window.App;
        const { a, b } = await window.__mkPair();
        A.image = a; A.rebuildGrade('full');
        A.image = b; A.rebuildGrade('full');
        const ca = window.photoSrcOf(a), cb = window.photoSrcOf(b);
        const colorA = window.__sampleSrc(ca), colorB = window.__sampleSrc(cb);
        return {
            distinct: ca !== cb,
            colorA, colorB,
            aIsRed: colorA[0] > colorA[2] + 20,
            bIsBlue: colorB[2] > colorB[0] + 20
        };
    })()`);
    check(sB.distinct, '真实通道：两张图的烘焙画布互不相同', JSON.stringify(sB));
    check(sB.aIsRed && sB.bIsBlue,
        '真实通道：各自像素正确(A 红 / B 蓝)', JSON.stringify(sB));

    // ── C：切图往返后画布内容必须跟着切（用户可见的症状） ──
    const sC = await exec(`(async () => {
        const A = window.App;
        const { a, b } = await window.__mkPair();
        A.image = a; A.rebuildGrade('full');
        A.image = b; A.rebuildGrade('full');
        A.selectImage(0);
        await new Promise((r) => setTimeout(r, 120));
        const cv = A.dom.canvas, pr = A._photoRect, base = A._baseSize();
        if (!cv || !pr) return { error: 'canvas/photoRect not ready' };
        const k = cv.width / Math.max(1, base.w);
        const d = cv.getContext('2d').getImageData(
            Math.round((pr.x + pr.w / 2) * k),
            Math.round((pr.y + pr.h / 2) * k), 1, 1).data;
        return { r: d[0], g: d[1], b: d[2], imageIsA: A.image === a };
    })()`);
    check(!sC.error && sC.imageIsA, '切图后 currentIdx/this.image 一致', JSON.stringify(sC));
    check(!sC.error && sC.r > sC.b + 20,
        '切到 A 后画布画的是 A(红)，不是上一张 B(蓝)', JSON.stringify(sC));

    await win.close();
    app.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); app.exit(2); });
