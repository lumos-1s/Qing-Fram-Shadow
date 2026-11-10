// 旋转 / EXIF 方向校正 / 裁切：带 alpha 的图不能被烘成黑块。
// 根因：这三处改像素时若用 toDataURL('image/jpeg')，JPEG 无 alpha 通道，
// 透明像素会变成不透明纯黑 —— 用户看到的「旋转图片时图片变黑」。
// 用法: node tools/run-electron.js tools/test-rotate-alpha.js
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
ipcMain.handle('load-preset', (_e, n) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, n + '.json'), 'utf8')); } catch (_) { return null; }
});
for (const ch of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(ch, () => []);
for (const ch of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template', 'rename-template',
    'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text', 'save-diagnostics',
    'check-for-updates', 'start-update-download', 'quit-and-install', 'open-wall-covers-dir']) ipcMain.handle(ch, () => ({ ok: true }));
for (const ch of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template',
    'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files', 'read-exif', 'open-image']) ipcMain.handle(ch, () => ({ canceled: true }));
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('load-acr-tables', () => null);
ipcMain.handle('load-acr-shadows', () => null);

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

// 页面内的取样助手：把任意图源缩到 240px 统计透明度 / 黑色像素。
// 透明像素是 rgba(0,0,0,0)，JPEG 烘黑后变成 rgba(0,0,0,255) —— 用
// blackOpaquePct（不透明且近黑）区分这两者，比只看亮度可靠。
const HELPERS = `
window.__px = (src) => {
    if (!src) return { err: 'null src' };
    const w = src.naturalWidth || src.width || 0, h = src.naturalHeight || src.height || 0;
    if (!w || !h) return { err: 'zero size' };
    const c = document.createElement('canvas');
    c.width = Math.min(w, 240); c.height = Math.min(h, 240);
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, opaque = 0, blackOpaque = 0, color = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
        const r = d[i], gg = d[i+1], b = d[i+2], a = d[i+3];
        sum += (r + gg + b) / 3;
        if (a > 200) opaque++;
        if (a > 200 && r + gg + b < 60) blackOpaque++;
        if (a > 200 && Math.max(r, gg, b) - Math.min(r, gg, b) > 30) color++;
        n++;
    }
    return { w, h, avg: Math.round(sum / n),
        opaquePct: Math.round(opaque * 100 / n), blackOpaquePct: Math.round(blackOpaque * 100 / n),
        colorPct: Math.round(color * 100 / n) };
};
// halfTransparent: 左半四色不透明、右半完全透明；softEdge: 下半用半透明渐变
window.__mk = async (w, h, halfTransparent, softEdge) => {
    const c = document.createElement('canvas');
    c.width = w || 800; c.height = h || 600;
    const g = c.getContext('2d');
    if (!halfTransparent) { g.fillStyle = '#eee'; g.fillRect(0, 0, c.width, c.height); }
    g.fillStyle = '#c33'; g.fillRect(0, 0, c.width / 2, c.height / 2);
    g.fillStyle = '#33c'; g.fillRect(0, c.height / 2, c.width / 2, c.height / 2);
    if (!halfTransparent) {
        g.fillStyle = '#3c3'; g.fillRect(c.width / 2, 0, c.width / 2, c.height / 2);
        g.fillStyle = '#cc3'; g.fillRect(c.width / 2, c.height / 2, c.width / 2, c.height / 2);
    } else if (softEdge) {
        const grd = g.createLinearGradient(c.width / 2, 0, c.width, 0);
        grd.addColorStop(0, 'rgba(60,190,60,0.85)');
        grd.addColorStop(1, 'rgba(60,190,60,0)');
        g.fillStyle = grd; g.fillRect(c.width / 2, 0, c.width / 2, c.height);
    }
    const el = new Image();
    await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
    return el;
};
window.__setup = async (w, h, halfTransparent, softEdge, graded) => {
    const A = window.App;
    const el = await window.__mk(w, h, halfTransparent, softEdge);
    const im = { el, name: 'rotate-alpha.png', path: null, w: w || 800, h: h || 600,
        exif: {}, customSettings: null };
    A.images = [im]; A.image = im; A.currentIdx = 0; A.selectedIdx = [0]; A.batchSel = [0];
    A.template = A.defaultTemplate(); A.setTpl(im, A.template);
    if (graded) { A.setGrade({ exp: 40, con: 20 }); A.rebuildGrade('full'); }
    A.scheduleRender(true);
    await new Promise(r => setTimeout(r, 350));
    return { el: window.__px(im.el), canvas: window.__px(A.dom.canvas) };
};
// 艺术卡：照片直接画在白卡纸上，整张透明被 JPEG 烘黑后就会 1:1 呈现「纯黑照片」
window.__artSetup = async (mode) => {
    const A = window.App;
    const el = await window.__mk(800, 600, mode === 'half', false);
    if (mode === 'color') {
        // __mk 的 half=false 已经是彩色四象限，这里不额外处理
    }
    const empty = document.createElement('canvas');
    empty.width = 800; empty.height = 600;
    const src = mode === 'empty' ? await (async () => {
        const im = new Image();
        await new Promise((r) => { im.onload = r; im.onerror = r; im.src = empty.toDataURL('image/png'); });
        return im;
    })() : el;
    const im = { el: src, name: 'art.png', path: null, w: 800, h: 600,
        exif: { model: 'ILCE-6000' }, customSettings: null, grade: null };
    A.images = [im]; A.image = im; A.currentIdx = 0; A.selectedIdx = [0]; A.batchSel = [0];
    A.imageTemplates = new Map();
    if (A.invalidateGrade) A.invalidateGrade(im);
    const t = A.defaultTemplate();
    t.photoFrameStyle = 'ART_CARD'; t.photoFrameBorderSize = 80; t.templateName = '艺术卡';
    A.template = t; A.setTpl(im, t); A.normalizeTemplate(); A.refreshUI();
    await A.flushRender();
    return window.__photoBlackPct();
};
window.__photoBlackPct = () => {
    const A = window.App, cv = A.dom.canvas;
    const pr = A._photoRect || { x: 0, y: 0, w: cv.width, h: cv.height };
    const sc = A._canvasScale || 1;
    const x0 = Math.max(0, Math.round((pr.x + pr.w * 0.15) * sc));
    const x1 = Math.min(cv.width, Math.round((pr.x + pr.w * 0.85) * sc));
    const y0 = Math.max(0, Math.round((pr.y + pr.h * 0.15) * sc));
    const y1 = Math.min(cv.height, Math.round((pr.y + pr.h * 0.85) * sc));
    const d = cv.getContext('2d').getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data;
    let black = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
        if (d[i] + d[i+1] + d[i+2] < 60) black++;
        n++;
    }
    return { blackPct: Math.round(black * 100 / n), rect: [x0, y0, x1, y1] };
};
// 无边框（NONE）：画布直接铺满照片，没有白卡纸，最容易看出「照片本身黑」
window.__noneSetup = async (mode) => {
    const A = window.App;
    let src = await window.__mk(800, 600, mode === 'half', false);
    if (mode === 'empty') {
        const c = document.createElement('canvas'); c.width = 800; c.height = 600;
        src = new Image();
        await new Promise((r) => { src.onload = r; src.onerror = r; src.src = c.toDataURL('image/png'); });
    }
    const im = { el: src, name: 'none.png', path: null, w: 800, h: 600,
        exif: {}, customSettings: null, grade: null };
    A.images = [im]; A.image = im; A.currentIdx = 0; A.selectedIdx = [0]; A.batchSel = [0];
    A.imageTemplates = new Map();
    if (A.invalidateGrade) A.invalidateGrade(im);
    const t = A.defaultTemplate();
    t.photoFrameStyle = 'NONE';
    A.template = t; A.setTpl(im, t); A.normalizeTemplate(); A.refreshUI();
    await A.flushRender();
    return { area: window.__photoBlackPct(), el: window.__px(im.el) };
};
true;
`;

