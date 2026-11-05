// 通用回归:拖任意滑块(手势期)时,画面显示尺寸必须恒定。
//   背景:beginGesture 会把 displayMax 压到 900 做低清预览,旧实现里 finalScale 跟着变小 →
//   canvas.width 变小 → applyZoomStyle 按逻辑尺寸算 CSS 宽度 → 照片缩一圈,松手再弹回。
//   这不是某一款风格的问题,所有预设都会中招,所以按「显示比例 ≠ 渲染比例」在引擎层一次性修掉。
//   本用例遍历多个真实预设,断言:同一参数值下,手势中 与 松手后 的显示尺寸完全一致。
// 用法: npm run test:gesturescale
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const LOGO_DIR = path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
    'qingframe-web', 'brandlogos');
const EXTS = ['.png', '.jpg', '.jpeg', '.webp'];

protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR).filter(n => n.endsWith('.json')));
ipcMain.handle('load-preset', (_e, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name), 'utf8')); } catch (_) { return null; }
});
ipcMain.handle('list-logos', () => {
    if (!fs.existsSync(LOGO_DIR)) return [];
    return fs.readdirSync(LOGO_DIR).filter(n => EXTS.includes(path.extname(n).toLowerCase()))
        .map(n => ({ name: n, dataUrl: 'data:image/' + path.extname(n).slice(1) + ';base64,' + fs.readFileSync(path.join(LOGO_DIR, n)).toString('base64') }));
});
for (const c of ['list-textures', 'list-templates']) ipcMain.handle(c, () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template', 'rename-template',
    'export-template', 'export-qfs', 'open-external', 'copy-text', 'save-diagnostics',
    'check-for-updates', 'start-update-download', 'quit-and-install', 'list-wall-covers', 'open-wall-covers-dir']) {
    ipcMain.handle(c, () => ({ ok: true }));
}
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template',
    'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files', 'read-exif', 'load-acr-tables']) {
    ipcMain.handle(c, () => ({ canceled: true }));
}
// 阴影增强表不存在时渲染侧会安静降级；这里显式回应，避免刷 "No handler registered"。
ipcMain.handle('load-acr-shadows', () => null);

// 覆盖不同尺寸模型:照片铺满 / 留白 / 信息条 / 边框 / 拼贴
const WANTED = 14;

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try {
            const u = new URL(req.url); const p = u.searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (_) { return new Response('NF', { status: 404 }); }
    });
    const win = new BrowserWindow({
        width: 1400, height: 950, show: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 160; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas && (window.App.presets || []).length > 20)')) break;
        await new Promise(r => setTimeout(r, 250));
    }

    const raw = await win.webContents.executeJavaScript(`(async () => {
        const A = window.App;
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        A.saveCurrentTemplate = () => {};

        const c = document.createElement('canvas'); c.width = 1400; c.height = 1000;
        const g = c.getContext('2d'); g.fillStyle = '#5b7a99'; g.fillRect(0, 0, 1400, 1000);
        const img = new Image();
        await new Promise(r => { img.onload = r; img.src = c.toDataURL('image/png'); });
        const im = {
            name: 'gesture', el: img, w: 1400, h: 1000,
            exif: { make: 'SONY', model: 'ILCE-7CM2', focal: '35mm', aperture: 'f/2.8', iso: 'ISO 100', shutter: '1/200' }
        };
        A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();

        // 取不同风格各一个预设(按 photoFrameStyle 去重),铺开覆盖各种画布模型
        const seen = new Set();
        const picks = [];
        const push = (p) => {
            const st = String((p && p.photoFrameStyle) || '').toUpperCase();
            if (!st || seen.has(st)) return;
            seen.add(st); picks.push(p);
        };
        // 两款「画布尺寸由照片决定」的风格必测(历史上单独打过补丁)
        for (const st of ['CARD_APPLE', 'XIAOMI_LEICA']) {
            const hit = (A.presets || []).find(x => String(x.photoFrameStyle || '').toUpperCase() === st);
            if (hit) push(hit);
        }
        for (const p of (A.presets || [])) {
            if (picks.length >= ${WANTED}) break;
            push(p);
        }

        const snap = () => ({
            cw: A.dom.canvas.width, ch: A.dom.canvas.height,
            logW: A.dom.canvas._logW, logH: A.dom.canvas._logH,
            cssW: parseFloat(A.dom.canvas.style.width) || 0,
            cssH: parseFloat(A.dom.canvas.style.height) || 0,
            zoom: Math.round(A.zoom * 1000) / 1000
        });
        const rows = [];
        for (const p of picks) {
            A.template = Object.assign(A.defaultTemplate(), JSON.parse(JSON.stringify(p)));
            A.template.photoFrameStyle = p.photoFrameStyle;
            A._forceFitNext = true;
            await A.flushRender(); await sleep(320);
            const before = snap();
            // 按住滑块 → 降清渲染,同时改一个通用参数(参数字号)
            A.beginGesture();
            A.template.paramFs = (Number(A.template.paramFs) || 35) + 18;
            await A.flushRender(); await sleep(280);
            const during = snap();
            // 松手
            A.endGesture();
            await A.flushRender(); await sleep(320);
            const after = snap();
            rows.push({ name: p.name || p._fileName, style: p.photoFrameStyle, before, during, after });
        }

        // 默认模板管线(没有 photoFrameStyle):暗角/漏光/颗粒这些滑块走
        // bindRanges → beginGesture(displayMax 900)。以前 setupCanvas 的 _logW
        // 也跟着 900 算,屏幕上就缩成一半(松手才弹回)。相框风格管线早已有
        // displayScale 保护,默认模板/卡片/拼图管线此前没覆盖。
        A.template = A.defaultTemplate();
        A.template.lightEffect.vignetteStrength = 0;
        A._forceFitNext = true;
        await A.flushRender(); await sleep(320);
        {
            const before = snap();
            A.beginGesture();
            A.template.lightEffect.vignetteStrength = 55;
            A.scheduleRender(true);
            await A.flushRender(); await sleep(280);
            const during = snap();
            A.endGesture();
            A.scheduleRender(true);
            await A.flushRender(); await sleep(320);
            const after = snap();
            rows.push({ name: '默认模板（暗角滑块）', style: 'NONE', before, during, after });
        }
        return JSON.stringify(rows);
    })()`);

    const rows = JSON.parse(raw);
    const failures = [];
    const ok = (cond, label, extra) => {
        console.log((cond ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
        if (!cond) failures.push(label);
    };

    for (const r of rows) {
        const same = Math.abs(r.during.cssW - r.after.cssW) <= 1 && Math.abs(r.during.cssH - r.after.cssH) <= 1;
        ok(same, '手势中尺寸 = 松手后尺寸 · ' + r.name,
            `${r.before.cssW}x${r.before.cssH} → ${r.during.cssW}x${r.during.cssH} → ${r.after.cssW}x${r.after.cssH}`);
        // 低清预览仍应生效:像素尺寸不允许变大
        ok(r.during.cw <= r.after.cw + 1 && r.during.ch <= r.after.ch + 1, '手势期仍走低清(像素不涨) · ' + r.name,
            `${r.after.cw}x${r.after.ch} → ${r.during.cw}x${r.during.ch}`);
    }

    console.log('─'.repeat(60));
    console.log('覆盖 ' + rows.length + ' 个风格:' + rows.map(r => r.style).join(', '));
    if (failures.length) { console.log(failures.length + ' FAILURE(S)'); app.exit(1); }
    console.log('✓ 全部通过');
    app.exit(0);
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });
