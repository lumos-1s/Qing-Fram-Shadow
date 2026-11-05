// 锐化 CPU pass 的耗时：预览 1400 / 大预览 2400 / 全尺寸 4000 三档。
// 这个 pass 每次烘焙都会跑（除非锐化量为 0），所以要和阴影 pass 一起看总账。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
ipcMain.handle('load-acr-tables', () => ({ size: 17, count: 0, step: 3, data: new ArrayBuffer(0) }));
ipcMain.handle('get-prefs', () => ({}));

app.whenReady().then(async () => {
    const w = new BrowserWindow({
        show: false, width: 900, height: 600,
        webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
    });
    await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 80; i++) {
        if (await w.webContents.executeJavaScript('!!window.QfsSharpen')) break;
        await new Promise((r) => setTimeout(r, 200));
    }
    const res = await w.webContents.executeJavaScript(`(() => {
      const mk = (W, H) => {
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d');
        const d = g.createImageData(W, H);
        for (let i = 0, p = 0; i < W * H; i++, p += 4) {
          const v = 90 + 60 * Math.sin(i * 0.01) + 40 * Math.sin((i % W) * 0.03);
          d.data[p] = v; d.data[p + 1] = v * 0.95; d.data[p + 2] = v * 0.9; d.data[p + 3] = 255;
        }
        g.putImageData(d, 0, 0);
        return c;
      };
      const det = { shp: 40, shr: 0.5, shd: 60, shm: 34 };
      const out = {};
      for (const W of [1400, 2400, 4000]) {
        const H = Math.round(W * 2 / 3);
        const c = mk(W, H);
        window.QfsSharpen.applyCanvas(c, det);              // 预热
        const t0 = performance.now();
        window.QfsSharpen.applyCanvas(c, det);
        out[W] = +(performance.now() - t0).toFixed(1);
      }
      const c0 = mk(1400, 933);
      const t1 = performance.now();
      window.QfsSharpen.applyCanvas(c0, { shp: 0 });
      out.off = +(performance.now() - t1).toFixed(2);
      return out;
    })()`);
    console.log('锐化耗时(ms):', JSON.stringify(res));
    app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
