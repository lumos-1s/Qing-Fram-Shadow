// 自适应键的敏感度：con/hi 换档到底会不会改变灰轴对角线（若不敏感，
// 「键算偏了」就不是残差的原因；若敏感，说明烘焙被缓存住了）。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const ACR = path.join(ROOT, 'shared', 'acr', 'cr-tables.bin');

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
    show: false, width: 600, height: 400,
    webPreferences: { preload: path.join(ROOT, 'tools', 'preload-measure.js'), contextIsolation: true, sandbox: false },
  });
  await w.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  for (let i = 0; i < 60; i++) {
    if (await w.webContents.executeJavaScript('!!window.QfsAcr')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const out = await w.webContents.executeJavaScript(`(async () => {
    await window.QfsAcr.ensure();
    const p = { exp: 0.56, temp: 30, tint: 0, con: 20, hi: -100, white: 23, black: 26 };
    const rows = [];
    for (const con of [53, 80, 104, 130, 160, 190, 224]) {
      for (const hi of [53, 104, 160, 224]) {
        const F = window.QfsAcr.toneStages(p, { con, hi });
        rows.push([con, hi, Math.round(F.r[32] * 255), Math.round(F.r[64] * 255),
          Math.round(F.r[128] * 255), Math.round(F.r[192] * 255), Math.round(F.r[240] * 255)]);
      }
    }
    return rows;
  })()`);
  console.log('con  hi |  v=32  64  128  192  240');
  out.forEach((r) => console.log(String(r[0]).padStart(3), String(r[1]).padStart(3), '|',
    r.slice(2).map((x) => String(x).padStart(4)).join(' ')));
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
