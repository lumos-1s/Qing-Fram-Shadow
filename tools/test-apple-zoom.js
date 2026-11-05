// 苹果信息卡「调滑块时照片不缩小」回归:
//   CARD_APPLE 的信息条高度由内容驱动(字号/Logo/显隐一变,画布基高就变)。
//   缩小的成因有三条,都必须钉住:
//     ① engine.js:内容基尺寸一变就 fitZoom(),把用户缩放回退成「适应窗口」;
//     ② engine-styles.js:预览比例按「长边」封顶(displayMax/longEdge),信息条一变高,
//        长边就从宽换成高,比例整体变小 —— 竖构图照片调一次参数就缩一圈,而 zoom 完全没变;
//     ③ app-state.js:按住滑块(beginGesture)会把 displayMax 压到 900 做低清预览,逻辑尺寸
//        跟着被压小,拖动过程中预览瞬间缩到一半,松手再按新高度重算,又永久小一档。
//   所以断言不能只看 zoom,必须看画布真正的显示宽度(canvas.style.width / _logW),
//   而且要覆盖「拖动中」与「松手后」两个时刻,并包含不改变信息条高度的滑块(Logo 不透明度/竖线粗细)。
// 用法: node tools/run-electron.js tools/test-apple-zoom.js
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const failures = [];
const ok = (cond, label, extra) => {
    console.log((cond ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!cond) failures.push(label);
};

protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);
ipcMain.handle('list-presets', () => []);
ipcMain.handle('load-preset', () => null);
ipcMain.handle('list-logos', () => []);
ipcMain.handle('list-textures', () => []);
ipcMain.handle('list-templates', () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('save-prefs', () => ({ ok: true }));
ipcMain.handle('get-user', () => null);
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template',
    'export-qfs', 'save-user', 'logout-user', 'read-exif', 'load-acr-tables']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}

// 1512×2016 竖构图:长边(2016+信息条)超过 displayMax(1800) → 预览比例会被「长边」压小,
// 正是旧实现里照片每调一次参数就缩一圈的场景。小方图长边不越界,压不出来,所以必须用竖图。
const PHOTO = { w: 1512, h: 2016 };
// 前两个改信息条高度,后两个不改(旧条件「只变高才冻结」正是被它们漏掉的)
const SLIDERS = ['slAppleParamSize', 'slAppleModelSize', 'slAppleLogoOpacity', 'slAppleLineWidth'];

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try {
            const u = new URL(req.url); const p = u.searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (e) { return new Response('NF', { status: 404 }); }
    });
    const win = new BrowserWindow({
        width: 1280, height: 900, show: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.StyleCaps)')) break;
        await new Promise(r => setTimeout(r, 250));
    }
    const res = await win.webContents.executeJavaScript(`(async () => {
        const A = window.App;
        A.saveCurrentTemplate = () => {};
        const c = document.createElement('canvas'); c.width = ${PHOTO.w}; c.height = ${PHOTO.h};
        const g = c.getContext('2d');
        g.fillStyle = '#88aacc'; g.fillRect(0, 0, c.width, c.height);
        const img = new Image(); await new Promise(r => { img.onload = r; img.src = c.toDataURL('image/jpeg', 0.6); });
        const im = { name: 't', el: img, w: ${PHOTO.w}, h: ${PHOTO.h}, exif: { make: 'Apple', model: 'iPhone 18 Pro Max', focal: '24mm', aperture: 'f/1.88', iso: 'ISO 102', shutter: '1/4132' } };
        A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
        A.template = A.defaultTemplate(); A.template.photoFrameStyle = 'CARD_APPLE';
        A.updateEmptyState(); A.refreshUI();
        A._forceFitNext = true;
        A.scheduleRender(true);
        await new Promise(r => setTimeout(r, 900));
        A.fitZoom();
        await new Promise(r => setTimeout(r, 150));
        const cv = A.dom.canvas;
        const snap = () => ({
            zoom: A.zoom,
            cssW: Math.round((parseFloat(cv.style.width) || 0) * 10) / 10,
            cssH: Math.round((parseFloat(cv.style.height) || 0) * 10) / 10,
            logW: cv._logW, logH: cv._logH,
            baseH: A._canvasBaseH,
        });
        const s0 = snap();
        const rows = [];
        for (const id of ${JSON.stringify(SLIDERS)}) {
            const el = document.getElementById(id);
            if (!el) { rows.push({ id, missing: true }); continue; }
            const old = el.value;
            // 真按下滑块:trigger beginGesture(displayMax 900 低清预览)
            el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
            await new Promise(r => setTimeout(r, 60));
            el.value = el.max || String(+old + 50);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 800));
            const dragging = snap();
            // 松手:endGesture 恢复 displayMax 并再渲一帧
            el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
            await new Promise(r => setTimeout(r, 900));
            const released = snap();
            rows.push({ id, from: old, dragging, released });
            el.value = old;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 500));
        }
        return { s0, rows };
    })()`);

    const near = (a, b) => Math.abs(a - b) <= 1;
    const bad = res.rows.filter(r => r.missing || !near(r.dragging.cssW, res.s0.cssW) || !near(r.released.cssW, res.s0.cssW));
    ok(bad.length === 0, '拖动中与松手后照片显示宽度都不变',
        res.s0.cssW + ' | ' + res.rows.map(r => r.missing ? r.id + ':MISSING' : r.id + ' ' + r.dragging.cssW + '/' + r.released.cssW).join(' · '));
    ok(res.rows.every(r => r.missing || near(r.dragging.logW, res.s0.logW)),
        '拖动中画布逻辑宽度不变(不受手势低清预览影响)', res.s0.logW + ' → ' + res.rows.map(r => r.dragging.logW).join(' / '));
    ok(res.rows.every(r => r.missing || near(r.released.zoom, res.s0.zoom)),
        '缩放级别全程不变', res.s0.zoom + ' → ' + res.rows.map(r => r.released.zoom).join(' / '));
    ok(res.rows.some(r => !r.missing && r.released.baseH > res.s0.baseH),
        '参数确实撑高了信息条(用例有效)', [res.s0.baseH].concat(res.rows.map(r => r.released.baseH)).join(' → '));
    ok(res.rows.some(r => !r.missing && r.released.cssH > res.s0.cssH),
        '信息条变高体现在画布高度上', res.s0.cssH + ' → ' + res.rows.map(r => r.released.cssH).join(' / '));

    console.log(failures.length ? '✖ ' + failures.length + ' 项失败' : '✓ 全部通过');
    app.exit(failures.length ? 1 : 0);
}).catch(e => { console.error(e); app.exit(1); });
