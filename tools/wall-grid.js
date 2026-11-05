// 把整套封面墙缩略图拼成一张网格图，用于核对「哪一版」。
//   node tools/run-electron.js tools/wall-grid.js --src <covers目录> --data <preset-wall-data.js> --out <out/wall_xx.jpg> --title "xxx"
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const argv = process.argv.slice(2);
const argOf = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null; };

const SRC = argOf('--src') || path.join(ROOT, 'src', 'renderer', 'assets', 'preset-wall', 'covers');
const DATA = argOf('--data') || path.join(ROOT, 'src', 'renderer', 'assets', 'preset-wall', 'preset-wall-data.js');
const NAME = argOf('--out') || 'wall_grid.jpg';
const TITLE = argOf('--title') || '';

app.whenReady().then(async () => {
    const raw = fs.readFileSync(DATA, 'utf8');
    const wall = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const items = wall.items.map((it) => ({
        i: it.i, name: it.name, file: path.join(SRC, it.cover.split('/').pop()),
    })).filter((it) => fs.existsSync(it.file));

    const CELL = 132, GAP = 6, COLS = 10, PAD = 24, HEAD = 46;
    const rows = Math.ceil(items.length / COLS);
    const W = PAD * 2 + COLS * CELL + (COLS - 1) * GAP;
    const H = PAD * 2 + HEAD + rows * CELL + (rows - 1) * GAP;

    const payload = items.map((it) => ({
        i: it.i, name: it.name,
        u: 'data:image/webp;base64,' + fs.readFileSync(it.file).toString('base64'),
    }));

    const w = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: true, sandbox: false } });
    await w.loadURL('data:text/html,<html><body></body></html>');

    const dataUrl = await w.webContents.executeJavaScript(`(async () => {
        const items = ${JSON.stringify(payload)};
        const W = ${W}, H = ${H}, CELL = ${CELL}, GAP = ${GAP}, COLS = ${COLS}, PAD = ${PAD}, HEAD = ${HEAD};
        const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
        const g = cv.getContext('2d');
        g.fillStyle = '#101012'; g.fillRect(0, 0, W, H);
        g.fillStyle = '#e8e8ea'; g.font = '600 20px system-ui, "Segoe UI", sans-serif';
        g.fillText(${JSON.stringify(TITLE)}, PAD, PAD + 18);
        g.fillStyle = '#7a7a80'; g.font = '13px system-ui, "Segoe UI", sans-serif';
        g.fillText(${JSON.stringify(items.length + ' 张')}, PAD, PAD + 38);
        let k = 0;
        for (const it of items) {
            const cx = PAD + (k % COLS) * (CELL + GAP);
            const cy = PAD + HEAD + Math.floor(k / COLS) * (CELL + GAP);
            const im = new Image();
            await new Promise((r, j) => { im.onload = r; im.onerror = j; im.src = it.u; });
            g.fillStyle = '#1b1b1f'; g.fillRect(cx, cy, CELL, CELL);
            const s = Math.min(CELL / im.naturalWidth, CELL / im.naturalHeight);
            const dw = im.naturalWidth * s, dh = im.naturalHeight * s;
            g.drawImage(im, cx + (CELL - dw) / 2, cy + (CELL - dh) / 2, dw, dh);
            g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(cx, cy, 26, 18);
            g.fillStyle = '#cfcfd4'; g.font = '11px monospace';
            g.fillText(String(it.i), cx + 5, cy + 13);
            k++;
        }
        return cv.toDataURL('image/jpeg', 0.9);
    })()`);

    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, NAME), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('wrote', path.join(OUT, NAME), W + 'x' + H, items.length + ' covers');
    app.exit(0);
});
