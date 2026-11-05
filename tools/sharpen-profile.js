// 锐化 applyCanvas 的分段耗时：定位全分辨率那 1.5 秒到底花在哪一段。
// 复刻产品实现（app-sharpen.js）的四段：取像素 / 横向 / 纵向 / 合成写回。
// 用法：node tools/run-electron.js tools/sharpen-profile.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.env.QF_IMG || 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const dataUrl = (p) => 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');
ipcMain.handle('get-prefs', () => ({}));

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 900, height: 700,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
  });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 80; i++) {
    if (await w.webContents.executeJavaScript('!!(window.QfsSharpen)')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const out = await w.webContents.executeJavaScript(`(async () => {
    const raw = new Image();
    await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
    const W = raw.naturalWidth, H = raw.naturalHeight;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    cv.getContext('2d').drawImage(raw, 0, 0);
    const g = cv.getContext('2d', { willReadFrequently: true });
    const res = { size: W + 'x' + H };
    const T = () => performance.now();

    let t = T();
    const img = g.getImageData(0, 0, W, H);
    res.getImageData = +(T() - t).toFixed(1);
    const d = img.data;
    const n = W * H;
    const r = 2, k = new Float32Array([0.0625, 0.25, 0.375, 0.25, 0.0625]);

    t = T();
    const A = new Float32Array(n);
    res.allocA = +(T() - t).toFixed(1);

    t = T();
    const row = new Float32Array(W);
    for (let y = 0; y < H; y++) {
      const base = y * W, off = base * 4;
      for (let x = 0; x < W; x++) {
        const p = off + x * 4;
        row[x] = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
      }
      for (let x = 0; x < W; x++) {
        let s = 0;
        const lo = x - r < 0 ? 0 : x - r;
        const hi = x + r >= W ? W - 1 : x + r;
        for (let i = lo; i <= hi; i++) s += row[i] * k[i - x + r];
        A[base + x] = s;
      }
    }
    res.horizontal = +(T() - t).toFixed(1);

    t = T();
    const B = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const dst = y * W;
      const klo = r - y > 0 ? r - y : 0;
      const khi = r + (H - 1 - y) < 2 * r ? r + (H - 1 - y) : 2 * r;
      for (let j = klo; j <= khi; j++) {
        const src = (y + j - r) * W;
        const kj = k[j];
        for (let x = 0; x < W; x++) B[dst + x] += A[src + x] * kj;
      }
    }
    res.vertical = +(T() - t).toFixed(1);

    t = T();
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const L = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
      const hp = L - B[i];
      const delta = 1.0 * hp * 0.5;
      let v = d[p] + delta; d[p] = v < 0 ? 0 : (v > 255 ? 255 : v);
      v = d[p + 1] + delta; d[p + 1] = v < 0 ? 0 : (v > 255 ? 255 : v);
      v = d[p + 2] + delta; d[p + 2] = v < 0 ? 0 : (v > 255 ? 255 : v);
    }
    res.composite = +(T() - t).toFixed(1);

    t = T();
    g.putImageData(img, 0, 0);
    res.putImageData = +(T() - t).toFixed(1);

    // 再跑一遍（同一进程，热态），看是否只是首帧的分配/GC 成本
    const t2 = T();
    window.QfsSharpen.applyCanvas(cv, { shp: 40, shr: 0.5, shd: 25, shm: 0 }, W, W);
    res.applyCanvasHot = +(T() - t2).toFixed(1);

    // getImageData 为什么 550ms：把「画上去」和「读回来」分开量，
    // 再对比软件后备画布（willReadFrequently）——GPU 后备的读回要等同步 + 格式转换。
    const mk = (freq) => {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g2 = c.getContext('2d', freq ? { willReadFrequently: true } : undefined);
      g2.filter = 'brightness(1.02) contrast(1.05)';
      g2.drawImage(raw, 0, 0);
      g2.filter = 'none';
      return { c, g: g2 };
    };
    for (const freq of [false, true]) {
      const { c, g: g2 } = mk(freq);
      let tt = T();
      g2.getImageData(0, 0, 1, 1);
      const sync = T() - tt;
      tt = T();
      g2.getImageData(0, 0, W, H);
      const full = T() - tt;
      const tag = freq ? 'readFreq' : 'gpu';
      res[tag] = { sync1px: +sync.toFixed(1), full: +full.toFixed(1) };
      void c;
    }
    return res;
  })()`);
  console.log(JSON.stringify(out, null, 2));
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
