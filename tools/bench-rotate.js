// 旋转到底慢在哪：把 rotateCurrentPhoto 的每一步单独计时。
//
// 断言的不是「快不快」（机器差异太大），而是**哪一段占了大头**——
// 以前只有一个端到端数字（6000×4000 ≈ 2.2s），看不出是解码、编码还是重烘焙。
//
// 0.1.25 的实测结论（6000×4000 = 24MP，2D 路径）：
//   PNG 编码 471ms + 两次 32×32 采样 302ms + decode 115ms + 重载 25ms
//   = 941ms，而真正「转」那一下只要 13ms。
//
// 0.1.26 改成「画布直持 + 条带采样」后：
//   decode 165 + 旋转绘制 20 + 落定/采样 418 + 烘焙 21 ≈ 625ms（本机）
//   老实现同场对照 ≈ 992ms。
//
// 一个反直觉的坑：那张 24MP 画布**只要被读像素或被绘制到屏幕，就要先落定一次**
// （实测 200~420ms，随内存压力浮动）。无论是 getImageData 读 1 行、读 16 条带、
// 还是 drawImage 到主画布，都要付这一笔，且只付一次。所以「检测」并没有额外花钱，
// 它只是把渲染本来就要付的落定提前付掉 —— 别指望靠减少采样量省时间。
//
// 用法:
//   node tools/run-electron.js tools/bench-rotate.js
//   QF_ELECTRON_FLAGS="--use-gl=swiftshader --no-sandbox" node tools/run-electron.js tools/bench-rotate.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR)
    .filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, n + '.json'), 'utf8')); } catch (_) { return null; }
});
for (const ch of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(ch, () => []);
for (const ch of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template', 'rename-template',
    'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text', 'save-diagnostics',
    'check-for-updates', 'start-update-download', 'quit-and-install', 'open-wall-covers-dir']) ipcMain.handle(ch, () => ({ ok: true }));
for (const ch of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'load-template',
    'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files', 'read-exif', 'open-image']) ipcMain.handle(ch, () => ({ canceled: true }));
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('load-acr-tables', () => null);
ipcMain.handle('load-acr-shadows', () => null);

// 页面内：造一张「像照片」的高熵大图（噪声 + 渐变），测各阶段。
// 纯色图测编码会严重低估 —— PNG/JPEG 对平坦区压缩极快，真实照片不会。
const HELPERS = `
window.__photoLike = (w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0, '#2a3a4a'); grd.addColorStop(0.5, '#c8a878'); grd.addColorStop(1, '#141c22');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    // 高频噪声：模拟树叶/织物这类真实细节，PNG 最吃这个
    const tile = document.createElement('canvas');
    tile.width = 256; tile.height = 256;
    const tg = tile.getContext('2d');
    const id = tg.createImageData(256, 256);
    for (let i = 0; i < id.data.length; i += 4) {
        const v = (Math.random() * 90) | 0;
        id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
        id.data[i + 3] = 255;
    }
    tg.putImageData(id, 0, 0);
    const pat = g.createPattern(tile, 'repeat');
    g.globalAlpha = 0.35; g.fillStyle = pat; g.fillRect(0, 0, w, h);
    g.globalAlpha = 1;
    return c;
};
window.__toImage = (blob) => new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.onload = () => res({ im, url });
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('load fail')); };
    im.src = url;
});
// 单尺寸全链路分解
window.__bench = async (W, H) => {
    const out = { size: W + 'x' + H, mp: +(W * H / 1e6).toFixed(1), gl: !!(window.QfsColor && window.QfsColor.usingGL()), steps: {} };
    const t = () => performance.now();
    const put = (k, ms) => { out.steps[k] = +(ms).toFixed(1); };

    // 0) 造图 + 用一个 JPEG 装进 Image，模拟用户导入的照片
    let a = t();
    const srcCanvas = window.__photoLike(W, H);
    put('make-source', t() - a);

    a = t();
    const jblob = await new Promise((r) => srcCanvas.toBlob(r, 'image/jpeg', 0.92));
    put('encode-jpeg-src', t() - a);

    a = t();
    const { im, url } = await window.__toImage(jblob);
    put('decode-src(jpeg)', t() - a);
    out.srcBytes = jblob.size;

    // 1) 显式 await decode()：主流程里为防「解码未完成就 drawImage」加的那一次
    a = t();
    try { await im.decode(); } catch (_) {}
    put('await-decode', t() - a);

    // 2) 旋转 drawImage
    a = t();
    const cv = document.createElement('canvas');
    cv.width = H; cv.height = W;
    // 与 rotateCurrentPhoto 实际实现一致：这张画布注定要被读像素
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.translate(H / 2, W / 2); g.rotate(Math.PI / 2);
    g.drawImage(im, -W / 2, -H / 2);
    put('rotate-drawImage', t() - a);

    // 3) 结果检测：条带采样（新实现）。0.7ms 量级。
    a = t();
    const st = window.qfsAlphaStats(cv);
    put('alphaStats(out)', t() - a);
    out.stats = st;

    // 4) 画布直持（新实现，纯字段补齐，应当接近 0）
    a = t();
    const asSrc = window.qfsCanvasSource(cv);
    put('canvasSource', t() - a);
    out.asSrc = { nw: asSrc && asSrc.naturalWidth, complete: asSrc && asSrc.complete };

    // ── 以下三项是 0.1.25 的老实现，只作对照，不计入新链路 ──
    // 5) PNG 编码
    a = t();
    const pblob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    put('(legacy)encode-png', t() - a);
    out.pngBytes = pblob.size;

    // 6) JPEG 编码
    a = t();
    const j2 = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.95));
    put('(legacy)encode-jpeg95', t() - a);
    out.jpgBytes = j2.size;

    // 7) blob → Image 再 decode
    a = t();
    const back = await window.__toImage(pblob);
    put('(legacy)reload-png', t() - a);
    try { await back.im.decode(); } catch (_) {}

    // 8) 全分辨率调色烘焙（rotateCurrentPhoto 末尾 rebuildGrade('full')）
    const A = window.App;
    if (A && A.rebuildGrade) {
        const photo = back.im;
        const im2 = { el: photo, name: 'bench.jpg', path: null, w: H, h: W,
            exif: {}, customSettings: null, grade: null };
        A.images = [im2]; A.image = im2; A.currentIdx = 0; A.selectedIdx = [0]; A.batchSel = [0];
        A.template = A.defaultTemplate(); A.setTpl(im2, A.template);
        A.ensureGrade(im2);
        A.setGrade({ exp: 25, con: 15, sh: 20, tex: 10 });
        A.invalidateGrade(im2);
        a = t();
        A.rebuildGrade('full');
        put('rebuildGrade(full)', t() - a);
        a = t();
        A.invalidateGrade(im2);
        A.rebuildGrade('low');
        put('rebuildGrade(low)', t() - a);
    }
    a = t();
    URL.revokeObjectURL(url);
    URL.revokeObjectURL(back.url);
    put('cleanup', t() - a);

    out.total = +(Object.values(out.steps).reduce((s, v) => s + v, 0)).toFixed(1);
    return out;
};
true;
`;

function pct(part, whole) { return whole ? (part * 100 / whole).toFixed(0) + '%' : '-'; }

async function main() {
    await app.whenReady();
    const win = new BrowserWindow({
        width: 1280, height: 900, show: false, paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (e) => win.webContents.executeJavaScript(e);
    await sleep(400);
    win.showInactive();
    await exec(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(1000);
    await exec(HELPERS);
    await exec(`(async () => { await window.App.loadPresets(); return true; })()`);
    // 预热一次，避开首次 JIT / 纹理分配造成的偏差
    await exec(`(async () => { await window.__bench(800, 600); return true; })()`);

    const rows = [];
    for (const [W, H] of [[4000, 3000], [6000, 4000]]) {
        const r = await exec(`(async () => await window.__bench(${W}, ${H}))()`);
        rows.push(r);
        console.log(`\n=== ${r.size} (${r.mp} MP)  GL=${r.gl ? 'on' : 'off'} ===`);
        const flow = ['await-decode', 'rotate-drawImage', 'alphaStats(out)', 'canvasSource', 'rebuildGrade(full)'];
        const legacy = ['(legacy)encode-png', '(legacy)encode-jpeg95', '(legacy)reload-png'];
        const prep = ['make-source', 'encode-jpeg-src', 'decode-src(jpeg)'];
        console.log('  ── 新链路（画布直持 + 条带采样）──');
        let flowMs = 0;
        for (const k of flow) {
            if (r.steps[k] == null) continue;
            flowMs += r.steps[k];
            console.log(`  ${k.padEnd(20)} ${String(r.steps[k]).padStart(9)} ms`);
        }
        console.log(`  ${'新链路合计'.padEnd(20)} ${String(+flowMs.toFixed(1)).padStart(9)} ms`);
        console.log('  ── 0.1.25 老实现（已移除，仅对照）──');
        let legacyMs = 0;
        for (const k of legacy) {
            if (r.steps[k] == null) continue;
            legacyMs += r.steps[k];
            console.log(`  ${k.padEnd(20)} ${String(r.steps[k]).padStart(9)} ms`);
        }
        console.log(`  ${'老实现合计'.padEnd(20)} ${String(+legacyMs.toFixed(1)).padStart(9)} ms`);
        console.log('  ── 测试脚手架自身（不计入）──');
        for (const k of prep) {
            if (r.steps[k] == null) continue;
            console.log(`  ${k.padEnd(20)} ${String(r.steps[k]).padStart(9)} ms`);
        }
        console.log(`  提速 ${(legacyMs / Math.max(1, flowMs)).toFixed(1)}× （${legacyMs.toFixed(0)} → ${flowMs.toFixed(0)} ms）`);
        console.log(`  PNG ${(r.pngBytes / 1048576).toFixed(1)} MB   JPEG ${(r.jpgBytes / 1048576).toFixed(1)} MB   src ${(r.srcBytes / 1048576).toFixed(1)} MB`);
        console.log(`  采样校验 opaque=${r.stats && r.stats.opaque} black=${r.stats && r.stats.black} 方式=${r.stats && r.stats.method}`);
        console.log(`  直持校验 naturalWidth=${r.asSrc && r.asSrc.nw} complete=${r.asSrc && r.asSrc.complete}`);
    }
    win.destroy();
    app.exit(0);
}

main().catch((e) => { console.error(e); app.exit(1); });