const clean = (p) => p && !p.err && p.blackOpaquePct <= 2 && p.opaquePct < 70;

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
    const exec = (e) => win.webContents.executeJavaScript(e);
    await sleep(400);
    win.showInactive();
    await exec(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(1000);
    await exec(HELPERS);
    await exec(`(async () => { await window.App.loadPresets(); return true; })()`);

    // 0) 基线：造出来的图确实带透明区（否则后面的断言全是空跑）
    const base = await exec(`(async () => await window.__setup(800, 600, true, false, false))()`);
    check(base.el && base.el.opaquePct >= 45 && base.el.opaquePct <= 55 && base.el.blackOpaquePct === 0,
        '基线：测试图右半是透明、左半是彩色不透明', JSON.stringify(base.el));

    // 1) 主界面旋转 90°：透明区必须保持透明，不能烘成黑块
    const rotated = await exec(`(async () => {
        const A = window.App;
        let err = '';
        try { await A.rotateCurrentPhoto(); } catch (e) { err = String(e && e.message || e); }
        await new Promise(r => setTimeout(r, 500));
        return { err, w: A.image.w, h: A.image.h, rotate: A.image.rotate,
            el: window.__px(A.image.el), src: window.__px(window.photoSrcOf(A.image)),
            canvas: window.__px(A.dom.canvas) };
    })()`);
    check(!rotated.err, '主旋转不抛异常', rotated.err);
    check(rotated.w === 600 && rotated.h === 800 && rotated.rotate === 1,
        '主旋转 90° 后宽高互换、旋转计数 +1', JSON.stringify({ w: rotated.w, h: rotated.h, rotate: rotated.rotate }));
    check(clean(rotated.el), '主旋转后位图透明区没有变成黑色（核心回归）', JSON.stringify(rotated.el));
    check(rotated.canvas && rotated.canvas.blackOpaquePct <= 2,
        '主旋转后主画布不出现黑块', JSON.stringify(rotated.canvas));

    // 2) 连续旋转 3 次：每一轮都重新编码，都不能把 alpha 弄丢
    const loop = await exec(`(async () => {
        const A = window.App; const out = [];
        for (let i = 0; i < 3; i++) {
            await A.rotateCurrentPhoto();
            await new Promise(r => setTimeout(r, 200));
            out.push({ i, w: A.image.w, h: A.image.h, p: window.__px(A.image.el) });
        }
        return out;
    })()`);
    check(loop.every((x) => clean(x.p)), '连续旋转 3 次，每轮都保留透明区',
        JSON.stringify(loop.map((x) => x.p)));
    check(loop[2].w === 800 && loop[2].h === 600,
        '累计旋转 4 次后回到 800×600', JSON.stringify({ w: loop[2].w, h: loop[2].h }));

    // 3) EXIF 方向校正（竖拍照片导入时自动触发的同一条路径）
    const exif6 = await exec(`(async () => {
        await window.__setup(800, 600, true, false, false);
        const A = window.App; const img = A.image.el;
        const r = await A.applyOrientation(img, 6);
        return { has: !!r, oriented: r ? window.__px(r.el) : null,
            dims: r ? { w: r.w, h: r.h } : null, original: window.__px(img) };
    })()`);
    check(exif6.has && exif6.dims && exif6.dims.w === 600 && exif6.dims.h === 800,
        'EXIF orientation=6 校正后宽高互换', JSON.stringify(exif6.dims));
    check(clean(exif6.oriented), 'EXIF 校正后透明区没有变成黑色（核心回归）', JSON.stringify(exif6.oriented));
    check(exif6.original && exif6.original.blackOpaquePct === 0,
        'EXIF 校正没有污染原始位图', JSON.stringify(exif6.original));

    const exif3 = await exec(`(async () => {
        await window.__setup(800, 600, true, false, false);
        const r = await window.App.applyOrientation(window.App.image.el, 3);
        return { has: !!r, dims: r ? { w: r.w, h: r.h } : null, p: r ? window.__px(r.el) : null };
    })()`);
    check(exif3.has && exif3.dims && exif3.dims.w === 800 && exif3.dims.h === 600,
        'EXIF orientation=3（180°）不交换宽高', JSON.stringify(exif3.dims));
    check(clean(exif3.p), 'EXIF 180° 校正也保留透明区', JSON.stringify(exif3.p));

    // 4) 半透明渐变边缘（羽化/圆角）：不能出现黑边
    const soft = await exec(`(async () => {
        await window.__setup(800, 600, true, true, false);
        const A = window.App;
        await A.rotateCurrentPhoto();
        await new Promise(r => setTimeout(r, 300));
        return window.__px(A.image.el);
    })()`);
    check(clean(soft), '半透明渐变边缘旋转后没有黑边', JSON.stringify(soft));

    // 5) 有调色参数时旋转：烘焙链重建后也不能变黑
    const graded = await exec(`(async () => {
        await window.__setup(800, 600, true, false, true);
        const A = window.App;
        await A.rotateCurrentPhoto();
        await new Promise(r => setTimeout(r, 500));
        return { src: window.__px(window.photoSrcOf(A.image)), canvas: window.__px(A.dom.canvas),
            neutral: A.image._grade ? A.image._grade.neutral : null };
    })()`);
    check(graded.neutral === false, '调色参数在旋转后仍生效（没有被清成中性）', `neutral=${graded.neutral}`);
    check(graded.canvas && graded.canvas.blackOpaquePct <= 2,
        '有调色时旋转后主画布不出现黑块', JSON.stringify(graded.canvas));

    // 6) 不透明照片：确认没有回归（画面内容、亮度、宽高都正常）
    const opaque = await exec(`(async () => {
        await window.__setup(800, 600, false, false, false);
        const A = window.App;
        const before = window.__px(A.image.el);
        await A.rotateCurrentPhoto();
        await new Promise(r => setTimeout(r, 400));
        return { before, after: window.__px(A.image.el), w: A.image.w, h: A.image.h };
    })()`);
    check(opaque.w === 600 && opaque.h === 800, '不透明照片旋转后宽高互换', `${opaque.w}×${opaque.h}`);
    check(opaque.after && opaque.after.blackOpaquePct === 0 && opaque.after.colorPct > 90
            && Math.abs(opaque.after.avg - opaque.before.avg) <= 3,
        '不透明照片旋转后不黑、彩色内容和亮度不变', JSON.stringify(opaque));

    // 7) 裁切弹窗内旋转 + 应用：共用 qfsCanvasImage 后行为不能退化
    const crop = await exec(`(async () => {
        await window.__setup(800, 600, true, false, false);
        const A = window.App;
        let err = '';
        try {
            A.openCrop();
            document.getElementById('cropRotate').click();
            await A.applyCrop();
        } catch (e) { err = String(e && e.message || e); }
        await new Promise(r => setTimeout(r, 400));
        return { err, w: A.image.w, h: A.image.h, p: window.__px(A.image.el) };
    })()`);
    check(!crop.err && crop.w === 600 && crop.h === 800,
        '裁切弹窗旋转 90° 后应用：宽高互换', JSON.stringify(crop));
    check(clean(crop.p), '裁切弹窗旋转后透明区仍保留（共用入口没退化）', JSON.stringify(crop.p));

    // 8) 反向自检：把编码换回 0.1.25 的 JPEG，整张透明图 + 艺术卡必须复现「整张黑」。
    //    证明下面第 9 条的断言真的能抓住这个 bug，而不是空跑。
    const legacy = await exec(`(async () => {
        const orig = window.qfsCanvasImage;
        window.qfsCanvasImage = (canvas) => new Promise((res) => {
            const im = new Image();
            im.onload = () => res(im.naturalWidth ? im : null);
            im.onerror = () => res(null);
            im.src = canvas.toDataURL('image/jpeg', 0.95);
        });
        let out;
        try {
            await window.__artSetup('empty');
            await window.App.rotateCurrentPhoto();
            await window.App.flushRender();
            out = window.__photoBlackPct();
        } finally { window.qfsCanvasImage = orig; }
        return out;
    })()`);
    check(legacy.blackPct >= 90,
        '反向自检：旧 JPEG 编码会复现艺术卡整张纯黑（与用户截图一致）', JSON.stringify(legacy));

    // 9) 当前实现：同一场景必须保持白卡纸，不出现整张黑
    const artBefore = await exec(`(async () => await window.__artSetup('empty'))()`);
    const artAfter = await exec(`(async () => {
        const A = window.App;
        await A.rotateCurrentPhoto();
        await A.flushRender();
        await new Promise(r => setTimeout(r, 200));
        return { area: window.__photoBlackPct(), el: window.__px(A.image.el) };
    })()`);
    check(artBefore.blackPct <= 2, '艺术卡 + 全透明图：旋转前照片区不是黑的', JSON.stringify(artBefore));
    check(artAfter.area.blackPct <= 2,
        '艺术卡 + 全透明图：旋转后照片区不出现整张黑（整张黑回归）', JSON.stringify(artAfter.area));
    check(artAfter.el.blackOpaquePct === 0,
        '艺术卡场景：旋转后位图仍保持透明，没有被烘成不透明黑', JSON.stringify(artAfter.el));

    // 10) 艺术卡 + 彩色图：正常照片旋转后画面内容不受影响
    const artColor = await exec(`(async () => {
        await window.__artSetup('color');
        const A = window.App;
        await A.rotateCurrentPhoto();
        await A.flushRender();
        await new Promise(r => setTimeout(r, 200));
        return window.__photoBlackPct();
    })()`);
    check(artColor.blackPct <= 2, '艺术卡 + 彩色照片：旋转后不黑', JSON.stringify(artColor));

    // 11) 内容比例探针本身要准：彩色≈1、半透明≈0.5、全透明≈0
    const ratios = await exec(`(async () => {
        const out = {};
        for (const [k, mode] of [['color','color'], ['half','half'], ['empty','empty']]) {
            await window.__noneSetup(mode);
            out[k] = window.qfsOpaqueRatio(window.App.image.el);
        }
        return out;
    })()`);
    check(ratios.color > 0.98 && ratios.half > 0.4 && ratios.half < 0.6 && ratios.empty === 0,
        'qfsOpaqueRatio 判定正确（彩色 / 半透明 / 全透明）', JSON.stringify(ratios));

    // 12) 守卫：模拟 drawImage 没画上（源图有内容、结果画布全空）→ 必须保留原图并提示
    const guard = await exec(`(async () => {
        await window.__setup(800, 600, false, false, false);
        const A = window.App;
        const origEl = A.image.el, origW = A.image.w, origH = A.image.h;
        const origDraw = CanvasRenderingContext2D.prototype.drawImage;
        let status = '';
        const origStatus = A.setStatus;
        A.setStatus = (s) => { status = String(s); return origStatus.call(A, s); };
        // 只让「旋转用的 600×800 离屏画布」这次绘制失效
        CanvasRenderingContext2D.prototype.drawImage = function () {
            if (this.canvas && this.canvas.width === 600 && this.canvas.height === 800
                && this.canvas !== A.dom.canvas) return;
            return origDraw.apply(this, arguments);
        };
        try { await A.rotateCurrentPhoto(); } catch (e) { status += ' ERR:' + e.message; }
        finally {
            CanvasRenderingContext2D.prototype.drawImage = origDraw;
            A.setStatus = origStatus;
        }
        await new Promise(r => setTimeout(r, 200));
        return { status, sameEl: A.image.el === origEl, w: A.image.w, h: A.image.h,
            origW, origH, px: window.__px(A.image.el) };
    })()`);
    check(guard.sameEl && guard.w === guard.origW && guard.h === guard.origH,
        '空画布被拦下：不替换 im.el，保留原图尺寸', JSON.stringify(guard));
    check(/保留原图/.test(guard.status), '空画布被拦下时给出明确提示，而不是静默黑屏', guard.status);
    check(guard.px && guard.px.blackOpaquePct === 0 && guard.px.colorPct > 90,
        '空画布被拦下后原图内容完好', JSON.stringify(guard.px));

    // 13) 无边框 NONE + 彩色照片：与用户第二张截图同款布局，旋转后不黑
    const noneColor = await exec(`(async () => {
        const before = await window.__noneSetup('color');
        const A = window.App;
        await A.rotateCurrentPhoto();
        await A.flushRender();
        await new Promise(r => setTimeout(r, 200));
        return { before: before.area, after: window.__photoBlackPct(),
            el: window.__px(A.image.el), w: A.image.w, h: A.image.h };
    })()`);
    check(noneColor.after.blackPct <= 2 && noneColor.w === 600 && noneColor.h === 800,
        '无边框 + 彩色照片：旋转后不黑、宽高互换', JSON.stringify(noneColor));

    // 14) 无边框 NONE + 全透明图：位图不能被烘成不透明黑
    const noneEmpty = await exec(`(async () => {
        await window.__noneSetup('empty');
        const A = window.App;
        await A.rotateCurrentPhoto();
        await A.flushRender();
        await new Promise(r => setTimeout(r, 200));
        return { el: window.__px(A.image.el), area: window.__photoBlackPct() };
    })()`);
    check(noneEmpty.el && noneEmpty.el.blackOpaquePct === 0 && noneEmpty.el.opaquePct === 0,
        '无边框 + 全透明图：旋转后保持透明，没有变成不透明黑', JSON.stringify(noneEmpty.el));

    await win.destroy();
    app.quit();
    if (failures.length) {
        console.log(`✖ ${failures.length} 项未通过`);
        process.exit(1);
    }
    console.log('ALL PASS');
}

main().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
