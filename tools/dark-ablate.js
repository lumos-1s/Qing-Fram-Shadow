// 暗部偏暗的定位：逐个关掉可能压低暗端的环节，看树荫区的 L 回升多少。
// 参照：同区域 LR tint=50 是 87.1 / 125.7 / 84.8，目标成片 86.6 / 123.7 / 85.1。
// 我们目前是 83.1 / 122.6 / 81.7 —— 差 3~4 级，而且暗像素占比多 6 个百分点。
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
const ZONES = [['左树荫', 0.05, 0.62, 0.35, 0.88], ['路面树影', 0.30, 0.62, 0.62, 0.86], ['右车棚', 0.72, 0.66, 0.98, 0.92]];
function zoneStats(rgb, z) {
  const [x0, y0, x1, y1] = [z[1] * rgb.w, z[2] * rgb.h, z[3] * rgb.w, z[4] * rgb.h].map(Math.round);
  let l = 0, n = 0, lo = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * rgb.w + x) * 3;
    const v = 0.2126 * rgb.d[i] + 0.7152 * rgb.d[i + 1] + 0.0722 * rgb.d[i + 2];
    l += v; n++; if (v < 64) lo++;
  }
  return { L: +(l / n).toFixed(1), dark: +(100 * lo / n).toFixed(1) };
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
    const raw0 = { exp: base.exp, con: base.con, hi: base.hi, sh: base.sh,
      white: base.white, black: base.black, curve: !!base.curve };
    const run = async (mut) => {
      const p = JSON.parse(JSON.stringify(base));
      mut(p);
      A.setGrade(p, { replace: true, full: true });
      await A.flushRender(); await sleep(220);
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender(); await sleep(700);
      const cv = im._grade && im._grade.canvas;
      if (!cv) return null;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
      const arr = new Uint8Array(cv.width * cv.height * 3);
      for (let i = 0, p2 = 0; i < d.data.length; i += 4, p2 += 3) {
        arr[p2] = d.data[i]; arr[p2 + 1] = d.data[i + 1]; arr[p2 + 2] = d.data[i + 2];
      }
      return { w: cv.width, h: cv.height, d: Array.from(arr) };
    };
    const r = {};
    r.full = await run(() => {});
    r.noSh = await run((p) => { p.sh = 0; });
    r.noBlack = await run((p) => { p.black = 0; });
    r.noWhite = await run((p) => { p.white = 0; });
    r.noCurve = await run((p) => { p.curve = null; });
    r.noCon = await run((p) => { p.con = 0; });
    r.noHi = await run((p) => { p.hi = 0; });
    r.sh21 = await run((p) => { p.sh = -21; });
    r.sh15 = await run((p) => { p.sh = -15; });
    return { shots: r, base: raw0 };
   } catch (e) { return { error: String((e && e.stack) || e) }; }
  })()`);

  if (out.error) { console.log('渲染报错：', out.error); app.quit(); return; }
  console.log('参数', JSON.stringify(out.base), '\n');
  const toRGB = (s) => ({ w: s.w, h: s.h, d: Uint8Array.from(s.d) });
  console.log('变体            左树荫L  路面L  右车棚L   整图暗像素%');
  for (const k of ['full', 'noSh', 'noBlack', 'noWhite', 'noCurve', 'noCon', 'noHi', 'sh21', 'sh15']) {
    const rgb = toRGB(out.shots[k]);
    const zs = ZONES.map((z) => zoneStats(rgb, z));
    let lo = 0, n = 0;
    for (let i = 0; i < rgb.d.length; i += 3) {
      const v = 0.2126 * rgb.d[i] + 0.7152 * rgb.d[i + 1] + 0.0722 * rgb.d[i + 2];
      if (v < 64) lo++; n++;
    }
    console.log(k.padEnd(15), zs.map((z) => String(z.L).padStart(6)).join(' '), '   ', (100 * lo / n).toFixed(2));
  }
  console.log('\n参照 LR50      87.1  125.7  84.8    9.3');
  console.log('参照 目标      86.6  123.7  85.1   11.5（目标暗像素口径按同区域统计）');
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
