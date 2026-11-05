// 对比三张图的色彩/明暗分布,定位"同一个 XMP 与 LR 差在哪"。
// 用法: node tools/run-electron.js tools/analyze-compare.js
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
const ROOT = path.join(__dirname, '..');

const IMAGES = [
    { name: '软件导出', file: 'C:/Users/lumos/.workbuddy/clipboard-images/clipboard-2026-11-03T18-33-14-244Z-460e442c.jpg' },
    { name: 'LR 导出', file: 'C:/Users/lumos/.workbuddy/clipboard-images/clipboard-2026-11-03T18-33-14-248Z-41ebf587.jpg' },
    { name: '原图', file: 'C:/Users/lumos/.workbuddy/clipboard-images/clipboard-2026-11-03T18-33-14-250Z-7bc108c8.jpg' }
];

ipcMain.handle('noop', () => null);

app.whenReady().then(async () => {
    const w = new BrowserWindow({ width: 400, height: 300, show: false, webPreferences: { offscreen: false } });
    await w.loadURL('data:text/html,<html><body></body></html>');

    const payload = IMAGES.map(it => {
        const b = fs.readFileSync(it.file);
        const ext = path.extname(it.file).slice(1).toLowerCase();
        return { name: it.name, file: it.file, dataUrl: 'data:image/' + (ext === 'jpg' ? 'jpeg' : ext) + ';base64,' + b.toString('base64'), bytes: b.length };
    });

    const raw = await w.webContents.executeJavaScript(`(async () => {
        const imgs = ${JSON.stringify(payload)};
        const out = [];
        for (const it of imgs) {
            const img = new Image();
            await new Promise((r, j) => { img.onload = r; img.onerror = () => j(new Error('load fail')); img.src = it.dataUrl; });
            const cv = document.createElement('canvas');
            // 统一采样到 600 宽,避免不同尺寸影响统计
            const w2 = 600, h2 = Math.round(img.naturalHeight * (600 / img.naturalWidth));
            cv.width = w2; cv.height = h2;
            const g = cv.getContext('2d');
            g.drawImage(img, 0, 0, w2, h2);
            const d = g.getImageData(0, 0, w2, h2).data;
            const n = w2 * h2;
            let sr = 0, sg = 0, sb = 0, satSum = 0, warm = 0, cool = 0;
            const hist = new Uint32Array(256);
            const rb = [], gb = [], bb = [];
            for (let i = 0; i < d.length; i += 4) {
                const r = d[i], gg = d[i + 1], b = d[i + 2];
                sr += r; sg += gg; sb += b;
                const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
                satSum += mx === 0 ? 0 : (mx - mn) / mx;
                const lum = Math.round(0.2126 * r + 0.7152 * gg + 0.0722 * b);
                hist[Math.min(255, Math.max(0, lum))]++;
                if (r > b + 8) warm++; else if (b > r + 8) cool++;
                rb.push(r); gb.push(gg); bb.push(b);
            }
            const pct = (p) => { const target = n * p; let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; } return 255; };
            const q = (arr, p) => { arr.sort((a, b2) => a - b2); return arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]; };
            out.push({
                name: it.name,
                size: img.naturalWidth + 'x' + img.naturalHeight,
                kb: Math.round(it.bytes / 1024),
                mean: [sr / n, sg / n, sb / n].map(v => Math.round(v)),
                lum: [pct(0.01), pct(0.05), pct(0.25), pct(0.5), pct(0.75), pct(0.95), pct(0.99)],
                sat: Math.round(satSum / n * 1000) / 10,
                warm: Math.round(warm / n * 1000) / 10,
                cool: Math.round(cool / n * 1000) / 10,
                ch: [q(rb, 0.5), q(gb, 0.5), q(bb, 0.5)]
            });
        }
        return JSON.stringify(out);
    })()`);

    const rows = JSON.parse(raw);
    console.log('图名        尺寸          KB   平均RGB        亮度分位 1/5/25/50/75/95/99        饱和%  暖%   冷%   中位RGB');
    for (const r of rows) {
        console.log(
            r.name.padEnd(10),
            r.size.padEnd(12),
            String(r.kb).padStart(4),
            ('(' + r.mean.join(',') + ')').padEnd(14),
            r.lum.join('/').padEnd(30),
            String(r.sat).padStart(5),
            String(r.warm).padStart(5),
            String(r.cool).padStart(5),
            '(' + r.ch.join(',') + ')'
        );
    }
    app.exit(0);
}).catch(e => { console.error(e && e.stack || e); app.exit(1); });
