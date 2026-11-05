// 阴影 pass 的耗时拆分：场计算 vs 逐像素施加
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
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
    if (await w.webContents.executeJavaScript('!!(window.QfsShadows)')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const out = await w.webContents.executeJavaScript(`(async () => {
    await window.QfsShadows.ensure();
    const raw = new Image();
    await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
    const res = {};
    for (const W of [1600, 1400]) {
      const H = Math.round(W * raw.height / raw.width);
      const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').drawImage(raw, 0, 0, W, H); return c; };
      const c0 = mk();
      // 预热
      window.QfsShadows.field(c0); window.QfsShadows.applyCanvas(mk(), -30);
      const t1 = performance.now(); window.QfsShadows.field(c0); const fieldMs = performance.now() - t1;
      const c1 = mk();
      const t2 = performance.now(); window.QfsShadows.applyCanvas(c1, -30); const applyMs = performance.now() - t2;
      const c2 = mk();
      const t3 = performance.now(); window.QfsShadows.applyCanvas(c2, -31); const applyMs2 = performance.now() - t3;
      // 带内容凭据：第二次起场直接命中缓存，只剩逐像素施加
      const k = 'bench|' + W;
      const c3 = mk();
      window.QfsShadows.applyCanvas(c3, -30, k);
      const t4 = performance.now(); window.QfsShadows.applyCanvas(mk(), -32, k); const warmMs = performance.now() - t4;
      res[W] = { size: W + 'x' + H, field: +fieldMs.toFixed(1), apply: +applyMs.toFixed(1),
        apply2: +applyMs2.toFixed(1), cached: +warmMs.toFixed(1) };
    }
    return res;
  })()`);
  console.log(JSON.stringify(out, null, 2));
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
