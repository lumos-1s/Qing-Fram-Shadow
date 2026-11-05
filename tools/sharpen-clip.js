// 锐化对「白场裁切 / 彩度」的贡献：同一套参数，只切锐化开关。
// 之前标定只看高频能量，能量对上不等于没有副作用——把亮部推过 255 就会掉色。
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
    const TW = 1732, TH = Math.round(TW * raw.height / raw.width);
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
      return { w: cv.width, h: cv.height, data: Array.from(d.data), url: cv.toDataURL('image/jpeg', 0.95) };
    };
    const r = {};
    r.preset = await run(() => {});
    r.nosharp = await run((p) => { p.det = Object.assign({}, p.det, { shp: 0 }); });
    r.nosharp_shm0 = await run((p) => { p.det = Object.assign({}, p.det, { shp: 40, shm: 0 }); });
    return { shots: r, det: base.det };
   } catch (e) { return { error: String((e && e.stack) || e) }; }
  })()`);

  if (out.error) { console.log('渲染报错：', out.error); app.quit(); return; }
  console.log('XMP 映射 det =', JSON.stringify(out.det));

  const load = (f) => {
    const img = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
    const TW = 1732, TH = Math.round(TW * img.height / img.width);
    const d = new Uint8Array(TW * TH * 4);
    for (let y = 0; y < TH; y++) {
      const sy = Math.floor(y * img.height / TH);
      for (let x = 0; x < TW; x++) {
        const sx = Math.floor(x * img.width / TW);
        const s = (sy * img.width + sx) * 4, o = (y * TW + x) * 4;
        d[o] = img.data[s]; d[o + 1] = img.data[s + 1]; d[o + 2] = img.data[s + 2]; d[o + 3] = 255;
      }
    }
    return { w: TW, h: TH, data: d };
  };

  const stat = (s) => {
    const n = s.data.length / 4;
    let L = 0, C = 0, clip = 0, blk = 0, sat = 0;
    for (let i = 0; i < s.data.length; i += 4) {
      const r = s.data[i], g = s.data[i + 1], b = s.data[i + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      L += l;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      C += mx - mn;
      if (mx >= 254) clip++;
      if (l < 24) blk++;
      if (mx - mn > 40) sat++;
    }
    return { L: +(L / n).toFixed(1), C: +(C / n).toFixed(1), clip: +(100 * clip / n).toFixed(2), blk: +(100 * blk / n).toFixed(2), vivid: +(100 * sat / n).toFixed(1) };
  };
  const tgt = load(TARGET);
  console.log('\n              均值L   彩度C   白场%   近黑%   高饱和%');
  const rows = [['目标(PS)', stat(tgt)]];
  for (const [n, s] of [['预设(带锐化)', out.shots.preset], ['关锐化', out.shots.nosharp], ['锐化/蒙版0', out.shots.nosharp_shm0]]) {
    rows.push([n, stat(s)]);
  }
  for (const [n, s] of rows) {
    console.log(n.padEnd(13), String(s.L).padStart(6), String(s.C).padStart(7), String(s.clip).padStart(7), String(s.blk).padStart(7), String(s.vivid).padStart(8));
  }
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
