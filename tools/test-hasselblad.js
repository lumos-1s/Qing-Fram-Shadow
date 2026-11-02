// 哈苏水印回归测试
// 需求:独立预设 HASSELBLAD —— 白底相框 + 底部白条:左下品牌文字(可输入任意文字,留空回落照片品牌型号),
// 品牌下方一排彩色色卡,右下拍摄参数。
// 判定方式:渲染后在画布底部白色区域统计 ①非白像素(文字) ②高饱和彩色像素(色卡) ③两种品牌文字渲染是否不同。
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
    App.images = [{ el: im, name: 'h.jpg', w: im.naturalWidth, h: im.naturalHeight, exif: {}, customSettings: null }];
    App.imageTemplates = new Map();
    App.currentIdx = 0; App.image = App.images[0]; App.selectedIdx = [0];
    App.template = App.defaultTemplate();
    App.template.photoFrameStyle = 'HASSELBLAD';
    App.template.hassyCaption = 'OPPO Find X8 Ultra';
    App.normalizeTemplate();
    App.refreshUI();
    await App.flushRender();

    const cv = App.dom.canvas;
    // 底部 35% 区域:白相纸 + 品牌/参数文字 + 色卡(步长 1 全采样)
    function bottomStats() {
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let ink = 0, color = 0;
        const y0 = Math.floor(cv.height * 0.65);
        for (let y = y0; y < cv.height; y++) {
            for (let x = 0; x < cv.width; x++) {
                const i = (y * cv.width + x) * 4;
                const r = d[i], gg = d[i + 1], b = d[i + 2];
                if (r < 230 || gg < 230 || b < 230) ink++;
                const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
                if (mx - mn > 40 && mx > 60) color++;
            }
        }
        return { ink, color };
    }

    // ① 品牌+参数+色卡都画出来了
    const s1 = bottomStats();
    add('底部绘制品牌/参数文字', s1.ink > 100, String(s1.ink), '>100');
    add('色卡彩色像素存在', s1.color > 20, String(s1.color), '>20');

    // ② 自定义品牌文字可改且渲染不同
    App.template.hassyCaption = 'MY CAMERA';
    App.normalizeTemplate();
    await App.flushRender();
    const s2 = bottomStats();
    add('修改品牌文字后渲染不同', Math.abs(s2.ink - s1.ink) > 20,
        String(s1.ink) + ' vs ' + s2.ink, '差>20');

    // ③ 留空回落默认(照片无 EXIF → OPPO Find X8 Ultra)
    App.template.hassyCaption = '';
    App.normalizeTemplate();
    await App.flushRender();
    const s3 = bottomStats();
    add('留空回落默认品牌(仍有文字)', s3.ink > 100, String(s3.ink), '>100');

    // ④ 「哈苏水印」组品牌文字行:该风格显示、其它风格隐藏
    const rowHC = () => {
        const el = document.getElementById('rowHassyCaption');
        return !!el && window.getComputedStyle(el).display !== 'none';
    };
    const hShown = rowHC();
    App.template.photoFrameStyle = 'SIMPLE';
    App.refreshUI();
    const hSimple = rowHC();
    App.template.photoFrameStyle = 'HASSELBLAD';
    App.refreshUI();
    add('哈苏水印显示「品牌文字」、其它风格隐藏', hShown && !hSimple,
        '哈苏=' + hShown + ' / SIMPLE=' + hSimple, 'true / false');

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
    console.log('哈苏水印回归测试');
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
