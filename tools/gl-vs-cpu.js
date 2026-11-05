// GL 路径 vs CPU 路径：同一个 LUT、同一张图，比较两次输出。
// 之前所有标定探针都覆盖了 QfsColor.pass 走 CPU 三线性，真实应用走的是 passGL，
// 如果两者不一致，标定就都是对着一条用户看不到的路径做的。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const jpeg = require('jpeg-js');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
const ACR = path.join(ROOT, 'shared', 'acr', 'cr-tables.bin');
const SHD = path.join(ROOT, 'shared', 'acr', 'cr-shadows.bin');
const dataUrl = (p) => 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');

ipcMain.handle('load-acr-tables', () => {
  const raw = fs.readFileSync(ACR);
  const planes = zlib.inflateSync(raw.slice(10));
  return {
    size: raw.readUInt16LE(4), count: raw.readUInt16LE(6), step: raw.readUInt16LE(8),
    data: planes.buffer.slice(planes.byteOffset, planes.byteOffset + planes.byteLength),
  };
});
ipcMain.handle('load-acr-shadows', () => {
  const raw = fs.readFileSync(SHD);
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
});
ipcMain.handle('get-prefs', () => ({}));

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
  });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 120; i++) {
    if (await w.webContents.executeJavaScript('!!(window.App && window.App.dom && window.AppXmp && window.QfsShadows)')) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const xmpText = fs.readFileSync(XMP, 'utf8');
  const out = await w.webContents.executeJavaScript(`(async () => {
   try {
    const A = window.App;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    A.saveCurrentTemplate = () => {};
    const glOk0 = !!(window.QfsColor && window.QfsColor.usingGL && window.QfsColor.usingGL());

    const raw = new Image();
    await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
    const TW = 1400, TH = Math.round(TW * raw.height / raw.width);
    const sc = document.createElement('canvas'); sc.width = TW; sc.height = TH;
    sc.getContext('2d').drawImage(raw, 0, 0, TW, TH);
    const src = new Image();
    await new Promise((r, j) => { src.onload = r; src.onerror = j; src.src = sc.toDataURL('image/png'); });

    const im = { name: 'DSC09381', el: src, w: src.naturalWidth, h: src.naturalHeight, exif: {} };
    A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    A.updateEmptyState(); A.refreshUI(); A._forceFitNext = true;
    if (window.QfsAcr.ensure) await window.QfsAcr.ensure();
    if (window.QfsShadows.ensure) await window.QfsShadows.ensure();
    await A.flushRender(); await sleep(300);

    const base = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;
    const grab = async () => {
      A.setGrade(base, { replace: true, full: true });
      await A.flushRender(); await sleep(250);
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender(); await sleep(800);
      const cv = im._grade && im._grade.canvas;
      if (!cv) return null;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
      return { w: cv.width, h: cv.height, data: Array.from(d.data) };
    };

    const glShot = await grab();

    // 换成 CPU 三线性实现再跑一遍
    const savedPass = window.QfsColor.pass, savedUsing = window.QfsColor.usingGL;
    window.QfsColor.usingGL = () => true;
    window.QfsColor.pass = function (src2, p, w2, h2, lut, haze) {
      const c = document.createElement('canvas');
      c.width = w2; c.height = h2;
      const g2 = c.getContext('2d');
      g2.drawImage(src2, 0, 0, w2, h2);
      if (!(lut && lut.rgba && lut.grid > 1)) return c;
      const img = g2.getImageData(0, 0, w2, h2), d = img.data;
      const G = lut.grid, A = lut.rgba, S = G - 1, size = G * G;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i] * S / 255, gg = d[i + 1] * S / 255, b = d[i + 2] * S / 255;
        const r0 = Math.min(S - 1, Math.floor(r)), g0 = Math.min(S - 1, Math.floor(gg)), b0 = Math.min(S - 1, Math.floor(b));
        const fr = r - r0, fg = gg - g0, fb = b - b0;
        let oR = 0, oG = 0, oB = 0;
        for (let db = 0; db < 2; db++) {
          const wb = db ? fb : 1 - fb;
          for (let dg = 0; dg < 2; dg++) {
            const wg = dg ? fg : 1 - fg, wy = wb * wg, y = g0 + dg;
            for (let dr = 0; dr < 2; dr++) {
              const wr = dr ? fr : 1 - fr;
              const idx = ((y * size) + (b0 + db) * G + (r0 + dr)) * 4;
              oR += wy * wr * A[idx]; oG += wy * wr * A[idx + 1]; oB += wy * wr * A[idx + 2];
            }
          }
        }
        d[i] = oR; d[i + 1] = oG; d[i + 2] = oB;
      }
      g2.putImageData(img, 0, 0);
      return c;
    };
    const cpuShot = await grab();
    window.QfsColor.pass = savedPass; window.QfsColor.usingGL = savedUsing;
    return { glOk0, glShot, cpuShot, lutKeys: Object.keys(window.QfsAcr || {}) };
   } catch (e) { return { error: String((e && e.stack) || e) }; }
  })()`);

  if (out.error) { console.log('渲染报错：', out.error); app.quit(); return; }
  console.log('WebGL 可用:', out.glOk0);
  const a = out.glShot, b = out.cpuShot;
  if (!a || !b) { console.log('抓图失败'); app.quit(); return; }
  const mean = (s) => { let r = 0, g = 0, bl = 0; const n = s.data.length / 4;
    for (let i = 0; i < s.data.length; i += 4) { r += s.data[i]; g += s.data[i + 1]; bl += s.data[i + 2]; }
    return [r / n, g / n, bl / n].map((v) => +v.toFixed(2)); };
  let mae = 0, mx = 0, cnt = 0, n = a.data.length / 4;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(a.data[i + k] - b.data[i + k]);
      mae += d; if (d > mx) mx = d;
      if (d > 3) cnt++;
    }
  }
  console.log('GL 均值 ', JSON.stringify(mean(a)));
  console.log('CPU 均值', JSON.stringify(mean(b)));
  console.log('MAE', (mae / n / 3).toFixed(2), ' 最大差', mx, ' 差>3 的通道占比', (100 * cnt / (n * 3)).toFixed(1) + '%');

  const dir = path.join(ROOT, 'tools', 'out');
  const dump = (name, s) => {
    const buf = Buffer.alloc(s.w * s.h * 4);
    for (let i = 0; i < s.w * s.h; i++) {
      buf[i * 4] = s.data[i * 4]; buf[i * 4 + 1] = s.data[i * 4 + 1];
      buf[i * 4 + 2] = s.data[i * 4 + 2]; buf[i * 4 + 3] = 255;
    }
    fs.writeFileSync(path.join(dir, name), jpeg.encode({ data: buf, width: s.w, height: s.h }, 96).data);
  };
  dump('gl_path.jpg', a); dump('cpu_path.jpg', b);
  console.log('落盘 gl_path.jpg / cpu_path.jpg');
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
