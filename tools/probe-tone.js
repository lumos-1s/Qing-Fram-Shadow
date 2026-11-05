// 探针：实测色调表的真实响应 + 参数扫描，找出等价 LR 的高光/阴影档位
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const ACR = path.join(ROOT, 'shared', 'acr', 'cr-tables.bin');
const dataUrl = (p) => 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');

ipcMain.handle('load-acr-tables', () => {
  const raw = fs.readFileSync(ACR);
  const planes = zlib.inflateSync(raw.slice(10));
  return {
    size: raw.readUInt16LE(4), count: raw.readUInt16LE(6), step: raw.readUInt16LE(8),
    data: planes.buffer.slice(planes.byteOffset, planes.byteOffset + planes.byteLength),
  };
});
ipcMain.handle('get-prefs', () => ({}));

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
  });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 120; i++) {
    if (await w.webContents.executeJavaScript('!!(window.QfsAcr)')) break;
    await new Promise(r => setTimeout(r, 250));
  }

  const r = await w.webContents.executeJavaScript(`(async () => {
    if (window.QfsAcr.ensure) { try { await window.QfsAcr.ensure(); } catch (_) {} }
    const ready = window.QfsAcr.ready();
    const src = new Image();
    await new Promise((res, rej) => { src.onload = res; src.onerror = rej; src.src = ${JSON.stringify(dataUrl(SRC))}; });
    const bright = window.QfsAcr.measureBrightness(src);

    const P = { exp: 0.56, temp: -4, tint: 38, con: 20, hi: -100, sh: -30, white: 23, black: 26 };
    const pick = (t, xs) => xs.map((x) => Math.round(t[Math.min(255, Math.max(0, Math.round(x * 255)))] * 255));
    const probe = (p) => {
      const F = window.QfsAcr.toneStages(p, bright);
      if (!F) return { null: true };
      return { r: pick(F.r, [0.05, 0.25, 0.5, 0.75, 0.95]), g: pick(F.g, [0.05, 0.25, 0.5, 0.75, 0.95]), b: pick(F.b, [0.05, 0.25, 0.5, 0.75, 0.95]) };
    };
    const out = { ready, bright, full: probe(P), noHiSh: probe(Object.assign({}, P, { hi: 0, sh: 0 })) };
    // 只开高光 / 只开阴影，单独看影响
    out.onlyHi = probe(Object.assign({}, P, { exp: 0, temp: 0, tint: 0, con: 0, white: 0, black: 0, sh: 0 }));
    out.onlySh = probe(Object.assign({}, P, { exp: 0, temp: 0, tint: 0, con: 0, white: 0, black: 0, hi: 0 }));
    out.onlyCon = probe(Object.assign({}, P, { exp: 0, temp: 0, tint: 0, white: 0, black: 0, sh: 0, hi: 0 }));
    out.onlyWhite = probe(Object.assign({}, P, { exp: 0, temp: 0, tint: 0, con: 0, hi: 0, sh: 0, black: 0 }));
    out.onlyBlack = probe(Object.assign({}, P, { exp: 0, temp: 0, tint: 0, con: 0, hi: 0, sh: 0, white: 0 }));
    // 扫描：哪个高光档位能还原 LR 的亮部
    out.sweepHi = [-100, -50, 0, 50, 100].map((v) => ({ v, r: probe(Object.assign({}, P, { exp: 0, temp: 0, tint: 0, con: 0, white: 0, black: 0, sh: 0, hi: v })).r }));
    out.sweepSh = [-100, -50, 0, 50, 100].map((v) => ({ v, r: probe(Object.assign({}, P, { exp: 0, temp: 0, tint: 0, con: 0, white: 0, black: 0, hi: 0, sh: v })).r }));
    return out;
  })()`);

  const fmt = (o) => (o && o.r ? o.r.join('/') + '  G:' + o.g.join('/') + '  B:' + o.b.join('/') : JSON.stringify(o));
  console.log('ACR 就绪:', r.ready, ' 图像亮度测度:', JSON.stringify(r.bright));
  console.log('全参数色调链 →', fmt(r.full));
  console.log('去高光阴影   →', fmt(r.noHiSh));
  console.log('只高光 −100  →', fmt(r.onlyHi));
  console.log('只阴影 −30   →', fmt(r.onlySh));
  console.log('只对比 +20   →', fmt(r.onlyCon));
  console.log('只白点 +23   →', fmt(r.onlyWhite));
  console.log('只黑点 +26   →', fmt(r.onlyBlack));
  console.log('\n高光扫描（R 通道 5/25/50/75/95）:');
  for (const x of r.sweepHi) console.log('  hi=' + String(x.v).padStart(4), x.r.join('/'));
  console.log('阴影扫描:');
  for (const x of r.sweepSh) console.log('  sh=' + String(x.v).padStart(4), x.r.join('/'));
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
