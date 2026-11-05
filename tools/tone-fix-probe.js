// 诊断三维修正的「反解」在暗部是否稳定：打印对角线、曲线、反解的取值
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

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 900, height: 700,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
  });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 120; i++) {
    if (await w.webContents.executeJavaScript('!!(window.QfsAcr && window.QfsCurve && window.AppXmp)')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const xmpText = fs.readFileSync(XMP, 'utf8');
  const out = await w.webContents.executeJavaScript(`(async () => {
    await window.QfsAcr.ensure();
    const base = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;
    base.tint = 0;
    const F = window.QfsAcr.toneStages({
      exp: base.exp, temp: base.temp, tint: base.tint, con: base.con, hi: base.hi,
      white: base.white, black: base.black
    }, { con: 128, hi: 222 });
    const cl = window.QfsCurve.curveActive(base.curve) ? window.QfsCurve.buildCurveLuts(base.curve) : null;
    const rows = [];
    for (let v = 0; v <= 60; v += 2) {
      const y = F.r[v];
      const z = cl && cl.r ? cl.r[Math.min(255, Math.round(y * 255))] : y;
      rows.push([v, +(y * 255).toFixed(1), +(z * 255).toFixed(1)]);
    }
    // 反解：给定 z，找回 v
    const INV = 1017;
    const inv = new Float32Array(INV);
    let j = 0;
    for (let i = 0; i < INV; i++) {
      const t = i / (INV - 1);
      while (j < 254 && (cl && cl.r ? cl.r[Math.round(F.r[j + 1] * 255)] : F.r[j + 1]) < t) j++;
      const a = cl && cl.r ? cl.r[Math.round(F.r[j] * 255)] : F.r[j];
      const b2 = cl && cl.r ? cl.r[Math.round(F.r[j + 1] * 255)] : F.r[j + 1];
      const f = b2 > a ? (t - a) / (b2 - a) : 0;
      inv[i] = Math.max(0, Math.min(1, (j + f) / 255));
    }
    const invAt = (y8) => inv[Math.min(INV - 1, Math.max(0, Math.round(y8 / 255 * (INV - 1))))] * 255;
    const invRows = rows.map(([v, y, z]) => [v, z, +invAt(z).toFixed(1)]);
    return { rows, invRows, curve: !!cl, curveVals: cl && cl.r ? [0,1,2,4,8,16,32,64,128,255].map((i) => +(cl.r[i]*255).toFixed(1)) : null };
  })()`);
  console.log('curve active:', out.curve, 'curve@[0,1,2,4,8,16,32,64,128,255]:', out.curveVals);
  console.log('\nv(输入)  对角线(y)  曲线后(z)      z   反解回 x    误差');
  out.rows.forEach((r, i) => {
    const iv = out.invRows[i];
    console.log(String(r[0]).padStart(5), String(r[1]).padStart(11), String(r[2]).padStart(11),
      String(iv[1]).padStart(6), String(iv[2]).padStart(10), String((iv[2] - r[0]).toFixed(1)).padStart(8));
  });
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
