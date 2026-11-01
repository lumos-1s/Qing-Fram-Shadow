// 蒙版叠加层与照片错位的实证诊断(邮票家族)。
// 在真实 App 里渲一张 STAMP_REDSEAL,然后回答三个问题:
//   ① 引擎劫持抓到的 app._photoRect 是多少?与 styleStamp 几何推导的照片矩形
//      (x0+side, y0+side, iw, ih) 是否一致?
//   ② 蒙版叠加层上绿色像素的实际 bbox 在哪?按 _photoRect 换算它在哪?
//   ③ 画布里照片(棋盘格测试图,高频纹理 blur 后变灰,可精确定位)的真实 bbox 在哪?
// 三者互相对照就能定位是「抓取错」还是「叠加层换算错」。
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);
ipcMain.handle('list-presets', () => fs.readdirSync(path.join(ROOT, 'shared', 'presets')).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'presets', n + '.json'), 'utf8')));
for (const c of ['list-logos', 'list-textures', 'list-templates']) ipcMain.handle(c, () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}
const preset = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'presets', n + '.json'), 'utf8'));

const DIAG = (presetObj) => `(async () => {
    const A = window.App;
    const RD = Date;
    window.Date = class extends RD { constructor(...a) { if (a.length) super(...a); else super(2026, 4, 4, 12, 0, 0); } };
    // 棋盘格测试图:高频黑白格,模糊底会把它匀成中灰,只有照片本体保留纯黑+纯白 → 可精确定位照片 bbox
    const iw = 1600, ih = 1067, cell = 8;
    const c = document.createElement('canvas'); c.width = iw; c.height = ih;
    const g0 = c.getContext('2d');
    for (let y = 0; y < ih; y += cell) for (let x = 0; x < iw; x += cell) {
        g0.fillStyle = ((x / cell + y / cell) % 2) ? '#ffffff' : '#000000';
        g0.fillRect(x, y, cell, cell);
    }
    const im = new Image();
    await new Promise(r => { im.onload = r; im.onerror = r; im.src = c.toDataURL('image/png'); });
    // 全局记录每一次画 im 的 drawImage(参数 + 所属画布 + 调用栈),定位劫持到底抓到了哪一次
    const calls = [];
    const proto = CanvasRenderingContext2D.prototype;
    const origDraw = proto.drawImage;
    proto.drawImage = function(src, ...args) {
        if (src === im) {
            const cvc = this.canvas;
            calls.push({ cw: cvc.width, ch: cvc.height,
                a: args.slice(0, 8).map((x) => Math.round(Number(x) * 100) / 100),
                st: String(new Error().stack || '').split('\\n').slice(2, 5).map((s) => s.trim().replace(/^at /, '').replace(/\\(.*engine-styles/, '(ES').slice(0, 90)).join(' <= ') });
        }
        return origDraw.apply(this, [src, ...args]);
    };
    A.image = { el: im, name: 'p.png', w: iw, h: ih, exif: {} };
    A.images = [A.image]; A.imageTemplates = new Map();
    A.currentIdx = 0; A.selectedIdx = [0]; A.batchSel = []; A.selectedEls = [];
    A.template = ${JSON.stringify(presetObj)};
    A.normalizeTemplate(); A.invalidateStyleCaches(); A.displayMax = 2200;
    window.__render(A, false); await new Promise(r => setTimeout(r, 200));
    window.__render(A, false); await new Promise(r => setTimeout(r, 200));

    const cv = A.dom.canvas, W = cv.width, H = cv.height;
    // ① 引擎抓到的矩形
    const photoRect = A._photoRect ? { ...A._photoRect } : null;
    const base = { w: A._canvasBaseW, h: A._canvasBaseH, scale: A._canvasScale };
    // ② 几何推导(styleStamp / styleDims 同一套公式)
    const bs = Math.max(5, A.template.photoFrameBorderSize || 5);
    const size = Math.max(5, Math.floor(Math.floor(bs * 2.0) * Math.min(iw, ih) / 1000));
    const side = Math.max(16, Math.round(iw * 0.025), Math.round(size * 0.8));
    const blurGap = Math.max(36, Math.round(iw * 0.06), Math.round(size * 2.0));
    const textH0 = Math.max(46, Math.round(size * 1.8));
    const expected = { size, side, blurGap, x: blurGap + side, y: blurGap + side, w: iw, h: ih,
        canvasW: iw + side * 2 + blurGap * 2, canvasH: ih + side * 2 + textH0 + blurGap * 2 };
    // ③ 画布里照片的真实 bbox(纯黑+纯白同现的行/列;模糊底是中灰,票面是米色,都不会命中)
    const d = cv.getContext('2d').getImageData(0, 0, W, H).data;
    const rowHit = new Array(H).fill(false), colHit = new Array(W).fill(false);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            if (d[i] < 12 && d[i+1] < 12 && d[i+2] < 12) {
                // 黑像素:向右找 8px 内是否有纯白(棋盘格 cell=8)
                for (let k = 0; k < cell * 2 && x + k < W; k += 1) {
                    const j = (y * W + x + k) * 4;
                    if (d[j] > 243 && d[j+1] > 243 && d[j+2] > 243) { rowHit[y] = true; colHit[x] = true; colHit[x + k] = true; break; }
                }
            }
        }
    }
    const bboxOf = (hit) => { let a = -1, b = -1; for (let i = 0; i < hit.length; i++) if (hit[i]) { if (a < 0) a = i; b = i; } return { a, b }; };
    const rowB = bboxOf(rowHit), colB = bboxOf(colHit);
    const actualPhoto = { x: colB.a, y: rowB.a, w: colB.b - colB.a, h: rowB.b - rowB.a };
    // ④ 挂一个线性蒙版,画叠加层,量绿色像素 bbox
    A.addMask('linear');
    await new Promise(r => setTimeout(r, 120));
    A.drawMaskOverlay();
    await new Promise(r => setTimeout(r, 60));
    const ov = document.getElementById('maskOverlay');
    const ovW = ov.width, ovH = ov.height;
    const od = ov.getContext('2d').getImageData(0, 0, ovW, ovH).data;
    let gN = 0, gx0 = 1e9, gy0 = 1e9, gx1 = -1, gy1 = -1;
    for (let y = 0; y < ovH; y++) for (let x = 0; x < ovW; x++) {
        const i = (y * ovW + x) * 4;
        if (od[i+3] > 8 && od[i+1] > od[i] + 25 && od[i+1] > od[i+2] + 25) {
            gN++; if (x < gx0) gx0 = x; if (x > gx1) gx1 = x; if (y < gy0) gy0 = y; if (y > gy1) gy1 = y;
        }
    }
    const green = gN ? { x: gx0, y: gy0, w: gx1 - gx0, h: gy1 - gy0, n: gN } : null;
    // 叠加层换算比例与「按 _photoRect 应该画出的绿区」
    const k = ovW / Math.max(1, base.w);
    const greenFromRect = photoRect ? { x: photoRect.x * k, y: photoRect.y * k, w: photoRect.w * k, h: photoRect.h * k } : null;
    const greenFromExpected = { x: expected.x * k, y: expected.y * k, w: expected.w * k, h: expected.h * k };
    window.Date = RD;
    proto.drawImage = origDraw;
    const m = A.activeMask(A.image);
    return { style: A.template.photoFrameStyle, imgCalls: calls, borderSize: bs, margin: { imgScale: (A.template.baseMargin||{}).imgScale||1, ox: (A.template.baseMargin||{}).imgOffsetX||0, oy: (A.template.baseMargin||{}).imgOffsetY||0, blur: (A.template.baseMargin||{}).bgBlurEnable||0 },
        displayMax: A.displayMax, canvas: { w: W, h: H }, base, photoRect, expected, actualPhoto, mask: m ? { type: m.type, feather: m.feather, shape: m.shape, inv: !!m.inv } : null,
        overlay: { w: ovW, h: ovH, k, green, greenFromRect, greenFromExpected } };
})()`;

function finish(code) { app.exit(code || 0); }

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try { const u = new URL(req.url); const p = u.searchParams.get('p'); if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 }); return net.fetch(pathToFileURL(p).href); }
        catch (e) { return new Response('NF', { status: 404 }); }
    });
    const win = new BrowserWindow({
        width: 1400, height: 900, show: false,
        webPreferences: { preload: path.join(__dirname, 'preload-measure.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.webContents.on('console-message', (_e, l, m) => { const s = String(m); if (l >= 2 && !/willReadFrequently/.test(s)) console.log('  [renderer] ' + s.slice(0, 200)); });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas && window.__render)')) break;
        await new Promise(r => setTimeout(r, 250));
    }
    await new Promise(r => setTimeout(r, 2200));

    for (const name of ['红章纪念邮票', '纪念邮票']) {
        console.log('═══ ' + name + ' ═══');
        try {
            const r = await win.webContents.executeJavaScript(DIAG(preset(name)));
            console.log(JSON.stringify(r, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v), 1));
        } catch (e) { console.log('DIAG failed: ' + e.message); }
    }
    finish(0);
}).catch(e => { console.error(e); finish(1); });
