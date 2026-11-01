// 液态玻璃「玻璃条大小」回归测试
// 需求：液态玻璃预设要能手动调整玻璃条大小；改的是整条（高度/内边距/文字/阴影一起缩放），
//       且只有液态玻璃这一款能看到这一行。
//
// 判定方式：不查引擎内部变量，而是渲染后在画布正中取一列像素，量出玻璃条的实际高度。
// 照片用纯色 —— 玻璃条内部是「模糊底 + 暗色 tint」，整片比照片暗一截，边界可直接数出来。
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
for (const c of ['list-logos', 'list-textures', 'list-templates']) ipcMain.handle(c, () => []);
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
    const out = [];
    const add = (label, ok, got, expect) => out.push({ label, ok, got, expect });
    const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.02 : tol) * Math.max(1, Math.abs(b));

    // 纯色照片：玻璃条内部会比它暗一截，边界才能数出来
    const c = document.createElement('canvas'); c.width = 1800; c.height = 1350;
    const g = c.getContext('2d');
    g.fillStyle = '#2b4a63'; g.fillRect(0, 0, c.width, c.height);
    const im = new Image();
    await new Promise(r => { im.onload = r; im.src = c.toDataURL('image/jpeg', 0.95); });
    App.images = [{ el: im, name: 'glass.jpg', w: im.naturalWidth, h: im.naturalHeight, exif: {}, customSettings: null }];
    App.imageTemplates = new Map();
    App.currentIdx = 0; App.image = App.images[0]; App.selectedIdx = [0];
    App.template = App.defaultTemplate();
    App.template.photoFrameStyle = 'LIQUID_GLASS';
    App.normalizeTemplate();
    App.refreshUI();
    App.scheduleRender(true);
    await new Promise(r => setTimeout(r, 900));

    // 画布正中取一列：竖着数出「比照片暗」的连续段 = 玻璃条
    const cv = App.dom.canvas;
    function capHeight() {
        const x = Math.floor(cv.width / 2);
        const d = cv.getContext('2d').getImageData(x, 0, 1, cv.height).data;
        const lum = (y) => { const i = y * 4; return d[i] + d[i + 1] + d[i + 2]; };
        const base = lum(2);                 // 顶部是满幅照片本体
        let top = -1, bot = -1;
        for (let y = 0; y < cv.height; y++) {
            if (base - lum(y) > 40) { if (top < 0) top = y; bot = y; }
        }
        return top < 0 ? 0 : (bot - top + 1);
    }
    // 玻璃条带逐像素折射，重绘比轮询慢;量之前要等画面「稳定」(连续两次读数一致),
    // 否则量到的是上一帧 —— 本机 swiftshader 下 200% 那一帧实测需要 1s 上下。
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    async function settle() {
        let last = -1;
        for (let i = 0; i < 40; i++) {
            await sleep(250);
            const h = capHeight();
            if (h > 0 && h === last) return h;
            last = h;
        }
        return last;
    }
    const setSlider = async (v) => {
        const s = document.getElementById('slGlassSize');
        s.value = String(v);
        s.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(300);
        return settle();
    };
    const rowShown = () => {
        const el = document.getElementById('rowGlassSize');
        return !!el && window.getComputedStyle(el).display !== 'none';
    };

    // ① 只有液态玻璃看得到这一行
    const lgShown = rowShown();
    App.template.photoFrameStyle = 'SIMPLE';
    App.refreshUI();
    const simpleShown = rowShown();
    App.template.photoFrameStyle = 'LIQUID_GLASS';
    App.refreshUI();
    add('液态玻璃显示「玻璃条大小」、其它风格隐藏', lgShown && !simpleShown,
        '液态玻璃=' + lgShown + ' / SIMPLE=' + simpleShown, 'true / false');

    // ② 默认 100%
    const sl = document.getElementById('slGlassSize');
    add('滑块默认 100%', String(sl.value) === '100', sl.value, '100');

    const h100 = await settle();
    add('默认能画出玻璃条', h100 > 20, h100, '>20');

    // ③ 200% → 高度翻倍
    const h200 = await setSlider(200);
    add('200% 时玻璃条高度 ≈ 2×', near(h200 / h100, 2, 0.08), (h200 / h100).toFixed(3), '2.000');

    // ④ 50% → 高度减半
    const h50 = await setSlider(50);
    add('50% 时玻璃条高度 ≈ 0.5×', near(h50 / h100, 0.5, 0.08), (h50 / h100).toFixed(3), '0.500');

    // ⑤ 值写进模板，并随上次状态记住
    await setSlider(150);
    App.saveLastState && App.saveLastState();
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('qfs_last_state') || 'null'); } catch (e) { saved = null; }
    add('模板记住 150%', near(App.template.liquidGlassSize, 1.5, 0.001), App.template.liquidGlassSize, '1.5');
    add('上次状态也带上大小', !!(saved && near(saved.liquidGlassSize, 1.5, 0.001)),
        saved ? saved.liquidGlassSize : 'null', '1.5');

    // ⑥ 脏值兜底：0 或 'abc' 不能把玻璃条画没（认不出就回落 100%）
    const base100 = await setSlider(100);
    App.template.liquidGlassSize = 0;
    App.scheduleRender(true);
    const hZero = await settle();
    App.template.liquidGlassSize = 'abc';
    App.scheduleRender(true);
    const hJunk = await settle();
    add('脏值(0 / abc)回落成原尺寸而不是画没',
        hZero > 20 && near(hZero, base100, 0.05) && near(hJunk, base100, 0.05),
        hZero + ' / ' + hJunk, base100 + ' / ' + base100);

    return { out, canvas: cv.width + 'x' + cv.height };
}
`;

// 退出码收尾:Electron 主进程完全忽略 process.exitCode(app.quit() 之后设 1 实测仍得 0),
// 只有 app.exit(code) 能带出非 0。
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
    win.webContents.on('console-message', (_e, l, m) => { if (l >= 2) console.log('  [renderer] ' + String(m).slice(0, 250)); });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas && window.App.presets)')) break;
        await new Promise(r => setTimeout(r, 250));
    }

    const result = await win.webContents.executeJavaScript(`(${CHECK})()`);
    console.log('液态玻璃「玻璃条大小」回归测试');
    console.log('─'.repeat(90));
    console.log('  画布: ' + result.canvas);
    let fail = 0;
    for (const c of result.out) {
        if (!c.ok) fail++;
        console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.label.padEnd(32)} 实际=${c.got}  期望=${c.expect}`);
    }
    console.log('─'.repeat(90));
    console.log(fail ? `✖ ${fail} 项异常` : '✓ 全部通过');
    finish(fail ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });
