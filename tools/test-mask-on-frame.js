// 「相框/卡片样式下蒙版拖不动」回归：
// 症状：套了相框或卡片样式后添加蒙版，叠加层提示"不支持画布定位"，只能切回默认边框才能调范围。
// 根因：蒙版叠加层靠 app._photoRect（照片在画布上的矩形）把指针换算成照片内坐标，
//       而只有默认图层管线会写它 —— 相框（engine-styles）与卡片（renderCardStyle）都没写。
// 修复：两条管线都上报自己的照片矩形与基准尺寸。
// 相框：在既有的 drawImage 劫持里顺带抓「画照片」那次的 dx/dy/dw/dh，补边后再按居中偏移修正。
// 卡片：直接用已经算好的 drawX/drawY/drawW/drawH。
// 用法：node tools/run-electron.js tools/test-mask-on-frame.js
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
    version: '0.1.23', electron: '31', chrome: '126', node: '20',
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
    g.fillStyle = 'rgba(255,255,255,.4)';
    g.fillRect(c.width * 0.25, c.height * 0.25, c.width * 0.5, c.height * 0.5);
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
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas)')) break;
        await sleep(200);
    }
    const exec = (expr) => win.webContents.executeJavaScript(expr);

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

    // 页面侧公共：准备一张图 + 一个可切换管线的模板，返回「照片矩形 + 指针换算」的探针
    await exec(`(async () => {
        const A = window.App;
        const el = await window.__mk(1200, 800, '#4a6b58');
        const im = { el, name: 'frame', path: null, w: 1200, h: 800, exif: {}, customSettings: null,
            _grade: { neutral: true, canvas: null, low: null, lowKey: '', fullKey: '' } };
        A.images = [im]; A.image = im; A.currentIdx = 0; A.batchSel = [0];
        A.template = A.defaultTemplate();
        A.selectedEls = [];
        window.__probe = (kind) => {
            const t = A.template;
            t.photoFrameStyle = kind === 'frame' ? 'POLAROID' : 'NONE';
            t.photoFrameBorderSize = 40;
            t.baseMargin = t.baseMargin || {};
            t.baseMargin.bgBlurEnable = kind === 'card' ? 1 : 0;
            A.invalidateStyleCaches();
            A.scheduleRender(true);
            const cv = A.dom.canvas;
            const pr = A._photoRect;
            const base = A._baseSize();
            if (!pr || !base || !base.w) return { ok: false, hasRect: !!pr };
            // 用照片矩形的中心反推屏幕坐标，再让 _maskPoint 换算回来：
            // 结果是 (0.5,0.5) 才说明叠加层的坐标换算真的对上了
            // 隐藏/被遮挡的窗口里 getBoundingClientRect 会间歇性返回 0 宽高，
            // 换算结果就恒为 (0,0) —— 这是环境竞态，不是产品逻辑。
            // 只在换算这一小段给画布和叠加层同一个确定性矩形，验的是坐标数学；
            // 算完立刻还原，不污染后续渲染。
            const ov = document.getElementById('maskOverlay') || document.querySelector('.mask-overlay');
            const RECT = { left: 0, top: 0, right: 900, bottom: 600,
                width: 900, height: 600, x: 0, y: 0, toJSON() { return {}; } };
            const cvOrig = cv.getBoundingClientRect;
            const ovOrig = ov && ov.getBoundingClientRect;
            cv.getBoundingClientRect = () => RECT;
            if (ov) ov.getBoundingClientRect = () => RECT;
            const r = cv.getBoundingClientRect();
            const cx = r.left + ((pr.x + pr.w / 2) / base.w) * r.width;
            const cy = r.top + ((pr.y + pr.h / 2) / base.h) * r.height;
            const p = A._maskPoint({ clientX: cx, clientY: cy });
            cv.getBoundingClientRect = cvOrig;
            if (ov) ov.getBoundingClientRect = ovOrig;
            const or = ov && ov.getBoundingClientRect();
            return {
                ok: !!p, hasRect: true,
                ptr: p, base: { w: base.w, h: base.h },
                rect: pr,
                canvasW: cv.width,
                cvRect: [r.left, r.top, r.width, r.height],
                ovRect: or ? [or.left, or.top, or.width, or.height] : null,
                supported: A.maskPositionSupported(),
                // 照片被边框包住时，矩形必然小于整块画布
                inset: pr.x > 0 || pr.y > 0 || (pr.x + pr.w) < base.w - 1 || (pr.y + pr.h) < base.h - 1
            };
        };
        // 先加一个椭圆蒙版并选中，叠加层才会画、_maskPoint 才有可换算的几何
        A.addMask('radial');
        return true;
    })()`);

    const sFrame = await exec(`window.__probe('frame')`);
    check(sFrame.ok && sFrame.hasRect, '相框样式上报了照片矩形', JSON.stringify(sFrame.rect || sFrame));
    check(sFrame.supported === true, '相框样式下 maskPositionSupported() 为真', String(sFrame.supported));
    check(!!sFrame.ptr && Math.abs(sFrame.ptr.x - 0.5) < 0.02 && Math.abs(sFrame.ptr.y - 0.5) < 0.02,
        '相框样式：照片中心的指针换算回 (0.5,0.5)', JSON.stringify(sFrame.ptr));
    check(sFrame.inset === true, '相框的照片矩形确实小于整块画布（不是把画布当照片）',
        JSON.stringify({ rect: sFrame.rect, base: sFrame.base }));

    // 装框缩略图是「临时接管画布/当前图/模板渲一帧」，那一帧同样会往 app 写 _photoRect。
    // 漏还原时：调色/羽化滑块停手后 260ms 会重渲缩略图，蒙版就按**缩略图那次**的照片矩形
    // 定位 —— 表现是绿蒙版突然跳到画布别处，直到下一次整帧渲染才回来。
    const sThumb = await exec(`(() => {
        const A = window.App;
        const before = A._photoRect ? JSON.stringify(A._photoRect) : '';
        // 模拟「队列里另一张图、带自己的模板」：换成无边框样式，照片矩形必然与相框的不同
        const im = A.image;
        const hadMap = !!(A.imageTemplates && A.imageTemplates.has(im));
        const mapSaved = hadMap ? A.imageTemplates.get(im) : null;
        const csSaved = im.customSettings;
        const csHad = 'customSettings' in im;
        const tpl = JSON.parse(JSON.stringify(A.template));
        tpl.photoFrameStyle = 'NONE';
        im.customSettings = tpl;
        if (hadMap) A.imageTemplates.delete(im);
        try { A.renderFramedThumb(im); } catch (_) { /* 缩略图失败不影响本断言 */ }
        if (hadMap) A.imageTemplates.set(im, mapSaved);
        if (csHad) im.customSettings = csSaved; else delete im.customSettings;
        return { before, after: A._photoRect ? JSON.stringify(A._photoRect) : '' };
    })()`);
    check(!!sThumb.before && sThumb.before === sThumb.after,
        '渲装框缩略图后 _photoRect 未被污染', JSON.stringify(sThumb));

    const sCard = await exec(`window.__probe('card')`);
    check(sCard.ok && sCard.hasRect, '卡片样式上报了照片矩形', JSON.stringify(sCard.rect || sCard));
    check(sCard.supported === true, '卡片样式下 maskPositionSupported() 为真', String(sCard.supported));
    check(!!sCard.ptr && Math.abs(sCard.ptr.x - 0.5) < 0.02 && Math.abs(sCard.ptr.y - 0.5) < 0.02,
        '卡片样式：照片中心的指针换算回 (0.5,0.5)', JSON.stringify(sCard.ptr));

    const sDefault = await exec(`window.__probe('default')`);
    check(sDefault.ok && sDefault.hasRect, '默认图层样式不受影响（仍能定位）', JSON.stringify(sDefault.rect || sDefault));

    await win.close();
    app.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); app.exit(2); });
