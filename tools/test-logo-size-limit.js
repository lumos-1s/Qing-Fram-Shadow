// Logo 放大上限回归测试
// 需求：Logo 缩放最大 500px，且滑块/数值框/方向键/旧模板都不能突破。
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

    // 造一张 1800x1350 的图，DPR 2 时显示画布为 3600x2700
    const c = document.createElement('canvas'); c.width = 1800; c.height = 1350;
    const g = c.getContext('2d');
    g.fillStyle = '#2b4a63'; g.fillRect(0, 0, c.width, c.height);
    const im = new Image();
    await new Promise(r => { im.onload = r; im.src = c.toDataURL('image/jpeg', 0.9); });
    const image = { el: im, name: 'logo-limit.jpg', w: im.naturalWidth, h: im.naturalHeight, exif: {}, customSettings: null };

    // Logo 300x120（ratio 0.4），初始 120
    const lc = document.createElement('canvas'); lc.width = 300; lc.height = 120;
    const lg = lc.getContext('2d');
    lg.fillStyle = '#e8442a'; lg.fillRect(0, 0, 300, 120);
    lg.fillStyle = '#fff'; lg.font = 'bold 48px Arial'; lg.fillText('LOGO', 40, 80);
    const logoData = lc.toDataURL('image/png');

    const el = { name: 'L', dataUrl: logoData, x: 900, y: 675, size: 120, ratio: 0.4, opacity: 100, z: 10 };
    App.images = [image]; App.imageTemplates = new Map();
    App.currentIdx = 0; App.image = image; App.selectedIdx = [0];
    App.template = App.defaultTemplate();
    App.template.logoElements = [el];
    App.selectedEls = [{ kind: 'logo', obj: el }];
    App.normalizeTemplate();
    App.invalidateStyleCaches();
    App.scheduleRender(true);
    await new Promise(r => setTimeout(r, 800));

    const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.01 : tol);
    const add = (label, ok, got, expect) => out.push({ label, ok, got, expect });

    // ① 上限本身
    const max = App.logoMaxSize(el);
    add('Logo 上限 = 500', max === 500, max, 500);

    // ② 滑块拖到最右
    {
        const s = document.getElementById('slElementSize');
        s.value = 1000;
        s.dispatchEvent(new Event('input', { bubbles: true }));
        add('滑块拖到最右后仍为 500', el.size === 500, el.size, 500);
    }

    // ③ 数值框输入 9999
    {
        const n = document.getElementById('inpElSize');
        n.value = 9999;
        n.dispatchEvent(new Event('change', { bubbles: true }));
        add('数值框输入 9999 后仍为 500', el.size === 500, el.size, 500);
    }

    // ④ 方向键/滚轮放大（nudgeElement）
    {
        el.size = 480;
        App.nudgeElement({ kind: 'logo', obj: el }, 'scale', 1);
        const once = el.size;
        App.nudgeElement({ kind: 'logo', obj: el }, 'scale', 1);
        add('连续放大不超过 500', once === 500 && el.size === 500, once + ' → ' + el.size, '500 → 500');
    }

    // ⑤ 旧模板/导入模板中的超大 Logo 在 normalize 时收回
    {
        el.size = 1600;
        App.normalizeTemplate();
        add('旧模板超大 Logo 归一化后为 500', el.size === 500, el.size, 500);
    }

    // ⑥ 手势期 canvas 临时缩小，不能把上限一起缩掉
    {
        const before = App.logoMaxSize(el);
        App.beginGesture();
        const during = App.logoMaxSize(el);
        App.endGesture();
        add('手势期上限不缩水', near(before, 500) && near(during, 500), before + ' → ' + during, '500 → 500');
    }

    return { out, canvas: App.dom.canvas.width + 'x' + App.dom.canvas.height };
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
    console.log('Logo 放大上限回归测试');
    console.log('─'.repeat(90));
    console.log('  画布: ' + result.canvas);
    let fail = 0;
    for (const c of result.out) {
        if (!c.ok) fail++;
        console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.label.padEnd(30)} 实际=${c.got}  期望=${c.expect}`);
    }
    console.log('─'.repeat(90));
    console.log(fail ? `✖ ${fail} 项异常` : '✓ 全部通过');
    finish(fail ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });
