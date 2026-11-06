// 回归:「对比原图」必须显示未调色的照片。
//   背景:导入照片后调色会烘焙出一张离屏画布,引擎取源统一走 photoSrc()。
//   对比分支也在用同一个源,于是按住对比看到的仍是调色后的图 —— 只是去掉了边框,
//   用户没法确认调色前后差在哪。
//   约束:对比态取 im.el(当前工作底图,含裁切/旋转),而不是 _grade 的烘焙画布;
//        松手后恢复调色画面;对比态的画布尺寸仍等于原图尺寸。
// 用法: npm run test:compareorig
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR).filter(n => n.endsWith('.json')));
ipcMain.handle('load-preset', (_e, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name), 'utf8')); } catch (_) { return null; }
});
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers']) ipcMain.handle(c, () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template', 'rename-template',
    'export-template', 'export-qfs', 'open-external', 'copy-text', 'save-diagnostics',
    'check-for-updates', 'start-update-download', 'quit-and-install', 'open-wall-covers-dir']) {
    ipcMain.handle(c, () => ({ ok: true }));
}
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template',
    'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files', 'read-exif', 'load-acr-tables']) {
    ipcMain.handle(c, () => ({ canceled: true }));
}
ipcMain.handle('load-acr-shadows', () => null);

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try {
            const p = new URL(req.url).searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (_) { return new Response('NF', { status: 404 }); }
    });
    const win = new BrowserWindow({
        width: 1200, height: 900, show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 160; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas && (window.App.presets || []).length > 20)')) break;
        await sleep(250);
    }

    const raw = await win.webContents.executeJavaScript(`(async () => {
        const A = window.App;
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        A.saveCurrentTemplate = () => {};
        A.buildThumbnails = () => {};
        A.queueThumb = () => {};
        A.afterImageSelect = () => {};

        const c = document.createElement('canvas'); c.width = 600; c.height = 400;
        const g = c.getContext('2d');
        g.fillStyle = '#c0392b'; g.fillRect(0, 0, 600, 400);
        g.fillStyle = '#2e86de'; g.fillRect(0, 0, 200, 200);
        const el = new Image();
        await new Promise(r => { el.onload = r; el.src = c.toDataURL('image/png'); });
        const im = {
            name: 'compare-original', el, w: 600, h: 400, exif: {}, customSettings: null,
            _grade: { neutral: true, canvas: null, low: null, lowKey: '', fullKey: '' }
        };
        A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
        A.template = A.defaultTemplate();
        A.selectedEls = [];
        A.displayMax = 1800;
        A._forceFitNext = true;
        A.scheduleRender(true);
        await A.flushRender();
        await sleep(120);

        const px = () => {
            const cv = A.dom.canvas;
            const d = cv.getContext('2d').getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
            return [d[0], d[1], d[2], d[3]];
        };
        const snap = () => {
            const cv = A.dom.canvas;
            return { w: cv.width, h: cv.height, c: px() };
        };

        const before = snap();

        // 高饱和原图 -> 去饱和调色:烘焙图应该接近灰,原图应该仍是红/蓝
        A.setGrade({ sat: -100 }, { full: true });
        A.scheduleRender(true);
        await A.flushRender();
        await sleep(160);
        const graded = snap();
        const baked = im._grade && im._grade.canvas
            ? (() => {
                const b = im._grade.canvas;
                const d = b.getContext('2d').getImageData(Math.floor(b.width / 2), Math.floor(b.height / 2), 1, 1).data;
                return [d[0], d[1], d[2], d[3]];
            })()
            : null;

        // 进入对比(等价于按住空格)
        A.setCompare(true);
        await A.flushRender();
        await sleep(160);
        const during = snap();

        // 松手,回到调色画面
        A.setCompare(false);
        await A.flushRender();
        await sleep(220);
        const after = snap();

        return JSON.stringify({ before, graded, baked, during, after, srcW: el.naturalWidth, srcH: el.naturalHeight });
    })()`);

    const r = JSON.parse(raw);
    const failures = [];
    const ok = (cond, label, extra) => {
        console.log((cond ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
        if (!cond) failures.push(label);
    };
    const rgba = (p) => p.join(',');
    const isGray = (p) => Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]) <= 8;
    const isColor = (p) => Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]) >= 40;

    ok(isColor(r.before.c), '前置:原图有颜色', rgba(r.before.c));
    ok(r.baked && isGray(r.baked), '调色后:烘焙画布已去饱和(灰)', r.baked ? rgba(r.baked) : '无烘焙画布');
    ok(isGray(r.graded.c), '调色后:画布显示调色结果(灰)', rgba(r.graded.c));
    ok(r.during.w === r.srcW && r.during.h === r.srcH,
        '对比态画布 = 原图尺寸', r.during.w + '×' + r.during.h + ' vs ' + r.srcW + '×' + r.srcH);
    ok(isColor(r.during.c), '对比态显示未调色原图(不是烘焙后的灰图)', rgba(r.during.c));
    ok(isGray(r.after.c), '松手后恢复调色画面', rgba(r.after.c));

    console.log('─'.repeat(60));
    if (failures.length) { console.log(failures.length + ' FAILURE(S)'); app.exit(1); }
    else { console.log('✓ 全部通过'); app.exit(0); }
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });
