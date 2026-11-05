// 阴影 pass 的增益标定：把送入系数表的 amount 乘一个系数 m，扫 m，
// 用 tint=0 的同口径参照（LR tint=0）挑使分带残差最小的 m。
// 只改 amount 不改模型，保持空间自适应的形状，只校准"这个 −30 到底该压多少"。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const jpeg = require('jpeg-js');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
const LR0 = 'C:/Users/lumos/Desktop/未命名导出/tint=0.jpg';
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
  window.__cpuPass = function (src, p, w, h, lut) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0, w, h);
    if (!(lut && lut.rgba && lut.grid > 1)) return c;
    const img = g.getImageData(0, 0, w, h), d = img.data;
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
    g.putImageData(img, 0, 0);
    return c;
  };
  window.QfsColor.usingGL = () => true;
  window.QfsColor.pass = window.__cpuPass;
  true;
`;

const TW = 1400;
function loadRGB(file) {
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
      const o = (y * TW + x) * 3;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return { w: TW, h: TH, d: out };
}
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function soft(rgb, k) {
  const w = Math.floor(rgb.w / k), h = Math.floor(rgb.h / k);
  const d = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let j = 0; j < k; j++) {
      const row = (y * k + j) * rgb.w;
      for (let i = 0; i < k; i++) { const s = (row + x * k + i) * 3; r += rgb.d[s]; g += rgb.d[s + 1]; b += rgb.d[s + 2]; }
    }
    const n = k * k, o = (y * w + x) * 3;
    d[o] = r / n; d[o + 1] = g / n; d[o + 2] = b / n;
  }
  return { w, h, d };
}
function softDiff(ref, got) {
  const n = ref.w * ref.h;
  const bands = [[0, 48], [48, 96], [96, 144], [144, 192], [192, 256]].map((b) => ({ lo: b[0], hi: b[1], n: 0, sum: 0, abs: 0 }));
  let abs = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    const lr = luma(ref.d[j], ref.d[j + 1], ref.d[j + 2]);
    const lg = luma(got.d[j], got.d[j + 1], got.d[j + 2]);
    const dd = lg - lr;
    abs += Math.abs(dd); sum += dd;
    for (const b of bands) if (lr >= b.lo && lr < b.hi) { b.n++; b.sum += dd; b.abs += Math.abs(dd); break; }
  }
  return {
    abs: +(abs / n).toFixed(2), bias: +(sum / n).toFixed(2),
    bands: bands.map((b) => b.n ? `${(b.sum / b.n).toFixed(1)}±${(b.abs / b.n).toFixed(1)}` : '-')
  };
}

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
  const MS = [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1.0];
  const out = await w.webContents.executeJavaScript(`(async () => {
   try {
    const A = window.App;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    A.saveCurrentTemplate = () => {};
    const raw = new Image();
    await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
    const TW = ${TW}, TH = Math.round(TW * raw.height / raw.width);
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
    base.tint = 0;   // 与 LR 的 tint=0 基准对齐
    const sh0 = Number(base.sh) || -30;
    const res = {};
    for (const m of ${JSON.stringify(MS)}) {
      const p = JSON.parse(JSON.stringify(base));
      p.sh = sh0 * m;
      A.setGrade(p, { replace: true, full: true });
      await A.flushRender(); await sleep(220);
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender(); await sleep(700);
      const cv = im._grade && im._grade.canvas;
      if (!cv) { res[String(m)] = null; continue; }
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
      const arr = new Uint8Array(cv.width * cv.height * 3);
      for (let i = 0, p2 = 0; i < d.data.length; i += 4, p2 += 3) {
        arr[p2] = d.data[i]; arr[p2 + 1] = d.data[i + 1]; arr[p2 + 2] = d.data[i + 2];
      }
      res[String(m)] = { w: cv.width, h: cv.height, d: Array.from(arr) };
    }
    return { res, sh0 };
   } catch (e) { return { error: String((e && e.stack) || e) }; }
  })()`);

  if (out.error) { console.log('渲染报错：', out.error); app.quit(); return; }
  const ref = loadRGB(LR0);
  const refSoft = soft(ref, 4);
  console.log('LR 自身分位数固定，比较的是「软差」：abs 越小越像；分带负=我们更暗\n');
  console.log(' m     软差abs   整体偏   分带(暗→亮, 均值±散差)');
  for (const m of MS) {
    const s = out.res[String(m)];
    if (!s) { console.log(String(m).padStart(4), ' 失败'); continue; }
    const d = softDiff(refSoft, soft({ w: s.w, h: s.h, d: Uint8Array.from(s.d) }, 4));
    console.log(String(m).padStart(4), String(d.abs).padStart(8), String(d.bias).padStart(8), '  ', d.bands.join(' | '));
  }
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
