// 逐档消融 + 按色相带对比 LR：定位「颜色不够艳」到底丢在哪个阶段
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
const LR = 'C:/Users/lumos/Desktop/未命名导出/tint=0.jpg';
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
    const G = lut.grid, A = lut.rgba, S = G - 1, size = G * G;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] * S / 255, gg = d[i + 1] * S / 255, b = d[i + 2] * S / 255;
      const r0 = Math.min(S - 1, Math.floor(r)), g0 = Math.min(S - 1, Math.floor(gg)), b0 = Math.min(S - 1, Math.floor(b));
      const fr = r - r0, fg = gg - g0, fb = b - b0;
      let outR = 0, outG = 0, outB = 0;
      for (let db = 0; db < 2; db++) {
        const wb = db ? fb : 1 - fb;
        for (let dg2 = 0; dg2 < 2; dg2++) {
          const wg = dg2 ? fg : 1 - fg, wy = wb * wg, y = g0 + dg2;
          for (let dr = 0; dr < 2; dr++) {
            const wr = dr ? fr : 1 - fr;
            const idx = ((y * size) + (b0 + db) * G + (r0 + dr)) * 4;
            outR += wy * wr * A[idx]; outG += wy * wr * A[idx + 1]; outB += wy * wr * A[idx + 2];
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

// 页面内的 Lab 统计：按色相带算平均 C*/L* 与占比
const LAB_STATS = `
  window.__labStats = function (cv) {
    const srgb = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const labF = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    const BANDS = [[345, 15], [15, 45], [45, 70], [70, 100], [100, 150], [150, 200], [200, 260], [260, 300], [300, 345]];
    const acc = BANDS.map(() => ({ n: 0, C: 0, L: 0 }));
    let allC = 0, allL = 0, allN = 0;
    const g = cv.getContext('2d');
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    for (let i = 0; i < d.length; i += 4) {
      const R = srgb(d[i]), G = srgb(d[i + 1]), B = srgb(d[i + 2]);
      const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
      const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
      const fx = labF(X), fy = labF(Y), fz = labF(Z);
      const L = 116 * fy - 16, a = 500 * (fx - fy), b2 = 200 * (fy - fz);
      const C = Math.hypot(a, b2);
      allC += C; allL += L; allN++;
      if (C < 6) continue;
      let h = Math.atan2(b2, a) * 180 / Math.PI; if (h < 0) h += 360;
      for (let k = 0; k < BANDS.length; k++) {
        const lo = BANDS[k][0], hi = BANDS[k][1];
        if (lo < hi ? (h >= lo && h < hi) : (h >= lo || h < hi)) { acc[k].n++; acc[k].C += C; acc[k].L += L; break; }
      }
    }
    return { allC: allC / allN, allL: allL / allN, allN, bands: acc.map((x) => ({ n: x.n, C: x.n ? x.C / x.n : 0, L: x.n ? x.L / x.n : 0 })) };
  };
  true;
`;

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
  await w.webContents.executeJavaScript(CPU_PASS + '\n' + LAB_STATS);

  const xmpText = fs.readFileSync(XMP, 'utf8');
  const TW = 1400;
  const out = await w.webContents.executeJavaScript(`(async () => {
    const A = window.App;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    A.saveCurrentTemplate = () => {};
    const raw = new Image();
    await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
    const W = ${TW}, H = Math.round(${TW} * raw.height / raw.width);
    const sc = document.createElement('canvas'); sc.width = W; sc.height = H;
    sc.getContext('2d').drawImage(raw, 0, 0, W, H);
    const src = new Image();
    await new Promise((r, j) => { src.onload = r; src.onerror = j; src.src = sc.toDataURL('image/jpeg', 0.98); });

    const im = { name: 'DSC09381', el: src, w: src.naturalWidth, h: src.naturalHeight, exif: {} };
    A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    A.updateEmptyState(); A.refreshUI(); A._forceFitNext = true;
    await window.QfsAcr.ensure(); await window.QfsShadows.ensure();
    await A.flushRender(); await sleep(300);

    const base = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;
    base.tint = 0;

    const run = async (patch) => {
      A.setGrade(patch, { replace: true, full: true });
      await A.flushRender(); await sleep(200);
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender(); await sleep(600);
      const cv = im._grade && im._grade.canvas;
      return cv ? window.__labStats(cv) : null;
    };
    const clone = (o) => JSON.parse(JSON.stringify(o));

    const r = {};
    r.source = window.__labStats(sc);
    r.full = await run(base);
    const p1 = clone(base); p1.sh = 0; r.noShadow = await run(p1);
    const p2 = clone(base); delete p2.mix; r.noMix = await run(p2);
    const p3 = clone(base); p3.sat = 0; p3.vib = 0; r.noSatVib = await run(p3);
    const p4 = clone(base); delete p4.cal; r.noCal = await run(p4);
    const p5 = clone(base); delete p5.curve; r.noCurve = await run(p5);
    const p6 = clone(base); p6.white = 0; p6.black = 0; r.noWhtBlk = await run(p6);
    return r;
  })()`);

  // LR 参照：用同一套 Lab 统计（Node 侧实现一遍，避免再进页面）
  const jpeg = require('jpeg-js');
  const srgb = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const labF = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const BANDS = [[345, 15], [15, 45], [45, 70], [70, 100], [100, 150], [150, 200], [200, 260], [260, 300], [300, 345]];
  function labStatsOf(file) {
    const img = jpeg.decode(fs.readFileSync(file), { useTArray: true, maxMemoryUsageInMB: 4096 });
    const TH = Math.round(1400 * img.height / img.width);
    const acc = BANDS.map(() => ({ n: 0, C: 0, L: 0 }));
    let allC = 0, allL = 0, allN = 0;
    for (let y = 0; y < TH; y++) {
      const sy0 = Math.floor(y * img.height / TH), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * img.height / TH));
      for (let x = 0; x < 1400; x++) {
        const sx0 = Math.floor(x * img.width / 1400), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * img.width / 1400));
        let R = 0, G = 0, B = 0, n = 0;
        for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
          const s = (sy * img.width + sx) * 4; R += img.data[s]; G += img.data[s + 1]; B += img.data[s + 2]; n++;
        }
        const lr = srgb(R / n), lg = srgb(G / n), lb = srgb(B / n);
        const X = (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047;
        const Y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
        const Z = (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883;
        const fx = labF(X), fy = labF(Y), fz = labF(Z);
        const L = 116 * fy - 16, a = 500 * (fx - fy), b2 = 200 * (fy - fz);
        const C = Math.hypot(a, b2);
        allC += C; allL += L; allN++;
        if (C < 6) continue;
        let h = Math.atan2(b2, a) * 180 / Math.PI; if (h < 0) h += 360;
        for (let k = 0; k < BANDS.length; k++) {
          const lo = BANDS[k][0], hi = BANDS[k][1];
          if (lo < hi ? (h >= lo && h < hi) : (h >= lo || h < hi)) { acc[k].n++; acc[k].C += C; acc[k].L += L; break; }
        }
      }
    }
    return { allC: allC / allN, allL: allL / allN, bands: acc.map((x) => ({ n: x.n, C: x.n ? x.C / x.n : 0, L: x.n ? x.L / x.n : 0 })) };
  }
  const LR2 = labStatsOf(LR);

  const names = ['黄绿 70-100', '绿 100-150', '黄 45-70', '橙 15-45', '青 150-200'];
  const idx = [3, 4, 2, 1, 5];
  console.log('整体 C*: LR', LR2.allC.toFixed(2));
  const keys = ['source', 'full', 'noShadow', 'noMix', 'noSatVib', 'noCal', 'noCurve', 'noWhtBlk'];
  const head = keys.map((k) => k.padStart(9)).join('');
  console.log('\n色相带' + head + '      LR');
  for (let j = 0; j < idx.length; j++) {
    const b = idx[j];
    const row = keys.map((k) => {
      const s = out[k];
      return (s && s.bands[b].n ? s.bands[b].C.toFixed(1) : '-').padStart(9);
    }).join('');
    console.log(names[j].padEnd(12) + row + LR2.bands[b].C.toFixed(1).padStart(9));
  }
  console.log('\nL*（明度）');
  console.log('色相带' + head + '      LR');
  for (let j = 0; j < idx.length; j++) {
    const b = idx[j];
    const row = keys.map((k) => {
      const s = out[k];
      return (s && s.bands[b].n ? s.bands[b].L.toFixed(1) : '-').padStart(9);
    }).join('');
    console.log(names[j].padEnd(12) + row + LR2.bands[b].L.toFixed(1).padStart(9));
  }
  console.log('\n整体 C* 汇总');
  for (const k of keys) console.log(k.padEnd(10), out[k] ? out[k].allC.toFixed(2) : '-');
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
