// 临时预览工具:渲染单个风格的成品 PNG,供人工目检。
//   env -u ELECTRON_RUN_AS_NODE node tools/run-electron.js tools/preview-style.js --style XIAOMI_LEICA --out out.png
'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const ROOT = path.join(__dirname, '..');
const argOf = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const STYLE = argOf('--style') || 'XIAOMI_LEICA';
const OUT = argOf('--out') || path.join(ROOT, 'tests', 'visual', 'out', 'preview-' + STYLE + '.png');
const SAMPLE = argOf('--sample') || path.join(ROOT, 'design', 'home-prototype-assets', 'samples-user', 'sky-flow.webp');

const E = () => []; const OK = () => ({ ok: true }); const C = () => ({ canceled: true });
// 品牌 Logo 池:与主进程 list-logos 同源。厂商 Logo 是第三方素材,工程目录不再存放,
// 统一从用户数据目录读(%APPDATA%/qingframe-web/brandlogos)。
const LOGOS_DIR = path.join(
    process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
    'qingframe-web', 'brandlogos'
);
const LOGO_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
ipcMain.handle('list-logos', () => {
    if (!fs.existsSync(LOGOS_DIR)) return [];
    return fs.readdirSync(LOGOS_DIR).filter(n => LOGO_EXTS.includes(path.extname(n).toLowerCase()))
        .map(n => ({ name: n, dataUrl: 'data:image/' + path.extname(n).slice(1) + ';base64,' + fs.readFileSync(path.join(LOGOS_DIR, n)).toString('base64') }));
});
ipcMain.handle('list-presets', () => fs.readdirSync(path.join(ROOT, 'shared', 'presets')).filter(n => n.endsWith('.json')));
ipcMain.handle('load-preset', (_e, name) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'presets', name), 'utf8')); } catch (_) { return null; } });
for (const c of ['list-textures', 'list-templates']) ipcMain.handle(c, E);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template', 'rename-template',
    'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text', 'save-diagnostics',
    'check-for-updates', 'start-update-download', 'quit-and-install', 'list-wall-covers', 'open-wall-covers-dir']) ipcMain.handle(c, OK);
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template',
    'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files', 'read-exif']) ipcMain.handle(c, C);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({ version: 'dev', electron: '31', chrome: '126', node: '20', platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function renderJob(options) {
    return new Promise((resolve, reject) => {
        const preset = (window.App.presets || []).find(p => p._fileName === options.presetFile);
        if (!preset) { reject(new Error('missing preset: ' + options.presetFile)); return; }
        const img = new Image();
        img.onload = async () => {
            try {
                const make = () => {
                    const cv = document.createElement('canvas');
                    cv.width = 1; cv.height = 1;
                    const renderApp = {
                        dom: { canvas: cv },
                        image: { el: img, w: img.naturalWidth, h: img.naturalHeight, exif: options.exif || {}, name: 'preview' },
                        template: JSON.parse(JSON.stringify(preset)),
                        displayMax: options.max || 1200,
                        uiDprOverride: 1,
                        textures: [],
                        selectedEls: [],
                        logos: (window.App && window.App.logos) || [],   // 品牌 Logo 池(引擎按品牌名匹配)
                        logoImgCache: options.cache,   // 跨次渲染共享,让品牌 Logo 图片加载完成后第二次能命中
                        applyZoomStyle() {},
                        requestRender() {}
                    };
                    if (options.templatePatch) {
                        // 组内浅合并:只改点名的那几个键,其余配置保持预设值(否则 xmLeica 整组会被清空)
                        for (const [k, v] of Object.entries(options.templatePatch)) {
                            if (v && typeof v === 'object' && !Array.isArray(v)
                                && renderApp.template[k] && typeof renderApp.template[k] === 'object') {
                                renderApp.template[k] = Object.assign({}, renderApp.template[k], v);
                            } else {
                                renderApp.template[k] = v;
                            }
                        }
                    }
                    return renderApp;
                };
                window.__render(make(), false);
                // 品牌 Logo 按需异步加载:等一拍再渲一遍,第二遍才有完整 Logo
                await new Promise(r => setTimeout(r, 600));
                const app2 = make();
                window.__render(app2, false);
                const cv2 = app2.dom.canvas;
                // 额外输出底部水印条裁剪,便于人工目检小字与 Logo
                const crop = document.createElement('canvas');
                crop.width = Math.min(900, cv2.width); crop.height = 140;
                const cg = crop.getContext('2d');
                cg.fillStyle = '#222'; cg.fillRect(0, 0, crop.width, crop.height);
                cg.drawImage(cv2, 0, cv2.height - 140, crop.width, 140, 0, 0, crop.width, 140);
                resolve({ dataUrl: cv2.toDataURL('image/png'), width: cv2.width, height: cv2.height, crop: crop.toDataURL('image/png') });
            } catch (error) { reject(error); }
        };
        img.onerror = () => reject(new Error('sample load failed'));
        img.src = options.sampleData;
    });
}

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1400, height: 900, show: false,
        webPreferences: { preload: path.join(ROOT, 'tools', 'preload-about.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (code) => win.webContents.executeJavaScript(code);
    let ready = false;
    for (let i = 0; i < 200; i++) {
        ready = await exec('!!(window.App && window.App.dom && Array.isArray(window.App.presets) && window.App.presets.length)');
        if (ready) break;
        await sleep(100);
    }
    if (!ready) throw new Error('App not ready');
    await exec(`(() => { const s=document.getElementById('splash'); if(s) s.style.display='none';
        const i=document.getElementById('introModal'); if(i) i.style.display='none';
        document.documentElement.classList.add('dark'); return true; })()`);
    await exec(`window.__renderJob = ${renderJob.toString()}; true`);

    // 诊断:Logo 池是否加载、按品牌能否命中
    await sleep(800);
    console.log('logos:', await exec('((window.App && window.App.logos) || []).length'));
    console.log('logo probe:', await exec(`(() => {
        try {
            const app = window.App;
            const hit = (typeof window.Engine !== 'undefined' && window.Engine) ? 'engine?' : 'n/a';
            return JSON.stringify({ logos: (app.logos || []).slice(0, 3).map(l => l && l.name),
                xiaomi: (app.logos || []).filter(l => /xiaomi/i.test(l.name || '')).map(l => l.name) });
        } catch (e) { return 'err ' + e.message; }
    })()`));

    // 该风格对应的预设文件
    const presets = await exec('window.App.presets.map(p => ({ name: p.templateName || p._fileName, style: p.photoFrameStyle, file: p._fileName }))');
    const hit = presets.find(p => String(p.style).toUpperCase() === STYLE.toUpperCase());
    if (!hit) { console.error('no preset uses style ' + STYLE + '; available: ' + presets.filter(p => /LEICA|XIAOMI/i.test(p.style)).map(p => p.style).join(',')); app.exit(1); return; }

    const mime = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }[path.extname(SAMPLE).toLowerCase()];
    const sampleData = 'data:' + mime + ';base64,' + fs.readFileSync(SAMPLE).toString('base64');

    const results = [];
    const cache = {};
    for (const patch of [{}, { xmLeica: { align: 0 } }, { xmLeica: { align: 2 } }]) {
        const r = await exec(`window.__renderJob(${JSON.stringify({ presetFile: hit.file, max: 1200, sampleData, templatePatch: patch, cache })})`);
        results.push(r);
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    results.forEach((r, i) => {
        const p = OUT.replace(/\.png$/, '-' + i + '.png');
        fs.writeFileSync(p, Buffer.from(r.dataUrl.split(',')[1], 'base64'));
        fs.writeFileSync(p.replace(/-\d+\.png$/, '-crop' + i + '.png'), Buffer.from(r.crop.split(',')[1], 'base64'));
        console.log('wrote', p, r.width + 'x' + r.height);
    });
    app.exit(0);
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });
