// 中性轴探针：给渲染链喂一张纯灰阶梯 + 几条纯色，把「输入→输出」的每通道关系打出来。
// 这是判断「整体偏品红」最快的一刀 —— 灰阶如果在某一段被抬了 R、压了 G，就是链路问题，
// 跟色相选择性无关。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const XMP = 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
const ACR = path.join(ROOT, 'shared', 'acr', 'cr-tables.bin');
const SHD = path.join(ROOT, 'shared', 'acr', 'cr-shadows.bin');

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

// 灰阶 + 纯色，都是「原图直接喂进去」的合成像素
const RAMP = [8, 24, 40, 56, 72, 88, 104, 120, 136, 152, 168, 184, 200, 216, 232, 248];
const HUES = [
  ['红', 200, 60, 50], ['橙', 220, 150, 60], ['黄', 210, 190, 70],
  ['绿', 110, 170, 90], ['青', 80, 170, 170], ['蓝', 70, 110, 190],
  ['肤', 210, 170, 145], ['褐', 120, 85, 60],
];

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
    const RAMP = ${JSON.stringify(RAMP)}, HUES = ${JSON.stringify(HUES)};
    const n = RAMP.length + HUES.length;
    const sc = document.createElement('canvas'); sc.width = n * 8; sc.height = 8;
    const g2 = sc.getContext('2d');
    for (let i = 0; i < RAMP.length; i++) { g2.fillStyle = 'rgb(' + [RAMP[i], RAMP[i], RAMP[i]].join(',') + ')'; g2.fillRect(i*8, 0, 8, 8); }
    for (let j = 0; j < HUES.length; j++) {
      const c = HUES[j]; g2.fillStyle = 'rgb(' + [c[1], c[2], c[3]].join(',') + ')';
      g2.fillRect((RAMP.length + j) * 8, 0, 8, 8);
    }
    const src = new Image();
    await new Promise((r, j) => { src.onload = r; src.onerror = j; src.src = sc.toDataURL('image/png'); });
    const im = { name: 'swatch', el: src, w: src.naturalWidth, h: src.naturalHeight, exif: {} };
    A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    A.updateEmptyState(); A.refreshUI(); A._forceFitNext = true;
    if (window.QfsAcr.ensure) await window.QfsAcr.ensure();
    if (window.QfsShadows.ensure) await window.QfsShadows.ensure();
    await A.flushRender(); await sleep(300);
    const base = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;
    const grab = async (mut) => {
      const p = JSON.parse(JSON.stringify(base));
      if (mut) mut(p);
      A.setGrade(p, { replace: true, full: true });
      await A.flushRender(); await sleep(200);
      if (window.ensureFullGrade) window.ensureFullGrade(im);
      await A.flushRender(); await sleep(500);
      const cv = im._grade && im._grade.canvas;
      if (!cv) return null;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const out = [];
      const sy = Math.floor(cv.height / 2);
      for (let i = 0; i < n; i++) {
        const x = Math.floor((i + 0.5) * cv.width / n);
        const p2 = (sy * cv.width + x) * 4;
        out.push([d[p2], d[p2 + 1], d[p2 + 2]]);
      }
      return out;
    };
    const res = {};
    res.full = await grab(null);
    res.noCal = await grab((p) => { p.cal = null; });
    res.noMix = await grab((p) => { p.mix = null; });
    res.noHi = await grab((p) => { p.hi = 0; });
    res.noCg = await grab((p) => { p.cg = null; });
    res.noCurve = await grab((p) => { p.curve = null; });
    res.noTint = await grab((p) => { p.tint = 0; });
    res.raw = await grab((p) => { p.cal = null; p.mix = null; p.cg = null; p.curve = null;
      p.hi = 0; p.sh = 0; p.white = 0; p.black = 0; p.con = 0; p.exp = 0; p.sat = 0; p.vib = 0; });
    return { res, base: { exp: base.exp, con: base.con, hi: base.hi, sh: base.sh,
      white: base.white, black: base.black, sat: base.sat, vib: base.vib, temp: base.temp, tint: base.tint } };
   } catch (e) { return { error: String((e && e.stack) || e) }; }
  })()`);

  if (out.error) { console.log('报错：', out.error); app.quit(); return; }
  console.log('参数：', JSON.stringify(out.base));

  console.log('\n【灰阶】输入 → 输出（R/G/B），Δ 相对输入');
  console.log('  in    完整链              noCal              noMix            仅WB+曲线(noCal/Mix/Cg/Curve)');
  for (let i = 0; i < RAMP.length; i++) {
    const v = RAMP[i];
    const fm = (a) => (a ? a.map((x) => String(x).padStart(3)).join(' ') : '  -  ');
    const n1 = (a) => (a ? a.map((x) => (x - v >= 0 ? '+' : '') + (x - v)).join(',').padStart(13) : '');
    console.log('  ' + String(v).padStart(3) + '  ' + fm(out.res.full[i]) + '  ' + n1(out.res.full[i]) +
      '  ' + fm(out.res.noCal[i]) + '  ' + fm(out.res.noMix[i]) + '   ' + fm(out.res.raw[i]) + '  ' + n1(out.res.raw[i]));
  }

  const lab = (r, g, b) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const R = f(r), G = f(g), B2 = f(b);
    let X = (0.4124 * R + 0.3576 * G + 0.1805 * B2) / 0.95047;
    const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B2;
    let Z = (0.0193 * R + 0.1192 * G + 0.9505 * B2) / 1.08883;
    const t = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
    X = t(X); Z = t(Z); const Y2 = t(Y);
    return [116 * Y2 - 16, 500 * (X - Y2), 200 * (Y2 - Z)];
  };
  console.log('\n【灰阶的 a*/b*】理想应恒为 0');
  console.log('  in   a*     b*      （完整链）');
  for (let i = 0; i < RAMP.length; i += 2) {
    const t = lab.apply(null, out.res.full[i]);
    console.log('  ' + String(RAMP[i]).padStart(3) + ' ' + t[1].toFixed(1).padStart(6) + ' ' + t[2].toFixed(1).padStart(6));
  }

  console.log('\n【纯色】输入 → 完整链 → ΔLab');
  console.log('  色    输入          输出          ΔL     Δa     Δb');
  for (let j = 0; j < HUES.length; j++) {
    const c = HUES[j], i = RAMP.length + j;
    const t0 = lab(c[1], c[2], c[3]), t1 = lab.apply(null, out.res.full[i]);
    console.log('  ' + c[0] + '  ' + [c[1], c[2], c[3]].map((x) => String(x).padStart(3)).join(',') +
      '  → ' + out.res.full[i].map((x) => String(x).padStart(3)).join(',') +
      '  ' + (t1[0] - t0[0]).toFixed(1).padStart(6) + (t1[1] - t0[1]).toFixed(1).padStart(7) + (t1[2] - t0[2]).toFixed(1).padStart(7));
  }
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
