// 验证拖动叠加层与整帧渲染的一致性(含 DPR>1 与降分辨率两种情形)
// 背景:元素坐标改为相对比例后,叠加层若不解析 rel/不换算基准→最终画布,拖动中元素会跳位。
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
// 主进程 stdout/stderr 在管道调用方(CI/npm/PowerShell)关闭后,残留日志会触发 EPIPE 弹窗;吞掉它。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);
ipcMain.handle('list-presets', () => fs.readdirSync(path.join(ROOT, 'shared', 'presets')).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'presets', n + '.json'), 'utf8')));
ipcMain.handle('list-logos', () => []);
ipcMain.handle('list-textures', () => []);
ipcMain.handle('list-templates', () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}

const CHECK = `
async () => {
    const App = window.App;
    await App.loadPresets();
    const cases = [];

    async function mkImg(W, H) {
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d');
        const grd = g.createLinearGradient(0, 0, W, H);
        grd.addColorStop(0, '#24405c'); grd.addColorStop(1, '#9c6a38');
        g.fillStyle = grd; g.fillRect(0, 0, W, H);
        for (let i = 0; i < 30; i++) { g.fillStyle = 'rgba(255,255,255,0.2)'; g.fillRect((i*97)%W, (i*53)%H, 40, 24); }
        const im = new Image();
        await new Promise(r => { im.onload = r; im.src = c.toDataURL('image/jpeg', 0.9); });
        return { el: im, name: 'p.jpg', w: im.naturalWidth, h: im.naturalHeight, exif: {}, customSettings: null };
    }
    const lc = document.createElement('canvas'); lc.width = 300; lc.height = 120;
    const lg = lc.getContext('2d');
    lg.fillStyle = '#e8442a'; lg.fillRect(0, 0, 300, 120);
    lg.fillStyle = '#fff'; lg.font = 'bold 48px Arial'; lg.fillText('LOGO', 40, 80);
    const LOGO = lc.toDataURL('image/png');

    const img = await mkImg(1800, 1350);
    App.images = [img]; App.image = img; App.currentIdx = 0; App.selectedIdx = [0];
    App.imageTemplates = new Map();

    function snap() {
        const cv = App.dom.canvas;
        return new Uint8ClampedArray(cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data);
    }
    function diff(a, b) {
        let n = 0, maxD = 0;
        let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
        const w = App.dom.canvas.width;
        for (let i = 0, p = 0; i < a.length; i += 4, p++) {
            const d = Math.max(Math.abs(a[i]-b[i]), Math.abs(a[i+1]-b[i+1]), Math.abs(a[i+2]-b[i+2]));
            if (d > 8) {
                n++;
                const px = p % w, py = (p / w) | 0;
                if (px < minX) minX = px; if (px > maxX) maxX = px;
                if (py < minY) minY = py; if (py > maxY) maxY = py;
            }
            if (d > maxD) maxD = d;
        }
        return { pct: Math.round(n / (a.length/4) * 10000) / 100, maxD, box: maxX < 0 ? null : [minX, minY, maxX, maxY] };
    }

    // 三种情形:正常 / DPR=2 / 拖动降分辨率到 900
    for (const cfg of [
        { label: 'DPR=1 正常', dpr: 1, cap: undefined },
        { label: 'DPR=2 正常', dpr: 2, cap: undefined },
        { label: 'DPR=2 + 拖动降分辨率 900', dpr: 2, cap: 900 },
        { label: 'DPR=1 + 拖动降分辨率 900', dpr: 1, cap: 900 },
    ]) {
        App.uiDprOverride = cfg.dpr;
        if (cfg.cap === undefined) delete App.displayMax; else App.displayMax = cfg.cap;
        App.template = App.defaultTemplate();
        App.template.logoElements = [];
        App.normalizeTemplate();
        App.invalidateStyleCaches();
        App.scheduleRender(true);
        await new Promise(r => setTimeout(r, 800));

        const base = App.logoBaseSize();
        const el = { name: 'L', dataUrl: LOGO, x: 0, y: 0, size: Math.round((base ? base.w : 1800) * 0.15), ratio: 0.4, opacity: 100, z: 10 };
        App.template.logoElements = [el];
        App.setLogoPixelPos(el, (base ? base.w : 1800) * 0.75, (base ? base.h : 1350) * 0.7);
        App.normalizeTemplate();
        App.invalidateStyleCaches();
        App.scheduleRender(true);
        await new Promise(r => setTimeout(r, 800));

        const cv = App.dom.canvas;
        const info = 'canvas=' + cv.width + 'x' + cv.height + ' base=' + (base ? base.w + 'x' + base.h : 'null') + ' rel=' + el.rel + ' rx=' + (el.rx != null ? el.rx.toFixed(3) : '-');

        // A) 整帧渲染(含元素)
        App._dragEl = null; App._skipUserEl = null; App._dropDragBase();
        window.__render(App, false);
        const A = snap();

        // B) 叠加层:背景(排除元素) + blit + 只画被拖元素
        App._dragEl = { kind: 'logo', ref: el, sx: 0, sy: 0, x: 0, y: 0, moved: true };
        App._skipUserEl = el;
        App._dropDragBase();
        window.__render(App, false);
        App._dragBaseBuild();
        App._blitDragBase();
        App._drawDraggedEl(cv.getContext('2d'), el, 'logo');
        const B = snap();

        const d = diff(A, B);
        cases.push({
            label: cfg.label, info, pct: d.pct, maxD: d.maxD, ok: d.pct < 0.5,
            diffBox: d.box ? d.box.join(',') : '无',
        });
        App._dragEl = null; App._skipUserEl = null; App._dropDragBase();
        delete App.uiDprOverride;
    }
    return cases;
}
`;

// 退出码收尾:Electron 主进程完全忽略 process.exitCode(app.quit() 之后设 1 实测仍得 0),
// 只有 app.exit(code) 能带出非 0。此前本文件只调 app.quit(),断言失败也返回 0。
function finish(code) { app.exit(code || 0); }

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try { const u = new URL(req.url); const p = u.searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (e) { return new Response('NF', { status: 404 }); }
    });
    const win = new BrowserWindow({
        width: 1400, height: 900, show: false,
        webPreferences: { preload: path.join(__dirname, 'preload-measure.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.webContents.on('console-message', (_e, l, m) => { const s = String(m); if (l >= 2 && !/willReadFrequently/.test(s)) console.log('  [renderer] ' + s.slice(0, 200)); });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas && window.App.presets)')) break;
        await new Promise(r => setTimeout(r, 250));
    }
    const cases = await win.webContents.executeJavaScript(`(${CHECK})()`);
    let fail = 0;
    console.log('拖动叠加层 vs 整帧渲染 一致性');
    console.log('─'.repeat(88));
    for (const c of cases) {
        if (!c.ok) fail++;
        console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.label}`);
        console.log(`       ${c.info}`);
        console.log(`       显著差异像素 ${c.pct}%  最大通道差 ${c.maxD}  差异范围 ${c.diffBox}`);
    }
    console.log('─'.repeat(88));
    console.log(fail ? `✖ ${fail}/${cases.length} 项不一致` : `✓ 全部 ${cases.length} 项一致`);
    finish(fail ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });
