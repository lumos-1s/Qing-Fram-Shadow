// 逐级消融：单独关掉某个颜色 stage，看它对整体色偏的贡献。
// 用来定位「黄叶转向品红」的剩余来源。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

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
      let oR = 0, oG = 0, oB = 0;
      for (let db = 0; db < 2; db++) {
        const wb = db ? fb : 1 - fb;
        for (let dg2 = 0; dg2 < 2; dg2++) {
          const wg = dg2 ? fg : 1 - fg;
          const wy = wb * wg, y = g0 + dg2;
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
    const run = async (mut) => {
      const p = JSON.parse(JSON.stringify(base));
      if (mut) mut(p);
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
    const r = {};
    r.base = await run(null);
    r.noHigh = await run((p) => { if (p.cg) p.cg.high = { h: 0, s: 0, l: 0 }; });
    r.noShadow = await run((p) => { if (p.cg) p.cg.shadow = { h: 0, s: 0, l: 0 }; });
    r.noHigh2x = await run((p) => { if (p.cg) p.cg.high = { h: 80, s: 36, l: 0 }; });
    r.high200 = await run((p) => { if (p.cg) p.cg.high = { h: 200, s: 12, l: 0 }; });
    r.noCg = await run((p) => { p.cg = null; });
    return { r, base: { temp: base.temp, tint: base.tint, cal: base.cal, cg: base.cg } };
   } catch (e) { return { error: String((e && e.stack) || e) }; }
  })()`);

  if (out.error) { console.log('渲染报错：', out.error); app.quit(); return; }
  console.log('预设：temp', out.base.temp, 'tint', out.base.tint);
  console.log('cal =', JSON.stringify(out.base.cal));
  console.log('cg  =', JSON.stringify(out.base.cg), '\n');

  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lab = (r, g, b) => {
    const R = f(r), G = f(g), B2 = f(b);
    let X = (0.4124 * R + 0.3576 * G + 0.1805 * B2) / 0.95047;
    const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B2;
    let Z = (0.0193 * R + 0.1192 * G + 0.9505 * B2) / 1.08883;
    const t = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
    X = t(X); Z = t(Z); const Y2 = t(Y);
    return [116 * Y2 - 16, 500 * (X - Y2), 200 * (Y2 - Z)];
  };
  const stat = (s) => {
    let r = 0, g = 0, b = 0, n = 0, C = 0, L = 0, sa = 0, sb = 0, sh = 0, sn = 0;
    const BANDS = [[0, 38], [38, 62], [62, 78], [78, 101]];
    const bands = BANDS.map(() => ({ n: 0, r: 0, g: 0, b: 0 }));
    for (let i = 0; i < s.w * s.h; i++) {
      const p = i * 3;
      const R = s.d[p], G = s.d[p + 1], B = s.d[p + 2];
      r += R; g += G; b += B; n++;
      const t = lab(R, G, B);
      const c = Math.hypot(t[1], t[2]);
      C += c; L += t[0];
      const bi = BANDS.findIndex(([x, y]) => t[0] >= x && t[0] < y);
      if (bi >= 0) { const q = bands[bi]; q.n++; q.r += R; q.g += G; q.b += B; }
      if (t[0] > 20 && t[0] < 244 && c > 14) {
        let h = Math.atan2(t[2], t[1]) * 180 / Math.PI; if (h < 0) h += 360;
        if (h >= 65 && h < 105) { sa += t[1]; sb += t[2]; sh += h; sn++; }
      }
    }
    return {
      rgb: [r / n, g / n, b / n], C: C / n, L: L / n, a: sa / sn, b: sb / sn, h: sh / sn,
      n: sn / (s.w * s.h),
      bands: bands.map((q) => (q.n ? [q.r / q.n, q.g / q.n, q.b / q.n] : null)),
    };
  };
  const base = stat(out.r.base);
  console.log('变体            均值RGB              C*     L*    黄带a*  黄带b*  黄带h(°)  覆盖');
  for (const k of ['base', 'noHigh', 'noShadow', 'noHigh2x', 'high200', 'noCg']) {
    const s = out.r[k];
    if (!s) continue;
    const v = stat(s);
    console.log(k.padEnd(14), v.rgb.map((x) => x.toFixed(1)).join('/').padEnd(20),
      v.C.toFixed(1).padStart(5), v.L.toFixed(1).padStart(6),
      v.a.toFixed(1).padStart(7), v.b.toFixed(1).padStart(7), v.h.toFixed(1).padStart(8),
      (100 * v.n).toFixed(1).padStart(6) + '%');
  }
  const names = ['暗 L<38', '中 L38-62', '亮 L62-78', '高光 L>78'];
  console.log('\n分带均值（Δ = 该变体 − base）');
  for (const k of ['noHigh', 'noShadow', 'noHigh2x', 'high200', 'noCg']) {
    const s = out.r[k];
    if (!s) continue;
    const v = stat(s);
    const cells = v.bands.map((q, i) => {
      if (!q || !base.bands[i]) return names[i] + ' -';
      const d = [0, 1, 2].map((j) => q[j] - base.bands[i][j]);
      return names[i] + ' ' + d.map((x) => (x >= 0 ? '+' : '') + x.toFixed(1)).join(',');
    });
    console.log(' ' + k.padEnd(10) + cells.join(' | '));
  }
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
