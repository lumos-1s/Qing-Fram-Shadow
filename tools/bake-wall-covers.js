// 把用户的自定义预设墙封面「烧」进内置资源。
//
// 来源：%APPDATA%\qingframe-web\wall-covers\<预设名>.webp|png|jpg
// 目的：src/renderer/assets/preset-wall/covers/cNN.webp（并同步 preset-wall-data.js 的 w/h）
//
// 用法：
//   node tools/bake-wall-covers.js                 # 默认目录
//   node tools/bake-wall-covers.js --dir <目录>    # 指定目录
//   node tools/bake-wall-covers.js --dry           # 只报告匹配结果，不写文件
//
// 为什么统一 560 / webp q0.86：用户丢进来的常是整张导出图（几十 MB），
// 原样入库会让仓库和首屏都受不了；560 是墙卡片的最大显示尺寸。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'src', 'renderer', 'assets', 'preset-wall', 'preset-wall-data.js');
const MAX = 560;
const QUALITY = 0.86;

const argv = process.argv.slice(2);
const argOf = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null; };
const SRC_DIR = argOf('--dir') || path.join(os.homedir(), 'AppData', 'Roaming', 'qingframe-web', 'wall-covers');
const DRY = argv.includes('--dry');

ipcMain.handle('list-presets', () => []);
ipcMain.handle('load-preset', () => null);
const E = () => []; const OK = () => ({ ok: true }); const C = () => ({ canceled: true });
for (const c of ['list-logos', 'list-textures', 'list-templates']) ipcMain.handle(c, E);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template', 'rename-template',
    'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text', 'save-diagnostics',
    'check-for-updates', 'start-update-download', 'quit-and-install', 'list-wall-covers', 'open-wall-covers-dir']) ipcMain.handle(c, OK);
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template',
    'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files', 'read-exif']) ipcMain.handle(c, C);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({ version: 'dev', electron: '31', chrome: '126', node: '20', platform: 'win32',
    arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
    const raw = fs.readFileSync(DATA, 'utf8');
    const head = 'window.PRESET_WALL = ';
    const wall = JSON.parse(raw.slice(raw.indexOf('{', raw.indexOf(head)), raw.lastIndexOf('}') + 1));

    // 名字匹配：预设名用「·」，用户文件名常用「●」「+」，剔掉分隔符再比；
    // 归一化后撞车（两条预设映射到同一个键）就作废，宁可跳过也不误配。
    const norm = (n) => String(n).replace(/[\s·●•+\\-_—–]/g, '');
    const byName = new Map(wall.items.map((it) => [it.name, it]));
    const byNorm = new Map();
    for (const it of wall.items) {
        const k = norm(it.name);
        byNorm.set(k, byNorm.has(k) ? null : it);
    }

    if (!fs.existsSync(SRC_DIR)) { console.log('目录不存在: ' + SRC_DIR); app.exit(1); return; }
    const files = fs.readdirSync(SRC_DIR).filter((f) => /\.(webp|png|jpe?g)$/i.test(f));
    console.log('SRC ' + SRC_DIR);
    console.log('文件 ' + files.length + ' 个' + (DRY ? '（dry run，不写文件）' : ''));

    const jobs = [];
    for (const f of files) {
        const name = path.basename(f, path.extname(f));
        const item = byName.get(name) || byNorm.get(norm(name));
        if (!item) { console.log('  SKIP ' + f + '  ← 墙里没有同名预设'); continue; }
        if (item.name !== name) console.log('  MAP  ' + name + ' ←→ ' + item.name);
        jobs.push({ file: path.join(SRC_DIR, f), name, item });
    }
    console.log('待处理 ' + jobs.length + ' 张');
    if (!jobs.length || DRY) { app.exit(0); return; }

    const win = new BrowserWindow({
        width: 900, height: 700, show: false, paintWhenInitiallyHidden: true, backgroundColor: '#000',
        webPreferences: { preload: path.join(__dirname, 'preload-measure.js'), contextIsolation: true, sandbox: true }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(400);
    const ex = (s) => win.webContents.executeJavaScript(s);
    await ex(`(() => { try { localStorage.setItem('qfs_intro_done','1'); } catch(_){} return true; })()`);

    // 解码 → 等比缩到长边 MAX → webp；不依赖 sharp/native 模块
    const bake = `function (srcUrl, max, quality) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
                const w = Math.max(1, Math.round(img.naturalWidth * sc));
                const h = Math.max(1, Math.round(img.naturalHeight * sc));
                const cv = document.createElement('canvas');
                cv.width = w; cv.height = h;
                const g = cv.getContext('2d');
                g.imageSmoothingQuality = 'high';
                g.drawImage(img, 0, 0, w, h);
                resolve({ data: cv.toDataURL('image/webp', quality), w, h });
            };
            img.onerror = () => reject(new Error('decode failed'));
            img.src = srcUrl;
        });
    }`;
    await ex(`window.__bake = ${bake}; true`);

    let ok = 0;
    for (const job of jobs) {
        const srcUrl = 'file:///' + job.file.replace(/\\/g, '/');
        let r = null;
        try { r = await ex(`window.__bake(${JSON.stringify(srcUrl)}, ${MAX}, ${QUALITY})`); }
        catch (e) { console.log('  FAIL ' + job.name + ' ← ' + (e && e.message)); continue; }
        if (!r || !r.data) { console.log('  FAIL ' + job.name + ' ← 无输出'); continue; }
        const buf = Buffer.from(r.data.split(',')[1], 'base64');
        const coverAbs = path.join(ROOT, 'src', 'renderer', job.item.cover);
        const prev = fs.existsSync(coverAbs) ? fs.statSync(coverAbs).size : 0;
        fs.writeFileSync(coverAbs, buf);
        job.item.w = r.w;
        job.item.h = r.h;
        ok++;
        console.log('  OK   ' + job.name.padEnd(14, '　') + ' ' + String(r.w).padStart(3) + 'x' + String(r.h).padEnd(4) +
            ' ' + (buf.length / 1024).toFixed(0).padStart(4) + 'KB  (原 ' + (prev / 1024).toFixed(0) + 'KB)  ' + path.basename(coverAbs));
    }

    fs.writeFileSync(DATA, '// 由 tools/gen-preset-wall.js 生成，请勿手改。\n' + head + JSON.stringify(wall) + ';\n');
    console.log('DONE ' + ok + '/' + jobs.length + ' 张已替换，data 已同步');
    app.exit(0);
}).catch((e) => { console.error('ERR ' + (e && e.stack || e)); app.exit(1); });
