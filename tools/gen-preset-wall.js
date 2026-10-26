// 生成「预设墙」启动页数据：渲染全部预设的封面图（复用看片台原型的离屏渲染管线）。
//
// 用法（必须经 run-electron 启动，因为要真实 Electron 离屏 canvas）：
//   node tools/run-electron.js tools/gen-preset-wall.js
//   node tools/run-electron.js tools/gen-preset-wall.js --max 560 --quality 0.86
//   node tools/run-electron.js tools/gen-preset-wall.js --samples D:\photos\wall
//
// 之后想换照片：
//   1) 推荐：把照片放进 design/preset-wall-samples/，文件名直接用分类名，例如「个性.jpg」。
//      生成器优先用它；没放的分类继续走下面的默认示例图。
//   2) 或者改 tools/preset-wall.config.json 的 tagSamples，把分类指向示例目录里的文件名。
//   3) 只换某一张预设的封面：不用重新生成，把图放进 userData/wall-covers/<预设名>.webp
//      （应用内「换封面」按钮会直接打开这个目录）。
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
const CONFIG_PATH = path.join(__dirname, 'preset-wall.config.json');
const OVERRIDE_DIR = path.join(ROOT, 'design', 'preset-wall-samples');

const IMAGE_MIME = {
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png'
};

const DEFAULT_CONFIG = {
    samplesDir: 'design/home-prototype-assets/samples-user',
    // 每个分类默认用哪张示例图（用户实拍照片：design/home-prototype-assets/samples-user/*.webp）
    tagSamples: {
        '个性': 'cat-white', '艺术': 'magnolia', '氛围': 'campus-dusk', '高级感': 'night-reflection',
        '复古': 'autumn-street', '光影': 'sunset-skyline', '创意': 'blossom-blue', '质感': 'building-day',
        '邮票': 'yellow-flower', '胶片': 'leaf-autumn', '水印': 'sky-flow', '票根': 'avenue',
        '极简': 'cosmo-flower', '手作': 'lotus-boardwalk', '潮流': 'cat-orange', '星空': 'sky-flow',
        '现代': 'lotus-teaching', '影院': 'river-night', '奢华': 'night-reflection'
    },
    fallbackSample: 'cosmo-flower',
    // 封面长边。卡片实际显示约 238×298 CSS px，DPR=2 时约 476×596 设备像素，
    // 560 够清晰；原来 900 会白白多解码约 3 倍像素，87 张合计多占约 140MB 内存。
    coverMax: 560,
    webpQuality: 0.86
};

