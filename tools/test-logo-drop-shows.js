// 未接入 test:gui（2026-11-10 筛查）：当前红灯 1 项（画布 logo 中心未取到红像素），
// 同组的 test-logo-click-select-shows.js 已全绿并接入，本脚本待核对取点坐标后再接入。
// 回归：把 Logo 拖到画布上(走 addLogoElement)后，必须在首帧就画出来，不能依赖
// 「引擎自己再加载一遍位图 + onload 补帧」这条会偶发丢失的链路(曾经表现为
// 「拖上去了但 logo 不显示，得再动一下鼠标才出来」)。
//
// 本用例直连 addLogoElement(真实放置路径的落点)，验证三件事：
//   ① logo 被加入 template.logoElements；
//   ② 引擎位图缓存 getElementBitmap(dataUrl) 在放置后立即可用(complete && naturalWidth>0)，
//      即首帧就有图可画，不再等第二帧；
//   ③ flushRender 之后，画布在 logo 中心位置确实出现了 logo 的颜色(而非背景/照片色)，
//      证明它真正被绘制出来。
//
// 同源事件管线问题(图标 <img> 默认可拖拽，会被浏览器原生图片拖放劫持，吞掉自研
// 拖拽的 mousemove/mouseup)由代码层把 img.draggable=false + dragstart preventDefault 修复，
// 该路径无法在 headless CDP 下稳定复现，故此处只断言放置结果。
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
    const settle = async (needBase) => {
        let prev = '', stable = 0;
        for (let i = 0; i < 60 && stable < 2; i++) {
            const rr = A.dom.canvas.getBoundingClientRect();
            const cvv = A.dom.canvas;
            const cur = [Math.round(rr.left), Math.round(rr.top), Math.round(rr.width), Math.round(rr.height), cvv.width, cvv.height].join(',');
            stable = (cur === prev && (!needBase || A.logoBaseSize())) ? stable + 1 : 0;
            prev = cur;
            await new Promise(res => setTimeout(res, 250));
        }
    };
    A.scheduleRender(true);
    await settle(true);
    // 造一个红底白字 Logo
    const lc = document.createElement('canvas'); lc.width = 300; lc.height = 120;
    const lg = lc.getContext('2d');
    lg.fillStyle = '#e8442a'; lg.fillRect(0, 0, 300, 120);
    lg.fillStyle = '#fff'; lg.font = 'bold 48px Arial'; lg.fillText('LOGO', 40, 80);
    const logoUrl = lc.toDataURL('image/png');
    await A.addLogoElement({ name: 'T', dataUrl: logoUrl });
    await A.flushRender();
    const bmp = (typeof window.getElementBitmap === 'function') ? window.getElementBitmap(logoUrl) : null;
    // 在 logo 中心采样画布像素：红底 logo 应给出 R 明显大于 G/B 的像素
    const el = (A.template.logoElements || [])[0];
    const cv = A.dom.canvas, ctx = cv.getContext('2d');
    let pixel = null;
    if (el) {
        const b = A.logoBaseForOverlay();
        const p = A.logoPos(el, b.w, b.h, el.size);
        // 设备像素坐标 = 显示比例 × canvas.width
        const dx = Math.round((p.cx / cv.width) * cv.width);
        const dy = Math.round((p.cy / cv.height) * cv.height);
        try { const d = ctx.getImageData(dx, dy, 1, 1).data; pixel = [d[0], d[1], d[2], d[3]]; } catch (e) { pixel = 'tainted:' + e.message; }
    }
    return {
        count: (A.template.logoElements || []).length,
        bmpOk: !!(bmp && bmp.complete && bmp.naturalWidth > 0),
        selected: A.selectedEls.length,
        pixel,
        elSize: el ? el.size : 0,
    };
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

    console.log('Logo 放置后首帧可见(回归)');
    console.log('─'.repeat(84));
    const s = await win.webContents.executeJavaScript(SETUP);
    console.log('  raw: ' + JSON.stringify(s));
    if (!s) { console.log('  SETUP 无返回'); finish(1); return; }

    line(s.count === 1, '① logo 已加入 template.logoElements', `count=${s.count}`, '1');
    line(s.bmpOk, '② 引擎位图缓存首帧即可用(getElementBitmap complete)', `bmpOk=${s.bmpOk}`, 'true');
    line(s.selected === 1, '③ 放置后选中该 logo', `selected=${s.selected}`, '1');
    // 红底 logo 中心像素:红通道应明显大于绿/蓝(背景是蓝 #5a86bb: R~90 G~134 B~187)
    const px = s.pixel;
    const reddish = Array.isArray(px) && px[0] > px[1] + 30 && px[0] > px[2] + 30;
    line(reddish, '④ 画布在 logo 中心确实绘制出 logo(红像素)',
        Array.isArray(px) ? `rgb(${px[0]},${px[1]},${px[2]})` : String(px), 'R 明显 > G 且 > B');

    console.log('─'.repeat(84));
    console.log(fails.length
        ? `✖ ${fails.length} 项未通过: ${fails.join('、')}`
        : `✓ 全部 4 项通过`);
    finish(fails.length ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });
