// 只看重采样：同一张 5905px 的 LR 导出，分别用「画布 drawImage」和「整数分箱面积
// 平均」缩到 1400，比高频能量。如果画布那条明显更软，那「不够锐」里有一大块
// 根本不是锐化缺失，而是缩图核的差别 —— 那会影响每一张照片的预览。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const jpeg = require('jpeg-js');

const ROOT = path.resolve(__dirname, '..');
const LR = 'C:/Users/lumos/Desktop/未命名导出/tint=0.jpg';
const TW = 1400;

ipcMain.handle('load-acr-tables', () => ({ size: 17, count: 0, step: 3, data: new ArrayBuffer(0) }));
ipcMain.handle('get-prefs', () => ({}));

function hf(file) {
    const j = jpeg.decode(fs.readFileSync(file), { maxMemoryUsageInMB: 4096 });
    const { width: W, height: H, data } = j;
    const L = new Float32Array(W * H);
    for (let i = 0, p = 0; i < W * H; i++, p += 4) L[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    const flat = [], edge = [];
    for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
            const i = y * W + x;
            const lap = Math.abs(4 * L[i] - L[i - 1] - L[i + 1] - L[i - W] - L[i + W]);
            const g = Math.abs(L[i + 1] - L[i - 1]) + Math.abs(L[i + W] - L[i - W]);
            if (g < 6) flat.push(lap); else if (g > 40) edge.push(lap);
        }
    }
    const m = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
    return { w: W, h: H, flat: +m(flat).toFixed(3), edge: +m(edge).toFixed(3) };
}

app.whenReady().then(async () => {
    const w = new BrowserWindow({
        show: false, width: 1200, height: 800,
        webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
    });
    await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await new Promise((r) => setTimeout(r, 1500));
    const url = fs.readFileSync(LR).toString('base64');
    const out = await w.webContents.executeJavaScript(`(async () => {
        const img = new Image();
        await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = 'data:image/jpeg;base64,${url}'; });
        const W = ${TW}, H = Math.round(${TW} * img.height / img.width);
        const mk = (q) => { const c = document.createElement('canvas'); c.width = W; c.height = H;
            const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = q;
            g.drawImage(img, 0, 0, W, H); return c; };
        // 两级缩：先 2× 再 2×（等价于 mipmap，减少一次大比例重采样的模糊）
        const half = (src, k) => { const c = document.createElement('canvas');
            c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
            const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
            g.drawImage(src, 0, 0, c.width, c.height); return c; };
        let cur = img; while (cur.width > W * 2) cur = half(cur, 0.5);
        const c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
        const g2 = c2.getContext('2d'); g2.imageSmoothingQuality = 'high'; g2.drawImage(cur, 0, 0, W, H);
        const r = { high: mk('high').toDataURL('image/jpeg', 0.98),
                    two: c2.toDataURL('image/jpeg', 0.98) };
        // 原生高质量缩放（Skia 的高质量重采样），比手写逐像素快得多
        try {
            const bm = await createImageBitmap(img, { resizeWidth: W, resizeHeight: H, resizeQuality: 'high' });
            const c3 = document.createElement('canvas'); c3.width = W; c3.height = H;
            c3.getContext('2d').drawImage(bm, 0, 0);
            r.bitmap = c3.toDataURL('image/jpeg', 0.98);
        } catch (e) { r.bitmap = null; }
        return r;
    })()`);
    const a = path.join(ROOT, 'tools', 'out', 'rs_high.jpg');
    const b = path.join(ROOT, 'tools', 'out', 'rs_two.jpg');
    fs.writeFileSync(a, Buffer.from(out.high.split(',')[1], 'base64'));
    fs.writeFileSync(b, Buffer.from(out.two.split(',')[1], 'base64'));
    const cpath = path.join(ROOT, 'tools', 'out', 'rs_bitmap.jpg');
    if (out.bitmap) fs.writeFileSync(cpath, Buffer.from(out.bitmap.split(',')[1], 'base64'));
    const hi = hf(a), tw = hf(b), ref = hf(path.join(ROOT, 'tools', 'out', 'sh_lr.jpg'));
    const bm = out.bitmap ? hf(cpath) : null;
    console.log('\n 缩图方式        平地    边缘');
    const line = (k, x) => console.log(' ' + k.padEnd(14) + String(x.flat).padStart(7) + String(x.edge).padStart(8));
    line('画布 high', hi); line('画布 两级', tw); if (bm) line('ImageBitmap', bm); line('面积平均(参照)', ref);
    console.log('\n 相对面积平均：high 平地', (hi.flat / ref.flat).toFixed(3), '边缘', (hi.edge / ref.edge).toFixed(3),
        '| 两级 平地', (tw.flat / ref.flat).toFixed(3), '边缘', (tw.edge / ref.edge).toFixed(3));
    if (bm) console.log('            bitmap 平地', (bm.flat / ref.flat).toFixed(3), '边缘', (bm.edge / ref.edge).toFixed(3));
    app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
