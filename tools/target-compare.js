// 「我们 vs 目标(PS 修后)」对比。目标 = Desktop/ps修后图片/DSC09381_边框_1.jpg，
// 是同一张原图人工修完的成片；这张才是用户眼里的"对"。
// 除了整体/分块 Lab，还落盘几组 1:1 并排裁切，供人眼核对色偏方向。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const jpeg = require('jpeg-js');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
const TARGET = 'C:/Users/lumos/Desktop/ps修后图片/DSC09381_边框_1.jpg';
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

const TW = 1732;
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

// sRGB → Lab（D65）
const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
function lab(r, g, b) {
  const R = f(r), G = f(g), B = f(b);
  let X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  let Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  let Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const t = (v) => v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
  X = t(X); Y = t(Y); Z = t(Z);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

// 分块统计（默认 4×3）
function blocks(a, b, nx, ny) {
  const rows = [];
  const bw = Math.floor(a.w / nx), bh = Math.floor(a.h / ny);
  for (let by = 0; by < ny; by++) {
    const row = [];
    for (let bx = 0; bx < nx; bx++) {
      let sa = [0, 0, 0], sb = [0, 0, 0], n = 0;
      for (let y = by * bh; y < (by + 1) * bh; y += 2) {
        for (let x = bx * bw; x < (bx + 1) * bw; x += 2) {
          const i = (y * a.w + x) * 3;
          const la = lab(a.d[i], a.d[i + 1], a.d[i + 2]);
          const lb = lab(b.d[i], b.d[i + 1], b.d[i + 2]);
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
    A.setGrade(base, { replace: true, full: true });
    await A.flushRender(); await sleep(250);
    if (window.ensureFullGrade) window.ensureFullGrade(im);
    await A.flushRender(); await sleep(900);
    const cv = im._grade && im._grade.canvas;
    if (!cv) return { error: 'no canvas' };
    return { w: cv.width, h: cv.height, data: Array.from(cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data),
             url: cv.toDataURL('image/jpeg', 0.95), tint: base.tint, temp: base.temp };
   } catch (e) { return { error: String((e && e.stack) || e) }; }
  })()`);

  if (out.error) { console.log('渲染报错：', out.error); app.quit(); return; }
  console.log('渲染', out.w + 'x' + out.h, ' tint =', out.tint, ' temp =', out.temp);

  const toRGB = () => {
    const n = out.w * out.h, d = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) { d[i * 3] = out.data[i * 4]; d[i * 3 + 1] = out.data[i * 4 + 1]; d[i * 3 + 2] = out.data[i * 4 + 2]; }
    return { w: out.w, h: out.h, d };
  };
  const ours = toRGB();
  const tgt = loadRGB(TARGET);
  const lr50 = loadRGB(LR('50'));
  const lr0 = loadRGB(LR('0'));

  const outDir = path.join(ROOT, 'tools', 'out');
  const writeRGB = (name, rgb) => {
    const rgba = Buffer.alloc(rgb.w * rgb.h * 4);
    for (let i = 0; i < rgb.w * rgb.h; i++) {
      rgba[i * 4] = rgb.d[i * 3]; rgba[i * 4 + 1] = rgb.d[i * 3 + 1]; rgba[i * 4 + 2] = rgb.d[i * 3 + 2]; rgba[i * 4 + 3] = 255;
    }
    fs.writeFileSync(path.join(outDir, name), jpeg.encode({ data: rgba, width: rgb.w, height: rgb.h }, 95).data);
  };
  writeRGB('t_target.jpg', tgt);
  writeRGB('t_ours.jpg', ours);
  writeRGB('t_lr50.jpg', lr50);

  const mean = (rgb) => { let r = 0, g = 0, b = 0; const n = rgb.w * rgb.h;
    for (let i = 0; i < rgb.d.length; i += 3) { r += rgb.d[i]; g += rgb.d[i + 1]; b += rgb.d[i + 2]; }
    return [r / n, g / n, b / n].map((v) => +v.toFixed(1)); };
  const meanLab = (rgb) => { let L = 0, A = 0, B = 0; const n = rgb.w * rgb.h;
    for (let i = 0; i < rgb.d.length; i += 3) { const t = lab(rgb.d[i], rgb.d[i + 1], rgb.d[i + 2]); L += t[0]; A += t[1]; B += t[2]; }
    return [L / n, A / n, B / n].map((v) => +v.toFixed(1)); };
  const mae = (a, b) => { let s = 0; const n = Math.min(a.d.length, b.d.length) / 3;
    for (let i = 0; i < n * 3; i += 3) s += Math.abs(a.d[i] - b.d[i]) + Math.abs(a.d[i + 1] - b.d[i + 1]) + Math.abs(a.d[i + 2] - b.d[i + 2]);
    return +(s / n / 3).toFixed(2); };

  console.log('\n               RGB                  Lab                    vs目标MAE');
  for (const [n, x] of [['目标(PS)', tgt], ['我们', ours], ['LR tint=50', lr50], ['LR tint=0', lr0]]) {
    console.log(n.padEnd(12), JSON.stringify(mean(x)).padEnd(22), JSON.stringify(meanLab(x)).padEnd(22),
      n.startsWith('目标') ? '' : mae(x, tgt));
  }

  console.log('\n分块 ΔLab（我们 − 目标，4×3，正 L 更亮 / 正 a 更红 / 正 b 更黄）');
  const bl = blocks(ours, tgt, 4, 3);
  bl.forEach((row, j) => console.log('  行' + j, row.map((c) => `L${c.dL > 0 ? '+' : ''}${c.dL.toFixed(0)} a${c.da > 0 ? '+' : ''}${c.da.toFixed(0)} b${c.db > 0 ? '+' : ''}${c.db.toFixed(0)}`).join(' | ')));

  // 1:1 并排：左目标 / 右我们
  const crops = [
    ['tc_leaves.jpg', 0.30, 0.02, 0.62, 0.20],
    ['tc_building.jpg', 0.02, 0.30, 0.30, 0.52],
    ['tc_road.jpg', 0.30, 0.62, 0.62, 0.86],
    ['tc_shadow.jpg', 0.05, 0.62, 0.35, 0.88]
  ];
  for (const [name, rx0, ry0, rx1, ry1] of crops) {
    const x0 = Math.round(rx0 * TW), y0 = Math.round(ry0 * tgt.h);
    const cw = Math.round((rx1 - rx0) * TW), ch = Math.round((ry1 - ry0) * tgt.h);
    const gap = 6, W = cw * 2 + gap, H = ch;
    const buf = Buffer.alloc(W * H * 4, 255);
    [tgt, ours].forEach((img, k) => {
      const ox = k * (cw + gap);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        const s = ((y + y0) * img.w + (x + x0)) * 3, d = (y * W + ox + x) * 4;
        buf[d] = img.d[s]; buf[d + 1] = img.d[s + 1]; buf[d + 2] = img.d[s + 2]; buf[d + 3] = 255;
      }
    });
    fs.writeFileSync(path.join(outDir, name), jpeg.encode({ data: buf, width: W, height: H }, 94).data);
    console.log('落盘', name, W + 'x' + H, '（左：目标 / 右：我们）');
  }
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
