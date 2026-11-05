// 把每个色调 stage 单独拿出来看：谁在高光端抬，谁在压。
// 单参数调用 toneStages 就只含那一个 stage（其余都是 0 时不会入链）。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
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

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 900, height: 600,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
  });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 120; i++) {
    if (await w.webContents.executeJavaScript('!!(window.QfsAcr)')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const BRIGHT = { con: 100, hi: 181, sh: 144 };
  const out = await w.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    if (window.QfsAcr.ensure) await window.QfsAcr.ensure();
    for (let i = 0; i < 80 && !window.QfsAcr.ready(); i++) await sleep(100);
    const idx = [128, 160, 180, 200, 210, 220, 228, 236, 244, 250, 255];
    const pick = (f) => idx.map((i) => Math.round(f[i] * 255));
    const one = (p) => {
      const s = window.QfsAcr.toneStages(p, ${JSON.stringify(BRIGHT)});
      if (!s) return { err: 'null', p: JSON.stringify(p) };
      if (!s.r || typeof s.r[0] !== 'number') return { err: 'shape', keys: Object.keys(s), len: s.r && s.r.length, sample: s.r && s.r[0] };
      return { r: pick(s.r), g: pick(s.g), b: pick(s.b) };
    };
    return {
      diag: (() => { const s = window.QfsAcr.toneStages({ exp: 0.56 }, ${JSON.stringify(BRIGHT)}); return { t: typeof s, keys: s && Object.keys(s), len: s && s.r && s.r.length, at128: s && s.r && s.r[128], at255: s && s.r && s.r[255] }; })(),
      exp: one({ exp: 0.56 }),
      con: one({ con: 20 }),
      hi: one({ hi: -100 }),
      white: one({ white: 23 }),
      black: one({ black: 26 }),
      all: one({ exp: 0.56, temp: -4, tint: 38, con: 20, hi: -100, white: 23, black: 26 }),
      idx,
    };
  })()`);

  console.log('诊断', JSON.stringify(out.diag));
  console.log('单独 stage 的对角线响应（输入 → 输出，取 R 通道；灰轴上三通道基本同步）');
  console.log('  in    ' + out.idx.map((v) => String(v).padStart(4)).join(''));
  for (const k of ['exp', 'con', 'hi', 'white', 'black', 'all']) {
    console.log('  ' + k.padEnd(6) + out[k].r.map((v) => String(v).padStart(4)).join(''));
  }
  app.quit();
});
