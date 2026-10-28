// 验证品牌 Logo 自动匹配:自定义导入的图标能否按文件名命中 EXIF 品牌
// 走真实渲染路径(setupCanvas → brandLogoEntry → brandLogoData),不是复刻逻辑
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

    // 造测试照片(EXIF 品牌可控)
    const c = document.createElement('canvas'); c.width = 1600; c.height = 1200;
    const g = c.getContext('2d');
    g.fillStyle = '#334a63'; g.fillRect(0, 0, 1600, 1200);
    g.fillStyle = 'rgba(255,255,255,0.2)';
    for (let i = 0; i < 50; i++) g.fillRect((i*97)%1600, (i*53)%1200, 40, 24);
    const img = new Image();
    await new Promise(r => { img.onload = r; img.src = c.toDataURL('image/jpeg', 0.9); });

    // 造一张可辨识的"用户导入图标"
    const lc = document.createElement('canvas'); lc.width = 400; lc.height = 160;
    const lg = lc.getContext('2d');
    lg.fillStyle = '#111'; lg.fillRect(0,0,400,160);
    lg.fillStyle = '#fff'; lg.font = 'bold 60px Arial'; lg.fillText('USER', 30, 105);
    const USERLOGO = lc.toDataURL('image/png');

    // 用 PARAM_BOTTOM_LEFT(走风格引擎,且 cameraFor 会用到 EXIF 品牌)
    const style = 'WM_BRAND_LOGO';

    function run(makeVal, modelVal, logos) {
        const im = { el: img, name: 't.jpg', w: 1600, h: 1200,
            exif: { make: makeVal, model: modelVal, focal: '50mm', aperture: 'f/1.8', iso: 'ISO 200', shutter: '1/250' },
            customSettings: null };
        App.images = [im]; App.image = im; App.currentIdx = 0; App.selectedIdx = [];
        App.imageTemplates = new Map();
        App.logos = logos;
        App.logoImgCache = {};
        const p = (App.presets || []).find(x => x.photoFrameStyle === style);
        App.template = p ? JSON.parse(JSON.stringify(p)) : App.defaultTemplate();
        App.template.photoFrameStyle = style;
        App.template.brandLogo = 1;          // 文字+Logo,触发 Logo 预载
        App.template.signBgBlur = 0;
        App.template.logoElements = [];
        App.normalizeTemplate();
        App.invalidateStyleCaches();
        window.__render(App, false);
        // brandLogoEntry 命中后会写 app.logoImgCache[dataUrl];未命中则 cache 为空
        const keys = Object.keys(App.logoImgCache || {});
        return { hit: keys.length > 0, hitIsUser: keys.some(k => k === USERLOGO) };
    }

    const custom = (name) => ({ name, dataUrl: USERLOGO, custom: true });
    const builtin = (name) => ({ name, dataUrl: USERLOGO, custom: false });

    const cases = [];
    const T = (label, make, model, logos, expectHit) => {
        const r = run(make, model, logos);
        cases.push({ label, hit: r.hit, expect: expectHit, ok: r.hit === expectHit });
    };

    // ① 自定义图标:精确品牌名
    T('自定义 Canon.png ← EXIF Canon', 'Canon', 'Canon EOS R5', [custom('Canon.png')], true);
    // ② 自定义图标:带机型后缀(首个词兜底)
    T('自定义 Canon EOS R5.png ← EXIF Canon', 'Canon', 'Canon EOS R5', [custom('Canon EOS R5.png')], true);
    // ③ 自定义图标:大小写不同
    T('自定义 canon.png ← EXIF CANON', 'CANON', 'EOS 5D', [custom('canon.png')], true);
    // ④ 自定义图标:品牌不匹配 → 不应命中
    T('自定义 Nikon.png ← EXIF Canon', 'Canon', 'Canon EOS R5', [custom('Nikon.png')], false);
    // ⑤ 自定义图标:前缀相似但不同品牌 → 不应误命中
    T('自定义 Canonical.png ← EXIF Canon', 'Canon', 'Canon EOS R5', [custom('Canonical.png')], false);
    // ⑥ 自定义图标:黑白变体后缀仍可命中
    T('自定义 Canon_White.png ← EXIF Canon', 'Canon', 'Canon EOS R5', [custom('Canon_White.png')], true);
    // ⑦ 内置图标(回归:改造后仍要命中)
    T('内置 Canon_Black.png ← EXIF Canon', 'Canon', 'Canon EOS R5', [builtin('Canon_Black.png')], true);
    // ⑧ 内置优先于同名自定义
    {
        const logs = [custom('Canon.png'), builtin('Canon_Black.png')];
        const r = run('Canon', 'Canon EOS R5', logs);
        cases.push({ label: '内置与自定义同名时优先内置', hit: r.hit, expect: true, ok: r.hit === true });
    }
    // ⑨ 无任何 logo → 不命中
    T('Logo 池为空 ← EXIF Canon', 'Canon', 'Canon EOS R5', [], false);
    // ⑩ 索尼多词 / 富士
    T('自定义 SONY.png ← EXIF SONY', 'SONY', 'ILCE-7M4', [custom('SONY.png')], true);
    T('自定义 Fujifilm.png ← EXIF FUJIFILM', 'FUJIFILM', 'X-T5', [custom('Fujifilm.png')], true);
    // ⑪ make 带后缀(归一化后仍是单词)与全大写写法
    T('自定义 Hasselblad.png ← EXIF "Hasselblad AB"', 'Hasselblad AB', 'X2D', [custom('Hasselblad.png')], true);
    T('自定义 Hasselblad.png ← EXIF "HASSELBLAD"', 'HASSELBLAD', '907X', [custom('Hasselblad.png')], true);
    // ⑫ 完全表外的品牌:回退用 make 原文匹配
    T('自定义 Acme.png ← EXIF "ACME OPTICS"+9000', 'ACME OPTICS', '9000', [custom('Acme.png')], true);
    // ⑬ 词边界必须成立:Acmeoptics 不应命中 ACME OPTICS
    T('自定义 Acmeoptics.png ← EXIF "ACME OPTICS"+9000', 'ACME OPTICS', '9000', [custom('Acmeoptics.png')], false);
    // ⑭ 品牌与文件名无关时不误命中
    T('自定义 Nikon.png ← EXIF "Hasselblad AB"', 'Hasselblad AB', 'X2D', [custom('Nikon.png')], false);

    return { cases };
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
    win.webContents.on('console-message', (_e, l, m) => { if (l >= 2) console.log('  [renderer] ' + String(m).slice(0, 200)); });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas && window.App.presets)')) break;
        await new Promise(r => setTimeout(r, 250));
    }
    const res = await win.webContents.executeJavaScript(`(${CHECK})()`);
    console.log('品牌 Logo 自动匹配 · 回归测试(走真实渲染路径)');
    console.log('─'.repeat(78));
    let fail = 0;
    for (const c of res.cases) {
        if (!c.ok) fail++;
        console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.label.padEnd(40)} 命中=${c.hit} 期望=${c.expect}`);
    }
    console.log('─'.repeat(78));
    console.log(fail ? `✖ ${fail}/${res.cases.length} 项未通过` : `✓ 全部 ${res.cases.length} 项通过`);
    finish(fail ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });
