// 拖动滑块时的画面必须与松手后「只剩清晰度差别」，不能换布局。
//
// 背景：调色参数一变，app-grade 会先烘一张 1600px 的降采样画布（low 档）给拖动用，
// photoSrcOf 这时返回的就是它。它的 width 只有原图的 1/3.7，而相框样式（engine-styles
// 的 renderPhotoFrame）的版式全按 naturalWidth 算 —— 100 多处 drawImage(img, x, y)
// 是三参数形式，按**位图实际尺寸**落笔，照片就被画成 27% 大小贴在左上角。
// 用户看到的就是「每拖一次滑块，画面缩到左上角，松手又弹回来」。
//
// 这个用例把「全分辨率源」与「1600px 源」各渲一帧，逐像素比：
//   · 布局坏了 → 大面积、大差值（修之前 VHS/哈苏/杂志封面 的 mean 是 100+，70% 像素超 24 级）
//   · 只是降采样 → mean 个位数、超阈值像素 < 5%
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const SRC = process.env.QF_LOWRES_SRC || 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';

// 覆盖三类：曾经坏掉的 3 参数样式、一直正常的显式尺寸样式、无相框的默认管线
const CASES = ['VHS录像带', '哈苏水印', '杂志封面', '拍立得手写', '3D卡片', '液态玻璃', '圆角卡片'];

const LIMIT_MEAN = 8;      // 平均通道差（0..255）
const LIMIT_BIG = 5;       // 差值 > 24 的像素占比（%）

// 自证开关：关掉修复后的尺寸换算，用例必须变红。
// 两种写法都收（`npm run test:lowres:legacy` 走 argv，跨平台不用管 SHELL 语法）。
const LEGACY = process.argv.includes('--legacy') || !!process.env.QF_LOWRES_LEGACY;

const EMPTY = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });

ipcMain.handle('load-acr-tables', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'shared', 'acr', 'cr-tables.bin'));
    const planes = zlib.inflateSync(raw.slice(10));
    return {
        size: raw.readUInt16LE(4), count: raw.readUInt16LE(6), step: raw.readUInt16LE(8),
        data: planes.buffer.slice(planes.byteOffset, planes.byteOffset + planes.byteLength),
    };
});
ipcMain.handle('load-acr-shadows', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'shared', 'acr', 'cr-shadows.bin'));
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
});
ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR)
    .filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name.replace(/\.json$/, '') + '.json'), 'utf8')); }
    catch (_) { return null; }
});
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers']) ipcMain.handle(c, EMPTY);
for (const c of ['save-prefs', 'save-user', 'save-template', 'export-qfs', 'open-external', 'save-diagnostics']) ipcMain.handle(c, OK);
for (const c of ['open-image', 'open-images', 'import-template', 'open-qfs', 'load-template', 'read-exif', 'save-image-base64']) ipcMain.handle(c, CANCEL);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.23', electron: '31', chrome: '126', node: '20',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT
}));

const EXIF = { make: 'SONY', model: 'A7 IV', focal: '85mm', aperture: 'f/1.8', iso: 'ISO 400', shutter: '1/500' };

app.whenReady().then(async () => {
    if (!fs.existsSync(SRC)) {
        console.log('SKIP  找不到样片: ' + SRC + '（可用 QF_LOWRES_SRC 指定）');
        app.exit(0);
        return;
    }
    const w = new BrowserWindow({
        show: false, width: 1200, height: 800,
        webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false }
    });
    await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const url = 'data:image/jpeg;base64,' + fs.readFileSync(SRC).toString('base64');

    for (let i = 0; i < 100; i++) {
        const n = await w.webContents.executeJavaScript('(window.App && window.App.presets) ? window.App.presets.length : 0');
        if (n > 0) break;
        await new Promise((r) => setTimeout(r, 150));
    }

    const rows = await w.webContents.executeJavaScript(`(async () => {
        const A = window.App;
        // 自证：打开旧行为开关，本用例必须变红；否则说明它抓不到这个 bug
        window.QFS_LEGACY_PHOTO_DRAW = ${JSON.stringify(LEGACY)};
        const s = (ms) => new Promise(r => setTimeout(r, ms));
        const out = [];
        A.saveCurrentTemplate = () => {};
        const el = new Image();
        await new Promise((r, j) => { el.onload = r; el.onerror = j; el.src = ${JSON.stringify(url)}; });
        const W = el.naturalWidth, H = el.naturalHeight;
        const im = { name: 'lowres', el, w: W, h: H, exif: ${JSON.stringify(EXIF)}, grade: {} };
        A.images = [im]; A.currentIdx = 0; A.selectedIdx = [0]; A.image = im;
        A.imageTemplates = new Map();
        A.template = A.defaultTemplate();
        A.normalizeTemplate();
        A.refreshUI();
        if (A.closePresetWall) A.closePresetWall(true);
        await s(300);
        // 预览尺寸压小：这条用例只看版式，不看清晰度，跑得快一点
        A.displayMax = 900;

        const small = (cv, n) => {
            const t = document.createElement('canvas');
            t.width = n; t.height = Math.max(1, Math.round(cv.height / cv.width * n));
            t.getContext('2d').drawImage(cv, 0, 0, t.width, t.height);
            return t.getContext('2d').getImageData(0, 0, t.width, t.height).data;
        };

        for (const name of ${JSON.stringify(CASES)}) {
            const p = (A.presets || []).find(x => x.templateName === name);
            if (!p) { out.push({ name, err: '预设不存在' }); continue; }
            A.image = im;
            A.applyPresetToCurrent(p);
            await s(100);

            // 全分辨率源
            im.grade = Object.assign({}, im.grade, { exp: 0.2 });
            A.ensureGrade(im);
            im._grade.canvas = null; im._grade.fullKey = ''; im._grade.neutral = false;
            A.rebuildGrade('full');
            window.__render(A, false);
            const full = small(A.dom.canvas, 200);

            // 1600px 源（拖动中）
            im._grade.canvas = null; im._grade.fullKey = '';
            A.rebuildGrade('low');
            window.__render(A, false);
            const low = small(A.dom.canvas, 200);

            let sum = 0, n = 0, big = 0;
            for (let i = 0; i < full.length; i += 4) {
                const d = (Math.abs(full[i] - low[i]) + Math.abs(full[i + 1] - low[i + 1])
                    + Math.abs(full[i + 2] - low[i + 2])) / 3;
                sum += d; n++;
                if (d > 24) big++;
            }
            out.push({
                name,
                style: (A.template && A.template.photoFrameStyle) || '(default)',
                mean: +(sum / n).toFixed(2),
                bigPct: +(100 * big / n).toFixed(2)
            });
            await s(20);
        }
        return out;
    })()`).catch((e) => [{ err: String(e && e.message) }]);

    if (LEGACY) console.log('=== 自证模式（QFS_LEGACY_PHOTO_DRAW=1）：这一跑**应该** FAIL ===');

    let bad = 0;
    for (const r of rows) {
        if (r.err) { console.log('SKIP  ' + r.name + ': ' + r.err); continue; }
        const ok = r.mean <= LIMIT_MEAN && r.bigPct <= LIMIT_BIG;
        if (!ok) bad++;
        console.log((ok ? 'PASS  ' : 'FAIL  ')
            + r.name.padEnd(10) + ' ' + String(r.style).padEnd(16)
            + ' mean=' + String(r.mean).padStart(6) + '  超阈值像素=' + r.bigPct + '%');
    }
    if (bad) {
        console.log('FAIL  低清档与全分辨率档版式不一致（阈值 mean<=' + LIMIT_MEAN + '，超阈值<=' + LIMIT_BIG + '%）');
        app.exit(1);
        return;
    }
    console.log('PASS  低清档只在清晰度上不同，版式与全分辨率档一致');
    app.quit();
}).catch((e) => {
    console.log('FAIL  ' + (e && e.stack || e));
    app.exit(1);
});
