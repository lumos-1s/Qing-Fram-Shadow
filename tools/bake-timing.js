// 整条烘焙链的耗时：一次「松手」到底卡多久。
//
// 分两档量：
//   low  —— 拖动中的 1600px 过渡帧（每次 input 都跑）
//   full —— 松手后补的全分辨率（23MP）
// 每档给「冷」（新参数，缓存全失效）和「暖」（同参数重跑，走层缓存）两个数。
//
// 用法：node tools/run-electron.js tools/bake-timing.js [xmp路径]
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.env.QF_IMG || 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const XMP = process.argv[3] || 'D:/预设/001-滨田英明调色 [霜绝预设].xmp';
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

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
  });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 120; i++) {
    if (await w.webContents.executeJavaScript('!!(window.App && window.AppXmp && window.QfsAcr)')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const xmpText = fs.readFileSync(XMP, 'utf8');
  const out = await w.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const A = window.App;
    A.saveCurrentTemplate = () => {};
    const raw = new Image();
    await new Promise((r, j) => { raw.onload = r; raw.onerror = j; raw.src = ${JSON.stringify(dataUrl(SRC))}; });
    const im = { name: 'bench', el: raw, w: raw.naturalWidth, h: raw.naturalHeight, exif: {} };
    A.images = [im]; A.currentIdx = 0; A.image = im; A.imageTemplates = new Map();
    A.template = A.defaultTemplate();
    if (window.QfsAcr.ensure) await window.QfsAcr.ensure();
    if (window.QfsShadows.ensure) await window.QfsShadows.ensure();
    for (let i = 0; i < 80 && !window.QfsAcr.ready(); i++) await sleep(100);

    const p = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;
    const res = { gl: !!(window.QfsColor && window.QfsColor.canShadow()),
      src: raw.naturalWidth + 'x' + raw.naturalHeight,
      det: { shp: p.det && p.det.shp, shr: p.det && p.det.shr }, sh: p.sh };

    const time = (fn) => { const t = performance.now(); fn(); return +(performance.now() - t).toFixed(1); };

    // 把三个重量级调用包起来，拆出「这一帧的时间花在谁身上」
    const acc = { prepare: 0, shadowCpu: 0, sharpen: 0, pass: 0, lut: 0 };
    const wrap = (obj, name, slot) => {
      if (!obj || typeof obj[name] !== 'function') return;
      const orig = obj[name];
      obj[name] = function () {
        const t = performance.now();
        const r = orig.apply(this, arguments);
        acc[slot] += performance.now() - t;
        return r;
      };
    };
    wrap(window.QfsShadows, 'prepare', 'prepare');
    wrap(window.QfsShadows, 'applyCanvas', 'shadowCpu');
    wrap(window.QfsSharpen, 'applyCanvas', 'sharpen');
    wrap(window.QfsColor, 'pass', 'pass');
    const reset = () => { for (const k of Object.keys(acc)) acc[k] = 0; };
    const dump = () => { const o = {}; for (const k of Object.keys(acc)) o[k] = +acc[k].toFixed(1); return o; };

    // low：拖动中的过渡帧
    A.setGrade(p, { replace: true });
    await sleep(30);
    res.lowWarm = time(() => A.rebuildGrade('low'));
    // 真正的冷：连层缓存一起作废（换图 / 改色调后的第一帧）
    im._gradeCache = null; im._grade.lowKey = '';
    res.lowCold = time(() => A.rebuildGrade('low'));
    // 再拆一层：场计算 vs 其余（同一帧里场是唯一可能上百毫秒的 CPU 段）
    const lowCv = im._grade.low;
    if (lowCv && window.QfsShadows) {
      const fk = 'bench-field';
      res.fieldCold = time(() => window.QfsShadows.prepare(lowCv, Number(p.sh) || 0, fk, false));
      res.fieldWarm = time(() => window.QfsShadows.prepare(lowCv, Number(p.sh) || 0, fk, false));
    }
    // 真实拖动：改一个「会同时改色调与阴影场」的档位（曝光），量一帧的完整代价
    res.lowMoved = time(() => A.setGrade(Object.assign({}, p, { exp: (Number(p.exp) || 0) + 0.04 })));
    // 只改颜色类参数（饱和度进三维表，阴影场不受影响）——这是调色时最常见的那类拖动
    res.lowColorDrag = time(() => A.setGrade(Object.assign({}, p, { sat: (Number(p.sat) || 0) + 4 })));

    // full：松手后补的全分辨率
    A.setGrade(p, { replace: true, full: true });
    await sleep(50);
    reset();
    res.fullCold = time(() => { im._grade.canvas = null; im._grade.fullKey = ''; A.rebuildGrade('full'); });
    res.fullBreak = dump();
    reset();
    res.fullMoved = time(() => A.setGrade(Object.assign({}, p, { exp: (Number(p.exp) || 0) + 0.06 }), { full: true }));
    res.fullMovedBreak = dump();
    res.fullWarm = time(() => A.rebuildGrade('full'));
    return res;
  })()`);
  console.log(JSON.stringify(out, null, 2));
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
