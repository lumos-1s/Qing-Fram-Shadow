// 单独测阴影 pass：看它到底改了多少像素、耗时多少
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
    const W = 1400, H = Math.round(1400 * raw.height / raw.width);
    const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').drawImage(raw, 0, 0, W, H); return c; };
    const stat = (c) => {
      const d = c.getContext('2d').getImageData(0, 0, W, H).data;
      let s = 0, n = 0; for (let i = 0; i < d.length; i += 4) { s += 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2]; n++; }
      return s / n;
    };
    const res = { info: window.QfsShadows.info() };
    for (const amt of [-30, -100, 100]) {
      const c = mk(); const before = stat(c);
      const t0 = performance.now();
      const ok = window.QfsShadows.applyCanvas(c, amt);
      const ms = performance.now() - t0;
      res['a' + amt] = { ok, ms: +ms.toFixed(1), before: +before.toFixed(2), after: +stat(c).toFixed(2) };
    }
    // 区域亮度场长什么样
    const c = mk();
    const f = window.QfsShadows.field(c);
    let amin = 9, amax = -9, asum = 0, bmin = 9, bmax = -9;
    for (let i = 0; i < f.a.length; i++) { amin = Math.min(amin, f.a[i]); amax = Math.max(amax, f.a[i]); asum += f.a[i]; bmin = Math.min(bmin, f.b[i]); bmax = Math.max(bmax, f.b[i]); }
    res.field = { lw: f.lw, lh: f.lh, scale: f.scale, key: +f.key.toFixed(2),
      a: [+amin.toFixed(3), +amax.toFixed(3), +(asum / f.a.length).toFixed(3)], b: [+bmin.toFixed(2), +bmax.toFixed(2)] };
    res.coef = Array.from(window.QfsShadows.coefficients(-30, 1400).slice(0, 8)).map((v) => +v.toFixed(3));
    return res;
  })()`);
  console.log(JSON.stringify(out, null, 2));
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
