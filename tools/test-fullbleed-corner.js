// 回归: 全出血风格(联名水印 XIAOMI_LEICA)调「图片圆角」时,画布底色不能被底部的黑 scrim 污染。
//   两个曾经的现象:
//   ① 原图比例:照片圆角之后,压在图上的黑色渐变仍画进被裁掉的四角,左下/右下出现半透明黑块;
//   ② 指定画布比例:expandToRatio 从成片四角取补边色,四角被圆角裁成透明后只剩 scrim 黑,
//      整条补边被填成黑色 —— 看起来就是「一调圆角画布背景就变色」。
//   现在的约束:
//   - 圆角 > 0 时,全出血成片的四角必须完全透明(不能残留 scrim 黑);
//   - 补边色从源照片四角取,圆角 0/80/200 的补边颜色必须一致;
//   - 非全出血风格(3D 卡片)不受影响,圆角只裁照片、不裁整张卡片。
// 用法: npm run test:fullbleedcorner
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');

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
        await new Promise(r => setTimeout(r, 250));
    }

    const raw = await win.webContents.executeJavaScript(`(async () => {
        const A = window.App;
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        A.saveCurrentTemplate = () => {};
        A.buildThumbnails = () => {};
        A.queueThumb = () => {};
        A.afterImageSelect = () => {};

        const c = document.createElement('canvas'); c.width = 800; c.height = 1000;
        const g = c.getContext('2d');
        // 四角不同颜色 + 中间灰:补边取样/圆角残留都能直接读出来
        g.fillStyle = '#888888'; g.fillRect(0, 0, 800, 1000);
        g.fillStyle = '#e01010'; g.fillRect(0, 0, 300, 300);
        g.fillStyle = '#10c020'; g.fillRect(500, 0, 300, 300);
        g.fillStyle = '#1020e0'; g.fillRect(0, 700, 300, 300);
        g.fillStyle = '#e0d010'; g.fillRect(500, 700, 300, 300);
        const img = new Image();
        await new Promise(r => { img.onload = r; img.src = c.toDataURL('image/png'); });
        const im = {
            name: 'fullbleed-corner', el: img, w: 800, h: 1000,
            exif: { make: 'Xiaomi', model: '13', focal: '23mm', aperture: 'f/1.8', iso: 'ISO 100', shutter: '1/200' }
        };
        A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();

        const pick = (style) => (A.presets || []).find(p => String(p.photoFrameStyle || '').toUpperCase() === style);
        const leica = pick('XIAOMI_LEICA');
        const card = pick('CARD_3D');
        const glass = pick('LIQUID_GLASS');
        if (!leica) throw new Error('找不到联名水印预设(XIAOMI_LEICA)');
        if (!card) throw new Error('找不到 3D 卡片预设(CARD_3D)');
        if (!glass) throw new Error('找不到液态玻璃预设(LIQUID_GLASS)');

        const snap = async (preset, radius, ratio) => {
            A.template = Object.assign(A.defaultTemplate(), JSON.parse(JSON.stringify(preset)));
            A.template.canvasRatio = ratio;
            A.template.cornerConfig = {
                cornerLock: 1, cornerRadiusAll: radius,
                cornerRadiusTL: radius, cornerRadiusTR: radius,
                cornerRadiusBL: radius, cornerRadiusBR: radius
            };
            A._forceFitNext = true;
            A.scheduleRender(true);
            await A.flushRender();
            await sleep(240);
            const cv = A.dom.canvas;
            const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
            const at = (fx, fy) => {
                const x = Math.min(cv.width - 1, Math.max(0, Math.round(fx * cv.width)));
                const y = Math.min(cv.height - 1, Math.max(0, Math.round(fy * cv.height)));
                const i = (y * cv.width + x) * 4;
                return [d[i], d[i + 1], d[i + 2], d[i + 3]];
            };
            return {
                w: cv.width, h: cv.height,
                tl: at(0.01, 0.01), tr: at(0.99, 0.01),
                bl: at(0.01, 0.99), br: at(0.99, 0.99),
                padLeft: at(0.005, 0.5), topMid: at(0.5, 0.005),
                bottomMid: at(0.5, 0.985)
            };
        };

        const out = { leica: {}, card: {}, glass: {} };
        for (const ratio of ['original', '1:1']) {
            out.leica[ratio] = [];
            for (const r of [0, 80, 200]) out.leica[ratio].push(await snap(leica, r, ratio));
        }
        out.card.original = [];
        for (const r of [0, 80]) out.card.original.push(await snap(card, r, 'original'));
        out.glass.original = [];
        for (const r of [0, 80]) out.glass.original.push(await snap(glass, r, 'original'));
        return JSON.stringify(out);
    })()`);

    const data = JSON.parse(raw);
    const failures = [];
    const ok = (cond, label, extra) => {
        console.log((cond ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
        if (!cond) failures.push(label);
    };
    const rgba = (p) => p.join(',');
    const rgb = (p) => p.slice(0, 3).join(',');
    const near = (a, b, tol) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol && Math.abs(a[3] - b[3]) <= tol;

    const orig = data.leica.original;
    ok(orig[0].w === 800 && orig[0].h === 1000, '原图比例画布尺寸 = 800×1000', orig[0].w + '×' + orig[0].h);
    ok(orig[0].tl[3] === 255 && orig[0].tr[3] === 255 && orig[0].bl[3] === 255 && orig[0].br[3] === 255,
        '圆角 0:四角为不透明照片像素', [orig[0].tl, orig[0].tr, orig[0].bl, orig[0].br].map(rgba).join(' / '));
    for (let i = 1; i < orig.length; i++) {
        const r = [0, 80, 200][i];
        const corners = [orig[i].tl, orig[i].tr, orig[i].bl, orig[i].br];
        ok(corners.every(c => c[3] === 0), '圆角 ' + r + ':四角完全透明(无 scrim 黑块)',
            corners.map(rgba).join(' / '));
        ok(orig[i].bottomMid[3] > 0, '圆角 ' + r + ':底部水印/scrim 仍在(只裁四角)', rgba(orig[i].bottomMid));
    }

    const sq = data.leica['1:1'];
    ok(sq.every(s => s.w === 1000 && s.h === 1000), '1:1 画布尺寸 = 1000×1000',
        sq.map(s => s.w + '×' + s.h).join(' / '));
    const base = sq[0].padLeft;
    for (let i = 1; i < sq.length; i++) {
        ok(near(sq[i].padLeft, base, 1), '圆角 ' + [0, 80, 200][i] + ':补边颜色与圆角 0 一致',
            rgb(base) + ' → ' + rgb(sq[i].padLeft));
    }
    ok(sq.every(s => s.topMid[3] === 255 && near(s.topMid, [136, 136, 136, 255], 2)), '1:1 顶部中间仍是照片',
        sq.map(s => rgba(s.topMid)).join(' / '));

    const card = data.card.original;
    ok(card[0].w === card[1].w && card[0].h === card[1].h, '非全出血风格:圆角不改变画布尺寸',
        card.map(s => s.w + '×' + s.h).join(' / '));
    ok(near(card[0].tl, card[1].tl, 1) && near(card[0].tr, card[1].tr, 1)
        && near(card[0].bl, card[1].bl, 1) && near(card[0].br, card[1].br, 1),
        '非全出血风格:四角不随圆角被裁掉',
        [card[0].tl, card[1].tl].map(rgba).join(' → '));

    const glass = data.glass.original;
    ok(glass[0].w === glass[1].w && glass[0].h === glass[1].h, '有自带底色的全出血风格:圆角不改变画布尺寸',
        glass.map(s => s.w + '×' + s.h).join(' / '));
    ok(glass[1].tl[3] === 255 && glass[1].tr[3] === 255 && glass[1].bl[3] === 255 && glass[1].br[3] === 255,
        '有自带底色的全出血风格:四角保留自己的底色(不被裁成透明)',
        [glass[1].tl, glass[1].tr, glass[1].bl, glass[1].br].map(rgba).join(' / '));

    console.log('─'.repeat(60));
    if (failures.length) { console.log(failures.length + ' FAILURE(S)'); app.exit(1); }
    console.log('✓ 全部通过');
    app.exit(0);
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });
