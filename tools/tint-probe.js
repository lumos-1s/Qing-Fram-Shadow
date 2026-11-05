// tint 轴标定：固定其余参数，只扫 tint，和 LR 的 tint=0/50/100 三张导出比。
// 三个参照用的是同一个预设，唯一差别就是 crs:Tint，所以任何偏差只能归到 tint 实现。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const jpeg = require('jpeg-js');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
const LR = (t) => 'C:/Users/lumos/Desktop/未命名导出/tint=' + t + '.jpg';
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

const CPU_PASS = `
  window.__cpuPass = function (src, p, w, h, lut, haze) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0, w, h);
    if (!(lut && lut.rgba && lut.grid > 1)) return c;
    const img = g.getImageData(0, 0, w, h);
    const d = img.data;
    const G = lut.grid, A = lut.rgba, S = G - 1;
    const size = G * G;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] * S / 255, gg = d[i + 1] * S / 255, b = d[i + 2] * S / 255;
      const r0 = Math.min(S - 1, Math.floor(r)), g0 = Math.min(S - 1, Math.floor(gg)), b0 = Math.min(S - 1, Math.floor(b));
      const fr = r - r0, fg = gg - g0, fb = b - b0;
      let outR = 0, outG = 0, outB = 0;
      for (let db = 0; db < 2; db++) {
        const wb = db ? fb : 1 - fb;
        for (let dg2 = 0; dg2 < 2; dg2++) {
          const wg = dg2 ? fg : 1 - fg;
          const wy = wb * wg, y = g0 + dg2;
          for (let dr = 0; dr < 2; dr++) {
            const wr = dr ? fr : 1 - fr;
            const idx = ((y * size) + (b0 + db) * G + (r0 + dr)) * 4;
            outR += wy * wr * A[idx];
            outG += wy * wr * A[idx + 1];
            outB += wy * wr * A[idx + 2];
          }
        }
      }
      d[i] = outR; d[i + 1] = outG; d[i + 2] = outB;
    }
    g.putImageData(img, 0, 0);
    return c;
  };
  window.QfsColor.usingGL = () => true;
  window.QfsColor.pass = window.__cpuPass;
  true;
`;

function loadRGB(file, TW) {
  const img = jpeg.decode(fs.readFileSync(file), { useTArray: true, maxMemoryUsageInMB: 4096 });
  const TH = Math.round(TW * img.height / img.width);
  const out = new Uint8Array(TW * TH * 3);
  for (let y = 0; y < TH; y++) {
    const sy0 = Math.floor(y * img.height / TH), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * img.height / TH));
    for (let x = 0; x < TW; x++) {
      const sx0 = Math.floor(x * img.width / TW), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * img.width / TW));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const row = sy * img.width * 4;
        for (let sx = sx0; sx < sx1; sx++) {
          const s = row + sx * 4;
          r += img.data[s]; g += img.data[s + 1]; b += img.data[s + 2]; n++;
        }
      }
      const d = (y * TW + x) * 3;
      out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n;
    }
  }
  return { w: TW, h: TH, d: out };
}

const mean = (rgb) => {
  let r = 0, g = 0, b = 0; const n = rgb.w * rgb.h;
  for (let i = 0; i < rgb.d.length; i += 3) { r += rgb.d[i]; g += rgb.d[i + 1]; b += rgb.d[i + 2]; }
  return [r / n, g / n, b / n].map((v) => +v.toFixed(1));
};
const chroma = (rgb) => {
  let c = 0; const n = rgb.w * rgb.h;
  for (let i = 0; i < rgb.d.length; i += 3) {
    c += Math.max(rgb.d[i], rgb.d[i + 1], rgb.d[i + 2]) - Math.min(rgb.d[i], rgb.d[i + 1], rgb.d[i + 2]);
  }
  return +(c / n).toFixed(1);
};
const mae = (a, b) => {
  let s = 0; const n = Math.min(a.d.length, b.d.length) / 3;
  for (let i = 0; i < n * 3; i += 3) {
    s += Math.abs(a.d[i] - b.d[i]) + Math.abs(a.d[i + 1] - b.d[i + 1]) + Math.abs(a.d[i + 2] - b.d[i + 2]);
  }
  return +(s / n / 3).toFixed(2);
};

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
  await w.webContents.executeJavaScript(CPU_PASS);

  const xmpText = fs.readFileSync(XMP, 'utf8');
  const TW = 1400;
  const out = await w.webContents.executeJavaScript(`(async () => {
   try {
    const A = window.App;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    A.saveCurrentTemplate = () => {};
    const raw = new Image();
    await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
    const W = ${TW}, H = Math.round(${TW} * raw.height / raw.width);
    const sc = document.createElement('canvas'); sc.width = W; sc.height = H;
    sc.getContext('2d').drawImage(raw, 0, 0, W, H);
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
    const mapped = { temp: base.temp, tint: base.tint, wb: [base.temp, base.tint] };

    const run = async (tint) => {
      const p = JSON.parse(JSON.stringify(base));
      p.tint = tint;
      A.setGrade(p, { replace: true, full: true });
      await A.flushRender(); await sleep(250);
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender(); await sleep(650);
      const cv = im._grade && im._grade.canvas;
      if (!cv) return null;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
      return { w: cv.width, h: cv.height, data: Array.from(d.data) };
    };
    const shots = {};
    for (const t of [-100, -50, 0, 25, 38, 50, 75, 100]) shots['t' + t] = await run(t);
    return { shots, mapped };
   } catch (e) { return { error: String((e && e.stack) || e) }; }
  })()`);

  if (out.error) { console.log('渲染报错：', out.error); app.quit(); return; }
  console.log('XMP 映射：temp =', out.mapped.temp, ' tint =', out.mapped.tint, '（预设 Tint=+38，Temperature=4769K）\n');

  const toRGB = (s) => {
    const n = s.w * s.h, d = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) { d[i * 3] = s.data[i * 4]; d[i * 3 + 1] = s.data[i * 4 + 1]; d[i * 3 + 2] = s.data[i * 4 + 2]; }
    return { w: s.w, h: s.h, d };
  };
  const lr = { 0: loadRGB(LR('0'), TW), 50: loadRGB(LR('50'), TW), 100: loadRGB(LR('100'), TW) };
  console.log('           tint      R       G       B     C      vs LR0   vs LR50');
  for (const t of [-100, -50, 0, 25, 38, 50, 75, 100]) {
    const s = out.shots['t' + t];
    if (!s) continue;
    const rgb = toRGB(s);
    const m = mean(rgb);
    console.log(String(t).padStart(11), String(m[0]).padStart(7), String(m[1]).padStart(7), String(m[2]).padStart(7),
      String(chroma(rgb)).padStart(6), String(mae(rgb, lr[0])).padStart(8), String(mae(rgb, lr[50])).padStart(8));
  }
  for (const t of [0, 50, 100]) {
    const m = mean(lr[t]);
    console.log(('LR tint=' + t).padStart(11), String(m[0]).padStart(7), String(m[1]).padStart(7), String(m[2]).padStart(7),
      String(chroma(lr[t])).padStart(6));
  }
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
