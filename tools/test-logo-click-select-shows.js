// 回归：点击画布上的 Logo 选中它之后，Logo 不能变空白（只留绿色选框）。
//
// 旧 bug：mousedown 选中元素时会把 app._skipUserEl 指向该 Logo（引擎 _filterUserEls 据此
// 把该元素从「拖拽优化的静态背景」里排除，首帧就把 Logo 画空）；mouseup 在 _dragEl 分支里
// 清掉了 _skipUserEl，但**没有重绘**，于是屏幕卡在「有选框、Logo 空白」的最后一帧，
// 直到别的操作触发重绘(所以时好时坏)。本用例真实派发 mousedown(选中)+ mouseup(松手)，
// 断言：① 选中后 _skipUserEl 指向该 Logo 且画布该处被排除(非红) ② 松手后 _skipUserEl 清空
// 且画布该处重新画出 Logo(红)。若缺了 mouseup 里的 scheduleRender，② 会拿不到红像素。
//
// 同源事件管线问题无法在 headless 下 100% 复现时序，但 mousedown/mouseup 是真实事件，
// 足以稳定抓住「松手后是否重绘」这一核心差异。
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

const SETUP = `
(async () => {
    const A = window.App;
    A.showIntroIfNeeded = () => {};
    const _intro = document.getElementById('introModal');
    if (_intro) _intro.style.display = 'none';
    const c = document.createElement('canvas'); c.width = 1000; c.height = 800;
    const g = c.getContext('2d'); g.fillStyle = '#5a86bb'; g.fillRect(0, 0, 1000, 800);
    const im = new Image();
    await new Promise(r => { im.onload = r; im.src = c.toDataURL('image/jpeg', 0.9); });
    A.image = { el: im, name: 'p.jpg', w: 1000, h: 800, exif: {} };
    A.images = [A.image];
    A.imageTemplates = new Map();
    A.selectedIdx = [0]; A.currentIdx = 0; A.selectedEls = [];
    if (typeof A.updateEmptyState === 'function') A.updateEmptyState();
    A.template = A.defaultTemplate();
    A.template.photoFrameStyle = 'NONE';
    A.template.logoElements = [];
    A.normalizeTemplate();
    A.invalidateStyleCaches();
    delete A.uiDprOverride; delete A.exportScale; A.displayMax = undefined;
    // 等画布稳定
    const settle = async () => {
        for (let i = 0; i < 60; i++) {
            const rr = A.dom.canvas.getBoundingClientRect();
            if (rr.width > 10 && A.dom.canvas.width > 1) break;
            await new Promise(res => setTimeout(res, 250));
        }
    };
    A.scheduleRender(true);
    await settle();
    // 纯红方块 Logo(无文字,避免采样落在白字上导致误判)
    const lc = document.createElement('canvas'); lc.width = 200; lc.height = 200;
    const lg = lc.getContext('2d');
    lg.fillStyle = '#e8442a'; lg.fillRect(0, 0, 200, 200);
    const logoUrl = lc.toDataURL('image/png');
    await A.addLogoElement({ name: 'T', dataUrl: logoUrl });
    await A.flushRender();

    // 取 Logo 中心在画布上的设备像素坐标
    const el = (A.template.logoElements || [])[0];
    const b = A.logoBaseForOverlay();
    const p = A.logoPos(el, b.w, b.h, el.size);
    const cv = A.dom.canvas, ctx = cv.getContext('2d');
    const sample = () => {
        try { const d = ctx.getImageData(Math.round(p.cx), Math.round(p.cy), 1, 1).data; return [d[0], d[1], d[2], d[3]]; }
        catch (e) { return 'tainted:' + e.message; }
    };
    const reddish = (px) => Array.isArray(px) && px[0] > px[1] + 30 && px[0] > px[2] + 30;

    const center = () => {
        const r = cv.getBoundingClientRect();
        return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, bubbles: true };
    };

    const out = {};
    out.baselinePixel = sample();
    out.baselineRed = reddish(out.baselinePixel);
    out.skipBefore = A._skipUserEl || null;

    // ① 真实点击选中 Logo：mousedown(canvas)
    cv.dispatchEvent(new MouseEvent('mousedown', center()));
    // 让选中那帧(已排除该 Logo)真的画出来
    await A.flushRender();
    out.skipAfterDown = A._skipUserEl || null;
    out.skipIsLogo = !!(out.skipAfterDown && el && out.skipAfterDown === el);
    out.excludedPixel = sample();
    out.excludedRed = reddish(out.excludedPixel);

    // ② 真实松手：mouseup(window)
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    // 关键：若 mouseup 没重绘，这里仍会是排除态(蓝底)
    await A.flushRender();
    out.skipAfterUp = A._skipUserEl || null;
    out.restoredPixel = sample();
    out.restoredRed = reddish(out.restoredPixel);
    out.selectedCount = A.selectedEls.length;

    return out;
})()
`;

function finish(code) { app.exit(code || 0); }

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try {
            const u = new URL(req.url); const p = u.searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (e) { return new Response('NF', { status: 404 }); }
    });
    const win = new BrowserWindow({
        width: 1400, height: 900, show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
        },
    });
    win.webContents.on('console-message', (_e, l, m) => {
        const s = String(m); if (l >= 2 && !/willReadFrequently/.test(s)) console.log('  [renderer] ' + s.slice(0, 200));
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas)')) break;
        await new Promise(r => setTimeout(r, 250));
    }

    const fails = [];
    const line = (ok, label, got, expect) => {
        console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
        console.log(`       ${got}${expect ? '   期望: ' + expect : ''}`);
        if (!ok) fails.push(label);
    };

    console.log('点击选中 Logo 后不应变空白(回归)');
    console.log('─'.repeat(84));
    const s = await win.webContents.executeJavaScript(SETUP);
    console.log('  raw: ' + JSON.stringify(s));
    if (!s) { console.log('  SETUP 无返回'); finish(1); return; }

    line(s.baselineRed, '① 放置后 Logo 正常可见(红像素)',
        Array.isArray(s.baselinePixel) ? `rgb(${s.baselinePixel.join(',')})` : String(s.baselinePixel), 'R 明显 > G 且 > B');
    line(s.skipIsLogo, '② 选中(mousedown)后 _skipUserEl 指向该 Logo(触发排除)',
        s.skipIsLogo ? '是' : `skipAfterDown=${String(s.skipAfterDown)}`, '是');
    line(!s.excludedRed, '③ 选中瞬间该处被排除(非红,证明机制存在)',
        Array.isArray(s.excludedPixel) ? `rgb(${s.excludedPixel.join(',')})` : String(s.excludedPixel), '非红');
    line(s.skipAfterUp === null, '④ 松手(mouseup)后 _skipUserEl 清空',
        String(s.skipAfterUp), 'null');
    line(s.restoredRed, '⑤ 松手后 Logo 重新画出(红像素,修复核心:松手必须重绘)',
        Array.isArray(s.restoredPixel) ? `rgb(${s.restoredPixel.join(',')})` : String(s.restoredPixel), 'R 明显 > G 且 > B');

    console.log('─'.repeat(84));
    console.log(fails.length
        ? `✖ ${fails.length} 项未通过: ${fails.join('、')}`
        : `✓ 全部 5 项通过`);
    finish(fails.length ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });
