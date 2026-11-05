// tint 轴标定：比较「我们」与「LR 导出」在 tint 0→50→100 上的增量是否同幅。
// 只看增量不看绝对值，可以避开基准图来源的干扰。
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

const TW = 1200;
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
      const d = (y * TW + x) * 3;
      out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n;
    }
  }
  return { w: TW, h: TH, d: out };
}

const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
function lab(r, g, b) {
  const R = f(r), G = f(g), B2 = f(b);
  let X = (0.4124 * R + 0.3576 * G + 0.1805 * B2) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B2;
  let Z = (0.0193 * R + 0.1192 * G + 0.9505 * B2) / 1.08883;
  const t = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  X = t(X); Z = t(Z); const Y2 = t(Y);
  return [116 * Y2 - 16, 500 * (X - Y2), 200 * (Y2 - Z)];
}

// 统计：全局均值 + 黄色带（源色相 70-100°）的平均 a*,b*
function stats(im) {
  let r = 0, g = 0, b = 0, n = 0, sa = 0, sb = 0, sL = 0, ny = 0;
  for (let i = 0; i < im.w * im.h; i++) {
    const p = i * 3;
    r += im.d[p]; g += im.d[p + 1]; b += im.d[p + 2]; n++;
    const t = lab(im.d[p], im.d[p + 1], im.d[p + 2]);
    let h = Math.atan2(t[2], t[1]) * 180 / Math.PI; if (h < 0) h += 360;
    if (t[0] > 20 && t[0] < 240 && Math.hypot(t[1], t[2]) > 12 && h >= 70 && h < 100) {
      sa += t[1]; sb += t[2]; sL += t[0]; ny++;
    }
  }
  return { rgb: [r / n, g / n, b / n], a: sa / ny, b: sb / ny, L: sL / ny, ny };
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
    const run = async (tint) => {
      const p = JSON.parse(JSON.stringify(base));
      p.tint = tint;
      A.setGrade(p, { replace: true, full: true });
      await A.flushRender(); await sleep(220);
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender(); await sleep(600);
      const cv = im._grade && im._grade.canvas;
      if (!cv) return null;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const n = cv.width * cv.height, rgb = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) { rgb[i*3] = d[i*4]; rgb[i*3+1] = d[i*4+1]; rgb[i*3+2] = d[i*4+2]; }
      return { w: cv.width, h: cv.height, d: Array.from(rgb) };
    };
    const shots = {};
    for (const t of [0, 25, 50, 100]) shots['t' + t] = await run(t);
    return { shots };
   } catch (e) { return { error: String((e && e.stack) || e) }; }
  })()`);

  if (out.error) { console.log('渲染报错：', out.error); app.quit(); return; }

  const tab = {};
  for (const t of [0, 25, 50, 100]) {
    const s = out.shots['t' + t];
    if (s) tab['ours' + t] = stats({ w: s.w, h: s.h, d: Uint8Array.from(s.d) });
  }
  for (const t of [0, 50, 100]) tab['lr' + t] = stats(loadRGB(LR(t)));

  console.log('              R       G       B    |  黄带 a*    b*    L*');
  for (const k of Object.keys(tab)) {
    const v = tab[k];
    console.log(k.padEnd(9), v.rgb.map((x) => x.toFixed(1).padStart(7)).join(''),
      '|', v.a.toFixed(1).padStart(6), v.b.toFixed(1).padStart(6), v.L.toFixed(1).padStart(6));
  }
  console.log('\n增量（相对各自 tint=0）          ΔR      ΔG      ΔB   |   Δa*    Δb*');
  for (const k of ['ours25', 'ours50', 'ours100', 'lr50', 'lr100']) {
    const a = tab[k], z = tab[k.startsWith('ours') ? 'ours0' : 'lr0'];
    if (!a || !z) continue;
    console.log(k.padEnd(9),
      [0, 1, 2].map((i) => (a.rgb[i] - z.rgb[i]).toFixed(1).padStart(7)).join(''),
      '|', (a.a - z.a).toFixed(1).padStart(6), (a.b - z.b).toFixed(1).padStart(6));
  }
  console.log('\n斜率比（我们 / LR，按 tint 值折算）');
  const slope = (k0, k1, t0, t1, f) => (tab[k1][f] - tab[k0][f]) / (t1 - t0);
  for (const [k, lo, hi, t0, t1] of [['R', 'ours0', 'ours50', 0, 50], ['G', 'ours0', 'ours50', 0, 50], ['B', 'ours0', 'ours50', 0, 50]]) {
    const i = { R: 0, G: 1, B: 2 }[k];
    const so = (tab[hi].rgb[i] - tab[lo].rgb[i]) / 50;
    const sl = (tab.lr50.rgb[i] - tab.lr0.rgb[i]) / 50;
    console.log('  通道', k, '我们', so.toFixed(3), 'LR', sl.toFixed(3), ' 比', (so / sl).toFixed(2));
  }
  console.log('  Δa*: 我们', slope('ours0', 'ours50', 0, 50, 'a').toFixed(3), 'LR', slope('lr0', 'lr50', 0, 50, 'a').toFixed(3),
    ' 比', (slope('ours0', 'ours50', 0, 50, 'a') / slope('lr0', 'lr50', 0, 50, 'a')).toFixed(2));
  console.log('  Δb*: 我们', slope('ours0', 'ours50', 0, 50, 'b').toFixed(3), 'LR', slope('lr0', 'lr50', 0, 50, 'b').toFixed(3),
    ' 比', (slope('ours0', 'ours50', 0, 50, 'b') / slope('lr0', 'lr50', 0, 50, 'b')).toFixed(2));
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
