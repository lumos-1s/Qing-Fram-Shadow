// 生成「预设墙」启动页数据：渲染全部预设的封面图（复用看片台原型的离屏渲染管线）。
// 用法：node tools/run-electron.js tools/gen-preset-wall.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const OUT_DIR = path.join(ROOT, 'src', 'renderer', 'assets', 'preset-wall');
const COVER_DIR = path.join(OUT_DIR, 'covers');
const DATA_PATH = path.join(OUT_DIR, 'preset-wall-data.js');
const SAMPLES_DIR = path.join(ROOT, 'design', 'home-prototype-assets', 'samples-user');

// 每个分类用哪张示例图（用户实拍照片：design/home-prototype-assets/samples-user/*.webp）
const TAG_SAMPLE = {
    '个性': 'cat-white', '艺术': 'magnolia', '氛围': 'campus-dusk', '高级感': 'night-reflection',
    '复古': 'autumn-street', '光影': 'sunset-skyline', '创意': 'blossom-blue', '质感': 'building-day',
    '邮票': 'yellow-flower', '胶片': 'leaf-autumn', '水印': 'sky-flow', '票根': 'avenue',
    '极简': 'cosmo-flower', '手作': 'lotus-boardwalk', '潮流': 'cat-orange', '星空': 'sky-flow',
    '现代': 'lotus-teaching', '影院': 'river-night', '奢华': 'night-reflection'
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── IPC：让渲染进程通过现有 presets.js 读取真实预设（回退逐个读取路径）──
ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR).filter(name => name.endsWith('.json')));
ipcMain.handle('load-preset', (_event, name) => {
    try {
        return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name), 'utf8'));
    } catch (_) {
        return null;
    }
});

const EMPTY_LIST = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });

for (const channel of ['list-logos', 'list-textures', 'list-templates']) {
    ipcMain.handle(channel, EMPTY_LIST);
}
for (const channel of [
    'save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external',
    'open-data-dir', 'copy-text', 'save-diagnostics', 'check-for-updates',
    'start-update-download', 'quit-and-install'
]) {
    ipcMain.handle(channel, OK);
}
for (const channel of [
    'open-image', 'open-images', 'open-sticker-image', 'import-template',
    'open-qfs', 'load-template', 'save-image-base64', 'save-images-batch',
    'pick-export-location', 'write-export-files', 'read-exif'
]) {
    ipcMain.handle(channel, CANCEL);
}
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.20', electron: '31.7.7', chrome: '126.0.6478.234', node: '20.18.3',
    platform: 'win32', arch: 'x64', packaged: false, portable: false,
    osRelease: '10.0.22631', userData: process.env.TEMP, appPath: ROOT
}));

// ── 渲染进程里执行的封面渲染函数（离屏 canvas + 真实预设，不碰主画布）──
function renderWallCover(options) {
    return new Promise((resolve, reject) => {
        const preset = (window.App.presets || []).find(p => p._fileName === options.presetFile);
        if (!preset) { reject(new Error('missing preset: ' + options.presetFile)); return; }
        const img = new Image();
        img.onload = () => {
            try {
                const cv = document.createElement('canvas');
                cv.width = 1; cv.height = 1;
                const renderApp = {
                    dom: { canvas: cv },
                    image: { el: img, w: img.naturalWidth, h: img.naturalHeight, exif: {}, name: options.sampleKey },
                    template: JSON.parse(JSON.stringify(preset)),
                    displayMax: options.max || 900,
                    uiDprOverride: 1,
                    textures: [],
                    selectedEls: [],
                    applyZoomStyle() {},
                    requestRender() {}
                };
                window.__render(renderApp, false);
                resolve({
                    dataUrl: cv.toDataURL('image/webp', 0.9),
                    width: cv.width,
                    height: cv.height
                });
            } catch (error) {
                reject(error);
            }
        };
        img.onerror = () => reject(new Error('sample load failed: ' + options.sampleKey));
        img.src = options.sampleData;
    });
}

async function main() {
    fs.mkdirSync(COVER_DIR, { recursive: true });

    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        show: false,
        webPreferences: {
            preload: path.join(ROOT, 'tools', 'preload-about.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    const exec = (code) => win.webContents.executeJavaScript(code);

    let ready = false;
    for (let i = 0; i < 200; i++) {
        ready = await exec('!!(window.App && window.App.dom && Array.isArray(window.App.presets) && window.App.presets.length)');
        if (ready) break;
        await sleep(100);
    }
    if (!ready) throw new Error('App/presets did not become ready');
    await exec(`(() => {
        const splash = document.getElementById('splash');
        if (splash) splash.style.display = 'none';
        const intro = document.getElementById('introModal');
        if (intro) intro.style.display = 'none';
        document.documentElement.classList.add('dark');
        return true;
    })()`);

    // 预读示例图为 data URL（生成环境里 file:// 子资源可能被沙箱拒绝，走 data 协议最稳）
    const SAMPLE_DATA = {};
    if (fs.existsSync(SAMPLES_DIR)) {
        for (const f of fs.readdirSync(SAMPLES_DIR)) {
            if (!f.endsWith('.webp')) continue;
            SAMPLE_DATA[f.replace(/\.webp$/, '')] = 'data:image/webp;base64,' +
                fs.readFileSync(path.join(SAMPLES_DIR, f)).toString('base64');
        }
    }
    console.log('samples:', Object.keys(SAMPLE_DATA).length);

    const presets = await exec('window.App.presets.map(p => ({ name: p.templateName || p._fileName, tag: p.templateTag || \'其他\', file: p._fileName }))');
    console.log('presets:', presets.length);
    await exec(`window.__renderWallCover = ${renderWallCover.toString()}; true`);

    const items = [];
    for (let i = 0; i < presets.length; i++) {
        const p = presets[i];
        const sampleKey = TAG_SAMPLE[p.tag] || 'cosmo-flower';
        const sampleData = SAMPLE_DATA[sampleKey] || '';
        if (!sampleData) throw new Error('sample missing: ' + sampleKey);
        const cover = await exec(`window.__renderWallCover(${JSON.stringify({ sampleKey, presetFile: p.file, max: 900, sampleData })})`);
        const fname = 'c' + String(i).padStart(2, '0') + '.webp';
        fs.writeFileSync(path.join(COVER_DIR, fname), Buffer.from(cover.dataUrl.split(',')[1], 'base64'));
        items.push({
            i,
            name: p.name,
            tag: p.tag,
            preset: p.file,
            cover: 'assets/preset-wall/covers/' + fname,
            w: cover.width,
            h: cover.height
        });
        console.log('cover:', i, p.name, '|', p.tag, '|', cover.width + 'x' + cover.height);
    }

    const data = { generatedAt: new Date().toISOString(), items };
    fs.writeFileSync(
        DATA_PATH,
        '// 由 tools/gen-preset-wall.js 生成，请勿手改。\nwindow.PRESET_WALL = ' + JSON.stringify(data) + ';\n',
        'utf8'
    );
    console.log('wrote', DATA_PATH, items.length, 'items');
    app.exit(0);
}

app.whenReady().then(main).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
});
