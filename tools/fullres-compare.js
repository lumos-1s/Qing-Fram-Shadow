// 全分辨率渲染后再比：预览 1600px 和导出 5905px 走的是同一段代码，
// 但阴影场、锐化半径、LUT 量化在高密度下的表现不一定一样。
// 做法：按原图尺寸烘焙一次，缩到 1400 与目标同口径比较。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
const TARGET = 'C:/Users/lumos/Desktop/ps修后图片/DSC09381_边框_1.jpg';
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
function loadRGB(file, decodePng) {
  let src;
  if (decodePng) {
    const p = PNG.sync.read(fs.readFileSync(file));
    src = { width: p.width, height: p.height, data: p.data };
  } else {
    src = jpeg.decode(fs.readFileSync(file), { useTArray: true, maxMemoryUsageInMB: 4096 });
  }
  const TH = Math.round(TW * src.height / src.width);
  const d = new Uint8Array(TW * TH * 3);
  for (let y = 0; y < TH; y++) {
    const sy0 = Math.floor(y * src.height / TH), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * src.height / TH));
    for (let x = 0; x < TW; x++) {
      const sx0 = Math.floor(x * src.width / TW), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * src.width / TW));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const row = sy * src.width * 4;
        for (let sx = sx0; sx < sx1; sx++) {
          const s = row + sx * 4;
          r += src.data[s]; g += src.data[s + 1]; b += src.data[s + 2]; n++;
        }
      }
      const o = (y * TW + x) * 3;
      d[o] = r / n; d[o + 1] = g / n; d[o + 2] = b / n;
    }
  }
  return { w: TW, h: TH, d };
}

const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
function lab(r, g, b) {
  const R = f(r), G = f(g), B = f(b);
  let X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  let Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const t = (v) => v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
  return [116 * t(Y) - 16, 500 * (t(X) - t(Y)), 200 * (t(Y) - t(Z))];
}
function blocks(a, b, nx, ny) {
  const rows = [], bw = Math.floor(a.w / nx), bh = Math.floor(a.h / ny);
  for (let by = 0; by < ny; by++) {
    const row = [];
    for (let bx = 0; bx < nx; bx++) {
      let sa = [0, 0, 0], sb = [0, 0, 0], n = 0;
      for (let y = by * bh; y < (by + 1) * bh; y++) {
        for (let x = bx * bw; x < (bx + 1) * bw; x++) {
          const i = (y * a.w + x) * 3;
          const la = lab(a.d[i], a.d[i + 1], a.d[i + 2]), lb = lab(b.d[i], b.d[i + 1], b.d[i + 2]);
          sa[0] += la[0]; sa[1] += la[1]; sa[2] += la[2];
          sb[0] += lb[0]; sb[1] += lb[1]; sb[2] += lb[2];
          n++;
        }
      }
      row.push({ dL: sa[0] / n - sb[0] / n, da: sa[1] / n - sb[1] / n, db: sa[2] / n - sb[2] / n });
    }
    rows.push(row);
  }
  return rows;
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
  console.log('按原图分辨率烘焙（5905×3937），可能需要几十秒…');
  const t0 = Date.now();
  const out = await w.webContents.executeJavaScript(`(async () => {
   try {
    const A = window.App;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    A.saveCurrentTemplate = () => {};
    const raw = new Image();
    await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
    const im = { name: 'DSC09381', el: raw, w: raw.naturalWidth, h: raw.naturalHeight, exif: {} };
    A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    A.updateEmptyState(); A.refreshUI(); A._forceFitNext = true;
    if (window.QfsAcr.ensure) await window.QfsAcr.ensure();
    if (window.QfsShadows.ensure) await window.QfsShadows.ensure();
    await A.flushRender(); await sleep(300);
    const base = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;
    const t1 = performance.now();
    A.setGrade(base, { replace: true, full: true });
    await A.flushRender(); await sleep(200);
    if (window.ensureFullGrade) window.ensureFullGrade(im);
    await A.flushRender(); await sleep(2500);
    const cv = im._grade && im._grade.canvas;
    if (!cv) return { error: 'no canvas' };
    const ms = performance.now() - t1;
    return { w: cv.width, h: cv.height, ms: Math.round(ms), url: cv.toDataURL('image/png') };
   } catch (e) { return { error: String((e && e.stack) || e) }; }
  })()`);
  if (out.error) { console.log('渲染报错：', out.error); app.quit(); return; }

  const buf = Buffer.from(out.url.split(',')[1], 'base64');
  const tmp = path.join(ROOT, 'tools', 'out', 'fullres_ours.png');
  fs.writeFileSync(tmp, buf);
  console.log('烘焙', out.w + 'x' + out.h, '用时', out.ms, 'ms（总', ((Date.now() - t0) / 1000).toFixed(1), 's）');

  const ours = loadRGB(tmp, true);
  const tgt = loadRGB(TARGET, false);
  const mean = (rgb) => { let r = 0, g = 0, b = 0; const n = rgb.w * rgb.h;
    for (let i = 0; i < rgb.d.length; i += 3) { r += rgb.d[i]; g += rgb.d[i + 1]; b += rgb.d[i + 2]; }
    return [r / n, g / n, b / n].map((v) => +v.toFixed(1)); };
  const meanLab = (rgb) => { let L = 0, A = 0, B = 0; const n = rgb.w * rgb.h;
    for (let i = 0; i < rgb.d.length; i += 3) { const t = lab(rgb.d[i], rgb.d[i + 1], rgb.d[i + 2]); L += t[0]; A += t[1]; B += t[2]; }
    return [L / n, A / n, B / n].map((v) => +v.toFixed(1)); };
  console.log('\n             RGB                  Lab');
  console.log('目标  ', JSON.stringify(mean(tgt)).padEnd(22), JSON.stringify(meanLab(tgt)));
  console.log('全分辨率', JSON.stringify(mean(ours)).padEnd(22), JSON.stringify(meanLab(ours)));
  console.log('\n分块 ΔLab（我们 − 目标）');
  blocks(ours, tgt, 4, 3).forEach((row, j) =>
    console.log('  行' + j, row.map((c) => `L${c.dL > 0 ? '+' : ''}${c.dL.toFixed(0)} a${c.da > 0 ? '+' : ''}${c.da.toFixed(0)} b${c.db > 0 ? '+' : ''}${c.db.toFixed(0)}`).join(' | ')));
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
