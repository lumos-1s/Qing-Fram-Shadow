// 逐级追踪高光：同一个像素，在 色调表 → 点曲线 → 三维表(+通道平衡) → 最终画布
// 四步里的值各是多少、哪一步撞到 255。撞在哪一步，才知道该改哪一段。
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

// ── 先按 LR 的亮度挑样本点 ──────────────────────────────────
const LR = (() => {
  const j = jpeg.decode(fs.readFileSync('C:/Users/lumos/Desktop/未命名导出/tint=50.jpg'), { useTArray: true, maxMemoryUsageInMB: 4096 });
  return { w: j.width, h: j.height, d: j.data };
})();
const s2l = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const N = 320;
const pts = [];
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  const u = (i + 0.5) / N, v = (j + 0.5) / N;
  const x = Math.floor(u * LR.w), y = Math.floor(v * LR.h);
  let r = 0, g = 0, b = 0, n = 0;
  const rad = Math.max(1, Math.round(LR.w / 1740));
  for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
    const p = ((y + dy) * LR.w + (x + dx)) * 4;
    r += LR.d[p]; g += LR.d[p + 1]; b += LR.d[p + 2]; n++;
  }
  const Y = 0.2126 * s2l(r / n) + 0.7152 * s2l(g / n) + 0.0722 * s2l(b / n);
  pts.push({ u, v, Y, lr: [r / n, g / n, b / n] });
}
pts.sort((a, b) => b.Y - a.Y);
const TOP = pts.slice(0, Math.round(pts.length * 0.06));   // 最亮 6%

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
  });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 120; i++) {
    if (await w.webContents.executeJavaScript('!!(window.App && window.App.dom && window.AppXmp && window.QfsAcr)')) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const xmpText = fs.readFileSync(XMP, 'utf8');
  const coords = TOP.map((p) => [p.u, p.v]);
  const out = await w.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const A = window.App;
    A.saveCurrentTemplate = () => {};
    const raw = new Image();
    await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
    const im = { name: 'DSC09381', el: raw, w: raw.naturalWidth, h: raw.naturalHeight, exif: {} };
    A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    if (window.QfsAcr.ensure) await window.QfsAcr.ensure();
    if (window.QfsShadows.ensure) await window.QfsShadows.ensure();
    for (let i = 0; i < 80 && !window.QfsAcr.ready(); i++) await sleep(100);
    const p = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;
    A.setGrade(p, { replace: true, full: true });
    await A.flushRender(); await sleep(200);
    if (window.ensureFullGrade) window.ensureFullGrade(im);
    await A.flushRender(); await sleep(600);
    const cv = im._grade && im._grade.canvas;
    if (!cv) return { error: '画布没生成' };

    const bright = im._acrBright || window.QfsAcr.measureBrightness(raw);
    const F = window.QfsAcr.toneStages({
      exp: p.exp || 0, temp: p.temp || 0, tint: p.tint || 0,
      con: p.con || 0, hi: p.hi || 0, sh: p.sh || 0,
      white: p.white || 0, black: p.black || 0
    }, bright);
    const C = window.QfsCurve;
    const cl = (C && C.curveActive(p.curve)) ? C.buildCurveLuts(p.curve) : null;
    const lut = window.QfsAcr.colorLut(p, 33, bright);

    // 源图（与渲染同尺寸）
    const sc = document.createElement('canvas');
    sc.width = cv.width; sc.height = cv.height;
    const scg = sc.getContext('2d', { willReadFrequently: true });
    scg.drawImage(raw, 0, 0, cv.width, cv.height);
    const S = scg.getImageData(0, 0, cv.width, cv.height).data;
    const O = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const W = cv.width, H = cv.height;

    // 三维表三线性取样（与 sampleTable 同一布局）
    const G = lut.grid, SG = G - 1, AT = lut.rgba;
    const sample3 = (r, g, b) => {
      const x = Math.min(SG, Math.max(0, r) * SG / 255), y = Math.min(SG, Math.max(0, g) * SG / 255), z = Math.min(SG, Math.max(0, b) * SG / 255);
      const i0 = Math.min(SG - 1, Math.floor(x)), j0 = Math.min(SG - 1, Math.floor(y)), k0 = Math.min(SG - 1, Math.floor(z));
      const fx = x - i0, fy = y - j0, fz = z - k0;
      const at = (ri, gi, bi) => ((gi * G + bi) * G + ri) * 4;
      const o = [0, 0, 0];
      for (let ch = 0; ch < 3; ch++) {
        const c00 = AT[at(i0, j0, k0) + ch] * (1 - fx) + AT[at(i0 + 1, j0, k0) + ch] * fx;
        const c10 = AT[at(i0, j0 + 1, k0) + ch] * (1 - fx) + AT[at(i0 + 1, j0 + 1, k0) + ch] * fx;
        const c01 = AT[at(i0, j0, k0 + 1) + ch] * (1 - fx) + AT[at(i0 + 1, j0, k0 + 1) + ch] * fx;
        const c11 = AT[at(i0, j0 + 1, k0 + 1) + ch] * (1 - fx) + AT[at(i0 + 1, j0 + 1, k0 + 1) + ch] * fx;
        const c0 = c00 * (1 - fy) + c10 * fy, c1 = c01 * (1 - fy) + c11 * fy;
        o[ch] = c0 * (1 - fz) + c1 * fz;
      }
      return o;
    };
    const tbl = (arr, v) => {
      const x = Math.min(255, Math.max(0, v));
      const i0 = Math.min(254, Math.floor(x)), f = x - i0;
      return (arr[i0] * (1 - f) + arr[i0 + 1] * f) * 255;
    };
    const rows = [];
    for (const uv of ${JSON.stringify(coords)}) {
      const x = Math.min(W - 1, Math.floor(uv[0] * W)), y = Math.min(H - 1, Math.floor(uv[1] * H));
      const q = (y * W + x) * 4;
      const src = [S[q], S[q + 1], S[q + 2]];
      const t1 = [tbl(F.r, src[0]), tbl(F.g, src[1]), tbl(F.b, src[2])];
      const t2 = cl ? [C.sampleLut(cl.r, t1[0] / 255) * 255, C.sampleLut(cl.g, t1[1] / 255) * 255, C.sampleLut(cl.b, t1[2] / 255) * 255] : t1;
      const t3 = sample3(t2[0], t2[1], t2[2]);
      rows.push({ uv, src, t1, t2, t3, fin: [O[q], O[q + 1], O[q + 2]] });
    }
    let mr=0,mg=0,mb=0; for(let i=0;i<O.length;i+=4*37){mr+=O[i];mg+=O[i+1];mb+=O[i+2];} const cnt=Math.ceil(O.length/(4*37));
    let sr2=0,sg2=0,sb2=0; for(let i=0;i<S.length;i+=4*37){sr2+=S[i];sg2+=S[i+1];sb2+=S[i+2];}
    return { rows, patch: p, bright, dims:[W,H,raw.naturalWidth,raw.naturalHeight], meanO:[mr/cnt,mg/cnt,mb/cnt], meanS:[sr2/cnt,sg2/cnt,sb2/cnt] };
  })()`);

  if (out.error) { console.log('渲染报错：', out.error); app.quit(); return; }

  const mean = (arr, k, c) => arr.reduce((s, r) => s + (c == null ? r[k] : r[k][c]), 0) / arr.length;
  const clip = (arr, k) => {
    let one = 0, three = 0;
    for (const r of arr) {
      const n = r[k].filter((v) => v >= 254.5).length;
      if (n >= 1) one++;
      if (n === 3) three++;
    }
    return [(one / arr.length * 100).toFixed(0) + '%', (three / arr.length * 100).toFixed(0) + '%'];
  };
  const line = (nm, arr, k) => console.log('  ' + nm.padEnd(10) +
    ' R ' + mean(arr, k, 0).toFixed(1).padStart(6) + ' G ' + mean(arr, k, 1).toFixed(1).padStart(6) +
    ' B ' + mean(arr, k, 2).toFixed(1).padStart(6) +
    '   撞顶(≥1通道) ' + clip(arr, k)[0].padStart(4) + '  三通道全撞 ' + clip(arr, k)[1]);

  console.log('尺寸/均值', JSON.stringify(out.dims), '画布均值', out.meanO.map(v=>v.toFixed(1)).join(','), '源均值', out.meanS.map(v=>v.toFixed(1)).join(','));
  console.log('最亮 6%（按 LR 亮度）' + TOP.length + ' 个点，逐级均值');
  line('① 源图', out.rows, 'src');
  line('② 色调表', out.rows, 't1');
  line('③ 点曲线', out.rows, 't2');
  line('④ 三维+平衡', out.rows, 't3');
  line('⑤ 画布实际', out.rows, 'fin');
  const lrMean = [0, 1, 2].map((c) => TOP.reduce((s, p) => s + p.lr[c], 0) / TOP.length);
  console.log('  ' + 'LR 导出'.padEnd(10) + ' R ' + lrMean[0].toFixed(1).padStart(6) + ' G ' + lrMean[1].toFixed(1).padStart(6) + ' B ' + lrMean[2].toFixed(1).padStart(6));

  console.log('\n按亮度排名抽样看链条（源 → 色调 → 曲线 → 三维 → 画布 | LR）');
  for (const q of [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 0.97]) {
    const i = Math.min(out.rows.length - 1, Math.round(q * out.rows.length));
    const r = out.rows[i], lr = TOP[i].lr;
    const f = (a) => a.map((v) => Math.round(v)).join(',');
    const ly = 0.2126 * r.t2[0] + 0.7152 * r.t2[1] + 0.0722 * r.t2[2];
    const lz = 0.2126 * r.t3[0] + 0.7152 * r.t3[1] + 0.0722 * r.t3[2];
    console.log('  ' + String(Math.round(q * 100) + '%').padStart(4) + '  ' +
      f(r.src).padEnd(13) + '→ ' + f(r.t1).padEnd(13) + '→ ' + f(r.t2).padEnd(13) + '→ ' + f(r.t3).padEnd(13) + '→ ' + f(r.fin).padEnd(13) +
      '| 加性抬升 ly−lz ' + (ly - lz).toFixed(1).padStart(5) + ' | LR ' + f(lr));
  }
  app.quit();
});
