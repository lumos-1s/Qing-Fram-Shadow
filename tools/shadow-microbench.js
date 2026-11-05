// 逐像素循环的分项耗时：在这个 Electron 运行时里到底哪一步慢
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const dataUrl = (p) => 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');
ipcMain.handle('get-prefs', () => ({}));

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 900, height: 700,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
  });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 120; i++) {
    if (await w.webContents.executeJavaScript('!!(window.App)')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const out = await w.webContents.executeJavaScript(`(async () => {
    const raw = new Image();
    await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
    const W = 1600, H = Math.round(1600 * raw.height / raw.width);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(raw, 0, 0, W, H);
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    const dec = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const e = i / 255; dec[i] = e <= 0.04045 ? e / 12.92 : Math.pow((e + 0.055) / 1.055, 2.4); }
    const tab = new Uint8Array(256 * 129);
    for (let i = 0; i < tab.length; i++) tab[i] = (i * 7) & 255;
    const A = new Float32Array(800 * 534); A.fill(0.6);
    const B = new Float32Array(800 * 534); B.fill(-2);
    const r0 = new Float32Array(35).fill(-0.1), r1 = new Float32Array(35).fill(0.1), r2 = new Float32Array(35).fill(-0.3);
    const lw = 800, lh = Math.ceil(H / 2), sc = 2;
    const res = {};

    const time = (name, fn) => {
      fn(); fn();
      const t = performance.now(); fn();
      res[name] = +(performance.now() - t).toFixed(1);
    };

    time('io', () => { const x = g.getImageData(0, 0, W, H); g.putImageData(x, 0, 0); });
    time('lum+log2', () => {
      let acc = 0;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.2126 * dec[d[i]] + 0.7152 * dec[d[i + 1]] + 0.0722 * dec[d[i + 2]];
        acc += Math.log2(lum < 1e-4 ? 1e-4 : lum);
      }
      return acc;
    });
    time('lum only', () => {
      let acc = 0;
      for (let i = 0; i < d.length; i += 4) {
        acc += 0.2126 * dec[d[i]] + 0.7152 * dec[d[i + 1]] + 0.0722 * dec[d[i + 2]];
      }
      return acc;
    });
    time('full-ish', () => {
      for (let y = 0; y < H; y++) {
        let fy = (y + 0.5) / sc - 0.5; fy = fy < 0 ? 0 : (fy > lh - 1 ? lh - 1 : fy);
        const y0 = fy | 0, y1 = y0 + 1 < lh ? y0 + 1 : y0, ty = fy - y0, rowA = y0 * lw, rowB = y1 * lw;
        let p = y * W * 4;
        for (let x = 0; x < W; x++, p += 4) {
          const lum = 0.2126 * dec[d[p]] + 0.7152 * dec[d[p + 1]] + 0.0722 * dec[d[p + 2]];
          if (lum <= 1e-4) continue;
          const level = Math.log2(lum);
          const fx = x / 2 - 0.25, i0 = fx | 0, i1 = i0 + 1, w1 = fx - i0;
          const sa = (A[rowA + i0] * (1 - w1) + A[rowA + i1] * w1) * (1 - ty) + (A[rowB + i0] * (1 - w1) + A[rowB + i1] * w1) * ty;
          const sb = (A[rowB + i0] * (1 - w1) + A[rowB + i1] * w1) * ty + (A[rowA + i0] * (1 - w1) + A[rowA + i1] * w1) * (1 - ty);
          const region = sa * level + sb, detail = level - region;
          let xp = (region + 14) / 0.5; xp = xp < 0 ? 0 : (xp > 34 ? 34 : xp);
          const c0 = xp | 0, ct = xp - c0;
          const lift = r0[c0] + (r1[c0] - r0[c0]) * ct + (r2[c0] + (r2[c0] - r2[c0]) * ct) * detail;
          let jf = (lift + 2) / 0.03125; jf = jf < 0 ? 0 : (jf > 128 ? 128 : jf);
          const j0 = jf | 0, jt = jf - j0, o0 = j0 * 256, o1 = (j0 + 1) * 256;
          d[p] = tab[o0 + d[p]] + (tab[o1 + d[p]] - tab[o0 + d[p]]) * jt;
          d[p + 1] = tab[o0 + d[p + 1]] + (tab[o1 + d[p + 1]] - tab[o0 + d[p + 1]]) * jt;
          d[p + 2] = tab[o0 + d[p + 2]] + (tab[o1 + d[p + 2]] - tab[o0 + d[p + 2]]) * jt;
        }
      }
    });
    return { px: W * H, res };
  })()`);
  console.log(JSON.stringify(out, null, 2));
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
