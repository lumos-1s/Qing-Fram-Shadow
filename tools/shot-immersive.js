// 沉浸式照片展示审阅截图。
// 用法：node tools/run-electron.js tools/shot-immersive.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const SAMPLE_DIR = path.join(ROOT, 'design', 'home-prototype-assets', 'samples');
const OUT = path.join(process.env.TEMP || '.', 'qingframe-immersive');
const SAMPLES = ['city.webp', 'desert.webp', 'forest.webp', 'lake.webp', 'portrait.webp', 'still.webp'];
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    const datas = SAMPLES.map((name) => 'data:image/webp;base64,' + fs.readFileSync(path.join(SAMPLE_DIR, name)).toString('base64'));
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        show: false,
        paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (expr) => win.webContents.executeJavaScript(expr);
    await sleep(400);
    win.showInactive();
    win.setContentSize(1400, 900);
    await exec(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(1600);

    const setup = await exec(`(async () => {
        const App = window.App;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 80 && (!App.presets || App.presets.length < 6); i++) await wait(100);
        const srcs = ${JSON.stringify(datas)};
        const names = ['海边日落.jpg', '沙丘公路.jpg', '森林晨雾.jpg', '湖边倒影.jpg', '人物肖像.jpg', '静物台面.jpg'];
        const imgs = [];
        for (let i = 0; i < 6; i++) {
            const img = new Image();
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = () => reject(new Error('sample failed'));
                img.src = srcs[i];
            });
            imgs.push({ el: img, name: names[i], w: img.naturalWidth, h: img.naturalHeight, exif: {}, thumb: srcs[i], customSettings: null });
        }
        const wanted = ['GALLERY', 'TORN_FILM', 'NEWSPAPER', 'POLAROID_HAND', 'VINTAGE', 'MAGAZINE'];
        const picks = [];
        for (const style of wanted) {
            const p = App.presets.find((x) => String(x.photoFrameStyle || '').toUpperCase() === style);
            if (p) picks.push(p);
        }
        for (const p of App.presets) {
            if (picks.length >= 6) break;
            if (picks.indexOf(p) < 0) picks.push(p);
        }
        App.images = imgs;
        App.currentIdx = 1;
        App.image = imgs[1];
        App.selectedIdx = [1];
        App.batchSel = [];
        App.imageTemplates = new Map();
        imgs.forEach((im, i) => {
            const tpl = JSON.parse(JSON.stringify(picks[i] || picks[0]));
            im.customSettings = tpl;
            App.imageTemplates.set(im, tpl);
        });
        App.template = JSON.parse(JSON.stringify(App.imageTemplates.get(imgs[1])));
        App._followFit = false;
        App.buildThumbnails();
        App.updateEmptyState();
        App.afterImageSelect();
        await wait(600);
        return { ok: true, count: imgs.length, preset: App.template.templateName || App.template.photoFrameStyle };
    })()`);
    if (!setup || !setup.ok) throw new Error('setup failed');

    const shot = async (name) => {
        const image = await win.webContents.capturePage();
        const file = path.join(OUT, name + '.png');
        fs.writeFileSync(file, image.toPNG());
        console.log('SHOT', file);
    };

    await shot('00-editor-1400x900');
    await exec(`document.getElementById('btnImmersive').focus(); document.getElementById('btnImmersive').click(); true`);
    await sleep(900);
    await exec(`window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 300, clientY: 200 })); true`);
    await sleep(250);
    await shot('01-immersive-1400x900');

    await sleep(2400);
    await shot('02-immersive-idle-1400x900');

    await exec(`window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 300, clientY: 200 })); true`);
    await sleep(300);
    await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); true`);
    await sleep(1500);
    await shot('03-immersive-next-1400x900');

    for (let attempt = 0; attempt < 10; attempt += 1) {
        win.setContentSize(1000, 640);
        await sleep(200);
        const [w, h] = win.getContentSize();
        if (Math.abs(w - 1000) <= 2 && Math.abs(h - 640) <= 2) break;
    }
    await sleep(500);
    await exec(`window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 220, clientY: 180 })); true`);
    await sleep(550);
    await shot('04-immersive-1000x640');

    win.destroy();
    app.exit(0);
}

const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const presetNames = fs.readdirSync(PRESET_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''));
ipcMain.handle('list-presets', () => presetNames);
ipcMain.handle('load-preset', (_event, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name + '.json'), 'utf8')); }
    catch (_) { return null; }
});
ipcMain.handle('list-logos', () => []);
ipcMain.handle('list-textures', () => []);
ipcMain.handle('list-templates', () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('save-prefs', () => ({ ok: true }));
ipcMain.handle('get-user', () => null);
for (const channel of ['save-image-base64', 'save-images-batch', 'save-template', 'load-template', 'delete-template',
    'rename-template', 'export-template', 'import-template', 'export-qfs', 'open-qfs', 'save-user', 'logout-user']) {
    ipcMain.handle(channel, () => ({ ok: true }));
}

app.whenReady().then(main).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
});