function loadConfig() {
    let file = {};
    try {
        file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (_) { /* 没有配置文件就用默认值 */ }
    return Object.assign({}, DEFAULT_CONFIG, file, {
        tagSamples: Object.assign({}, DEFAULT_CONFIG.tagSamples, file.tagSamples || {})
    });
}

const CONFIG = loadConfig();

// 命令行覆盖：--samples <dir> / --max <px> / --quality <0-1>
function cliValue(name) {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : null;
}
const CLI_SAMPLES = cliValue('--samples');
const CLI_MAX = parseInt(cliValue('--max'), 10);
const CLI_QUALITY = parseFloat(cliValue('--quality'));
const COVER_MAX = Number.isFinite(CLI_MAX) && CLI_MAX > 0 ? CLI_MAX : CONFIG.coverMax;
const QUALITY = Number.isFinite(CLI_QUALITY) && CLI_QUALITY > 0 ? CLI_QUALITY : CONFIG.webpQuality;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 示例图目录：design/preset-wall-samples 优先，其次配置里的目录（相对仓库根）──
function sampleDirOf(dir) {
    if (!dir) return null;
    return path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
}
const SAMPLE_DIRS = [OVERRIDE_DIR, sampleDirOf(CLI_SAMPLES || CONFIG.samplesDir)].filter(Boolean);

function readSampleDir(dir) {
    const map = {};
    if (!dir || !fs.existsSync(dir)) return map;
    for (const file of fs.readdirSync(dir)) {
        const ext = path.extname(file).toLowerCase();
        if (!IMAGE_MIME[ext]) continue;
        const key = path.basename(file, ext);
        if (!map[key]) map[key] = { file: path.join(dir, file), mime: IMAGE_MIME[ext], dir };
    }
    return map;
}

// 同名文件按目录顺序先到先得：design/preset-wall-samples 覆盖默认示例图
const SAMPLES = {};
for (const dir of SAMPLE_DIRS) {
    const found = readSampleDir(dir);
    for (const key of Object.keys(found)) if (!SAMPLES[key]) SAMPLES[key] = found[key];
}

function sampleForTag(tag) {
    // 1) 直接按分类名放的照片（design/preset-wall-samples/个性.jpg）
    if (SAMPLES[tag]) return { key: tag, ...SAMPLES[tag] };
    // 2) 配置里映射的示例图
    const key = CONFIG.tagSamples[tag] || CONFIG.fallbackSample;
    if (SAMPLES[key]) return { key, ...SAMPLES[key] };
    throw new Error('no sample for tag "' + tag + '" (looked for ' + tag + '.*, then "' + key + '")');
}

const sampleDataUrl = (() => {
    const cache = new Map();
    return (sample) => {
        if (!cache.has(sample.file)) {
            cache.set(sample.file, 'data:' + sample.mime + ';base64,' +
                fs.readFileSync(sample.file).toString('base64'));
        }
        return cache.get(sample.file);
    };
})();

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
                    displayMax: options.max || 560,
                    uiDprOverride: 1,
                    textures: [],
                    selectedEls: [],
                    applyZoomStyle() {},
                    requestRender() {}
                };
                window.__render(renderApp, false);
                resolve({
                    dataUrl: cv.toDataURL('image/webp', options.quality || 0.86),
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
    console.log('samples:', SAMPLE_DIRS.join(' | '));
    console.log('cover max:', COVER_MAX + 'px', 'webp quality:', QUALITY);

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

    console.log('samples found:', Object.keys(SAMPLES).length);

    const presets = await exec('window.App.presets.map(p => ({ name: p.templateName || p._fileName, tag: p.templateTag || \'其他\', file: p._fileName }))');
    console.log('presets:', presets.length);
    await exec(`window.__renderWallCover = ${renderWallCover.toString()}; true`);

    const items = [];
    let bytes = 0;
    for (let i = 0; i < presets.length; i++) {
        const p = presets[i];
        const sample = sampleForTag(p.tag);
        const cover = await exec(`window.__renderWallCover(${JSON.stringify({
            sampleKey: sample.key,
            presetFile: p.file,
            max: COVER_MAX,
            quality: QUALITY,
            sampleData: sampleDataUrl(sample)
        })})`);
        const fname = 'c' + String(i).padStart(2, '0') + '.webp';
        const buf = Buffer.from(cover.dataUrl.split(',')[1], 'base64');
        fs.writeFileSync(path.join(COVER_DIR, fname), buf);
        bytes += buf.length;
        items.push({
            i,
            name: p.name,
            tag: p.tag,
            preset: String(p.file).replace(/\.json$/i, ''),
            cover: 'assets/preset-wall/covers/' + fname,
            w: cover.width,
            h: cover.height
        });
        console.log('cover:', i, p.name, '|', p.tag, '|', sample.key, '|', cover.width + 'x' + cover.height, '|', (buf.length / 1024).toFixed(0) + 'KB');
    }

    // 预设数量变少时清掉没人引用的旧封面，避免资源目录越滚越大
    const keep = new Set(items.map(item => path.basename(item.cover)));
    for (const file of fs.readdirSync(COVER_DIR)) {
        if (/^c\d+\.webp$/i.test(file) && !keep.has(file)) fs.unlinkSync(path.join(COVER_DIR, file));
    }

    const data = { generatedAt: new Date().toISOString(), coverMax: COVER_MAX, quality: QUALITY, items };
    fs.writeFileSync(
        DATA_PATH,
        '// 由 tools/gen-preset-wall.js 生成，请勿手改。\nwindow.PRESET_WALL = ' + JSON.stringify(data) + ';\n',
        'utf8'
    );
    console.log('wrote', DATA_PATH, items.length, 'items');
    console.log('covers total:', (bytes / 1048576).toFixed(2) + 'MB at', COVER_MAX + 'px');
    app.exit(0);
}

app.whenReady().then(main).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
});
