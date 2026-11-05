// 锐化评价三件套：白场裁切、彩度、高频能量。单看高频能量会把"过锐"当成"对了"。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const jpeg = require('jpeg-js');

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

const TW = 1732;
function loadRGB(file) {
  const img = jpeg.decode(fs.readFileSync(file), { useTArray: true, maxMemoryUsageInMB: 4096 });
  const TH = Math.round(TW * img.height / img.width);
  const d = new Uint8Array(TW * TH * 3);
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
      d[o] = r / n; d[o + 1] = g / n; d[o + 2] = b / n;
    }
  }
  return { w: TW, h: TH, d };
}

// 高频能量：|Laplacian| 按亮度分档（平地 = 低梯度邻域，边缘 = 高梯度）
function hf(rgb) {
  const { w, h, d } = rgb;
  let flat = 0, flatN = 0, edge = 0, edgeN = 0;
  const bands = [0, 0, 0, 0], bandN = [0, 0, 0, 0];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const o = (y * w + x) * 3;
      const L = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const c = L(o), l = L(o - 3), r = L(o + 3), u = L(o - w * 3), dn = L(o + w * 3);
      const lap = Math.abs(4 * c - l - r - u - dn);
      const grad = Math.abs(r - l) + Math.abs(dn - u);
      const bi = Math.min(3, (c / 64) | 0);
      bands[bi] += lap; bandN[bi]++;
      if (grad < 4) { flat += lap; flatN++; } else if (grad > 24) { edge += lap; edgeN++; }
    }
  }
  return {
    flat: +(flat / Math.max(1, flatN)).toFixed(2),
    edge: +(edge / Math.max(1, edgeN)).toFixed(2),
    bands: bands.map((v, i) => +(v / Math.max(1, bandN[i])).toFixed(1))
  };
}

function pixelStats(rgb) {
  const n = rgb.w * rgb.h;
  let L = 0, C = 0, clip = 0, blk = 0, p999 = 0;
  const lums = new Uint32Array(256);
  for (let i = 0; i < rgb.d.length; i += 3) {
    const r = rgb.d[i], g = rgb.d[i + 1], b = rgb.d[i + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    L += l;
    C += Math.max(r, g, b) - Math.min(r, g, b);
    if (Math.max(r, g, b) >= 254) clip++;
    if (l < 24) blk++;
    lums[Math.min(255, l | 0)]++;
  }
  let acc = 0, target = n * 0.999;
  for (let i = 255; i >= 0; i--) { acc += lums[i]; if (acc >= n - target) { p999 = i; break; } }
  return { L: +(L / n).toFixed(1), C: +(C / n).toFixed(1), clip: +(100 * clip / n).toFixed(2), blk: +(100 * blk / n).toFixed(2), p999 };
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
    const run = async (mut) => {
      const p = JSON.parse(JSON.stringify(base));
      mut(p);
      A.setGrade(p, { replace: true, full: true });
      await A.flushRender(); await sleep(250);
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender(); await sleep(800);
      const cv = im._grade && im._grade.canvas;
      if (!cv) return null;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
      return { w: cv.width, h: cv.height, data: Array.from(d.data) };
    };
    const r = {};
    r.preset = await run(() => {});
    r.off = await run((p) => { p.det = Object.assign({}, p.det, { shp: 0 }); });
    r.s20 = await run((p) => { p.det = Object.assign({}, p.det, { shp: 20 }); });
    r.s70 = await run((p) => { p.det = Object.assign({}, p.det, { shp: 70 }); });
    r.s100 = await run((p) => { p.det = Object.assign({}, p.det, { shp: 100 }); });
    return { shots: r, det: base.det };
   } catch (e) { return { error: String((e && e.stack) || e) }; }
  })()`);

  if (out.error) { console.log('渲染报错：', out.error); app.quit(); return; }
  console.log('det =', JSON.stringify(out.det), '\n');

  const toRGB = (s) => {
    const n = s.w * s.h, d = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) { d[i * 3] = s.data[i * 4]; d[i * 3 + 1] = s.data[i * 4 + 1]; d[i * 3 + 2] = s.data[i * 4 + 2]; }
    return { w: s.w, h: s.h, d };
  };
  const tgt = loadRGB(TARGET);
  console.log('              均值L   彩度C   白场%   近黑%   P99.9  高频(平地/边缘)     亮度分带 0-63/64-127/128-191/192-255');
  for (const [n, rgb] of [['目标(PS)', tgt], ['锐化关', toRGB(out.shots.off)], ['shp=20', toRGB(out.shots.s20)],
    ['shp=40(预设)', toRGB(out.shots.preset)], ['shp=70', toRGB(out.shots.s70)], ['shp=100', toRGB(out.shots.s100)]]) {
    const s = pixelStats(rgb), e = hf(rgb);
    console.log(n.padEnd(13), String(s.L).padStart(6), String(s.C).padStart(7), String(s.clip).padStart(7),
      String(s.blk).padStart(7), String(s.p999).padStart(6), '  ' + String(e.flat).padStart(6) + '/' + String(e.edge).padStart(6),
      '  ' + e.bands.join('/'));
  }
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
