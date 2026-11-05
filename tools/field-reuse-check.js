// 阴影场跨分辨率复用的一致性检查。
//
// 松手补全分辨率时，场直接复用拖动档（1600px）算好的那份，再重采样到全分辨率
// 的格数。本脚本验证「复用」与「按全分辨率重算」的像素差，并给出两边耗时。
//
// 判据：最大差 ≤2 级（8 位）。场是低频量，重采样误差应当远小于这个数。
//
// 用法：
//   node tools/run-electron.js tools/field-reuse-check.js
//   QF_ELECTRON_FLAGS="--use-gl=swiftshader --no-sandbox" node tools/run-electron.js tools/field-reuse-check.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.env.QF_IMG || 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const SHD = path.join(ROOT, 'shared', 'acr', 'cr-shadows.bin');
const dataUrl = (p) => 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');

ipcMain.handle('load-acr-shadows', () => {
  const raw = fs.readFileSync(SHD);
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
});
ipcMain.handle('get-prefs', () => ({}));

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 900, height: 700,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
  });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 120; i++) {
    if (await w.webContents.executeJavaScript('!!(window.QfsShadows && window.QfsColor)')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const out = await w.webContents.executeJavaScript(`(async () => {
   try {
    await window.QfsShadows.ensure();
    const raw = new Image();
    await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
    const FW = raw.naturalWidth, FH = raw.naturalHeight;
    const mk = (W, H) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      // 与 bakeOne 的输入同口径：先过一遍色调，再施加阴影
      g.filter = 'brightness(1.02) contrast(1.06) saturate(1.04)';
      g.drawImage(raw, 0, 0, W, H);
      g.filter = 'none';
      return c;
    };
    const LW = 1600, LH = Math.round(1600 * FH / FW);
    const res = { src: FW + 'x' + FH, low: LW + 'x' + LH };

    // ① 拖动档先把场算出来（键里只有长宽比，不含像素数）
    const low = mk(LW, LH);
    let t = performance.now();
    window.QfsShadows.applyCanvas(low, -30, 'reuse|' + (LW / LH).toFixed(3));
    res.lowMs = +(performance.now() - t).toFixed(1);

    // ② 全分辨率：复用拖动档的场（会重采样到 591×394）
    const a = mk(FW, FH);
    t = performance.now();
    window.QfsShadows.applyCanvas(a, -30, 'reuse|' + (LW / LH).toFixed(3));
    res.fullReuseMs = +(performance.now() - t).toFixed(1);

    // ③ 全分辨率：独立的键 → 按全分辨率重算场（旧行为）
    const b = mk(FW, FH);
    t = performance.now();
    window.QfsShadows.applyCanvas(b, -30, 'fresh|' + (LW / LH).toFixed(3));
    res.fullFreshMs = +(performance.now() - t).toFixed(1);

    const A = a.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, FW, FH).data;
    const B = b.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, FW, FH).data;
    let max = 0, sum = 0, over1 = 0, over2 = 0, n = 0;
    for (let i = 0; i < A.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        const d = Math.abs(A[i + k] - B[i + k]);
        if (d > max) max = d;
        sum += d; n++;
        if (d > 1) over1++;
        if (d > 2) over2++;
      }
    }
    res.maxDiff = max;
    res.meanDiff = +(sum / n).toFixed(4);
    res.pctOver1 = +(100 * over1 / n).toFixed(3);
    res.pctOver2 = +(100 * over2 / n).toFixed(3);
    res.savedMs = +(res.fullFreshMs - res.fullReuseMs).toFixed(1);
    return res;
   } catch (e) { return { err: String(e && e.message || e) }; }
  })()`);
  console.log(JSON.stringify(out, null, 2));
  if (out.err) { app.exit(1); return; }
  if (out.maxDiff > 2) {
    console.log('FAIL  复用场与重算场的像素差超过 2 级');
    app.exit(1);
    return;
  }
  console.log('PASS  复用场的最大像素差 ≤2 级，松手省 ' + out.savedMs + 'ms');
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.exit(1); });
