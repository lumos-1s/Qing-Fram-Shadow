// 未接入 test:gui（2026-11-10 筛查）：当前红灯 1 项，自定义文字与默认日期渲染结果相同
// （疑似真回归，0.1.24 曾修过同类问题）。待定位修复后再接入，别让 CI 挂红灯。
// 拍立得「底部文字」回归测试
// 需求：POLAROID / POLAROID_HAND 底部日期可替换为自定义文字(模板字段 polaroidCaption)。
// 判定方式：不查内部变量，而是渲染后在画布底部白色相纸区统计非白像素(文字是灰色 160,160,160)。
// 有/无 caption 两次渲染的底部文字区像素必须不同，证明自定义文字真实生效。
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

const CHECK = `
async () => {
    const App = window.App;
    await App.loadPresets();
    const out = [];
    const add = (label, ok, got, expect) => out.push({ label, ok, got, expect });

    const c = document.createElement('canvas'); c.width = 1200; c.height = 900;
    const g = c.getContext('2d');
    g.fillStyle = '#2b4a63'; g.fillRect(0, 0, c.width, c.height);
    const im = new Image();
    await new Promise(r => { im.onload = r; im.src = c.toDataURL('image/jpeg', 0.95); });
    App.images = [{ el: im, name: 'p.jpg', w: im.naturalWidth, h: im.naturalHeight, exif: {}, customSettings: null }];
    App.imageTemplates = new Map();
    App.currentIdx = 0; App.image = App.images[0]; App.selectedIdx = [0];
    App.template = App.defaultTemplate();
    App.template.photoFrameStyle = 'POLAROID';
    App.normalizeTemplate();
    App.refreshUI();
    App.scheduleRender(true);
    await new Promise(r => setTimeout(r, 900));

    const cv = App.dom.canvas;
    function bottomInkCount() {
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let n = 0;
        // 底部 30% 区域(纯白相纸 + 灰色文字)
        const y0 = Math.floor(cv.height * 0.7);
        for (let y = y0; y < cv.height; y++) {
            for (let x = 0; x < cv.width; x += 2) {
                const i = (y * cv.width + x) * 4;
                if (d[i] < 230 || d[i + 1] < 230 || d[i + 2] < 230) n++;
            }
        }
        return n;
    }

    // ① 自定义文字:底部出现非白文字像素
    App.template.polaroidCaption = 'HELLO WORLD';
    App.scheduleRender(true);
    await new Promise(r => setTimeout(r, 500));
    const inkCustom = bottomInkCount();
    add('自定义文字绘制在相纸底部', inkCustom > 50, String(inkCustom), '>50');

    // ② 留空回落到默认日期,且与自定义文字内容不同(像素不同)
    App.template.polaroidCaption = '';
    App.scheduleRender(true);
    await new Promise(r => setTimeout(r, 500));
    const inkDefault = bottomInkCount();
    add('留空回落默认日期(仍有文字)', inkDefault > 50, String(inkDefault), '>50');
    add('自定义文字与默认日期渲染不同', inkCustom !== inkDefault,
        String(inkCustom) + ' vs ' + String(inkDefault), '不同');

    // ③ 「拍立得」组底部文字行:拍立得显示、其它风格隐藏
    const rowPC = () => {
        const el = document.getElementById('rowPolaroidCaption');
        return !!el && window.getComputedStyle(el).display !== 'none';
    };
    const pShown = rowPC();
    App.template.photoFrameStyle = 'SIMPLE';
    App.refreshUI();
    const pSimple = rowPC();
    App.template.photoFrameStyle = 'POLAROID';
    App.refreshUI();
    add('拍立得显示「底部文字」、其它风格隐藏', pShown && !pSimple,
        '拍立得=' + pShown + ' / SIMPLE=' + pSimple, 'true / false');

    // ④ 手写拍立得同样生效
    App.template.photoFrameStyle = 'POLAROID_HAND';
    App.template.polaroidCaption = 'HI!';
    App.refreshUI();
    App.scheduleRender(true);
    await new Promise(r => setTimeout(r, 500));
    const inkHand = bottomInkCount();
    add('手写拍立得自定义文字生效', inkHand > 50, String(inkHand), '>50');

    return { out, canvas: cv.width + 'x' + cv.height };
}
`;

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
    console.log('拍立得「底部文字」回归测试');
    console.log('─'.repeat(90));
    console.log('  画布: ' + result.canvas);
    let fail = 0;
    for (const c of result.out) {
        if (!c.ok) fail++;
        console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.label.padEnd(34)} 实际=${c.got}  期望=${c.expect}`);
    }
    console.log('─'.repeat(90));
    console.log(fail ? `✖ ${fail} 项异常` : '✓ 全部通过');
    finish(fail ? 1 : 0);
});
