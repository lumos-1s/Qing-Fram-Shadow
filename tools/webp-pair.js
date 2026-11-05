// 把两张 webp 缩略图读进 canvas，算逐块色差，并拼成左右对比图。
//   node tools/run-electron.js tools/webp-pair.js  （改 PAIRS 换文件）
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const PAIRS = [
    ['wall_new_0.webp', 'wall_v2_0.webp', 'wall_cmp_3d'],
    ['wall_new_1.webp', 'wall_v2_1.webp', 'wall_cmp_nomo'],
    ['wall_new_2.webp', 'wall_v2_2.webp', 'wall_cmp_stamp'],
];

app.whenReady().then(async () => {
    const w = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { contextIsolation: true, sandbox: false } });
    await w.loadURL('data:text/html,<html><body></body></html>');
    for (const [a, b, tag] of PAIRS) {
        const pa = path.join(OUT, a), pb = path.join(OUT, b);
        if (!fs.existsSync(pa) || !fs.existsSync(pb)) { console.log('缺文件', a, b); continue; }
        const ua = 'data:image/webp;base64,' + fs.readFileSync(pa).toString('base64');
        const ub = 'data:image/webp;base64,' + fs.readFileSync(pb).toString('base64');
        const r = await w.webContents.executeJavaScript(`(async () => {
            const ld = async (u) => { const im = new Image(); await new Promise((r, j) => { im.onload = r; im.onerror = j; im.src = u; }); return im; };
            const lab = (r, g, b) => {
                const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
                const R = f(r), G = f(g), B = f(b);
                const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
                const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
                const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
                const t = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
                const fx = t(X), fy = t(Y), fz = t(Z);
                return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
            };
            const A = await ld(${JSON.stringify(ua)}), B = await ld(${JSON.stringify(ub)});
            const W = A.naturalWidth, H = A.naturalHeight;
            const cv1 = document.createElement('canvas'); cv1.width = W; cv1.height = H;
            const g1 = cv1.getContext('2d'); g1.drawImage(A, 0, 0);
            const cv2 = document.createElement('canvas'); cv2.width = W; cv2.height = H;
            const g2 = cv2.getContext('2d'); g2.drawImage(B, 0, 0);
            const d1 = g1.getImageData(0, 0, W, H).data, d2 = g2.getImageData(0, 0, W, H).data;
            let sa = 0, sb = 0, sL = 0, se = 0, n = 0;
            for (let y = 2; y < H - 2; y += 2) for (let x = 2; x < W - 2; x += 2) {
                const p = (y * W + x) * 4;
                const la = lab(d1[p], d1[p + 1], d1[p + 2]), lb = lab(d2[p], d2[p + 1], d2[p + 2]);
                sL += la[0] - lb[0]; sa += la[1] - lb[1]; sb += la[2] - lb[2];
                const dl = la[0] - lb[0], da = la[1] - lb[1], db = la[2] - lb[2];
                se += dl * dl + da * da + db * db; n++;
            }
            // 左右并排（间距 8）
            const gap = 8, tw = W * 2 + gap;
            const out = document.createElement('canvas'); out.width = tw; out.height = H;
            const go = out.getContext('2d');
            go.drawImage(A, 0, 0); go.drawImage(B, W + gap, 0);
            return { W, H, dL: sL / n, da: sa / n, db: sb / n, dE: Math.sqrt(se / n), out: out.toDataURL('image/jpeg', 0.94) };
        })()`);
        const b64 = r.out.slice(r.out.indexOf(',') + 1);
        fs.writeFileSync(path.join(OUT, tag + '.jpg'), Buffer.from(b64, 'base64'));
        console.log(tag, r.W + 'x' + r.H, '改前−改后  ΔL', r.dL.toFixed(2), ' Δa', r.da.toFixed(2), ' Δb', r.db.toFixed(2), ' ΔE', r.dE.toFixed(2));
    }
    app.quit();
});
