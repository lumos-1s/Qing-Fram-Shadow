// 只含色调参数时，三维 LUT 的灰轴响应应当等于 CSS 滤镜的对角线（否则修正表算错了）
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
    if (await w.webContents.executeJavaScript('!!(window.QfsAcr && window.AppXmp)')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const xmpText = fs.readFileSync(XMP, 'utf8');
  const out = await w.webContents.executeJavaScript(`(async () => {
    await window.QfsAcr.ensure();
    const base = window.AppXmp.mapXmp(${JSON.stringify(xmpText)}).patch;
    base.tint = 0;
    const tone = { exp: base.exp, temp: base.temp, tint: base.tint, con: base.con, hi: base.hi,
      white: base.white, black: base.black };
    const br = { con: 150, hi: 241 };
    const F = window.QfsAcr.toneStages(tone, br);
    const G = 33, A = (lut) => {
      // 纹理布局：x = 蓝*grid + 红，y = 绿；取灰轴
      const at = (v) => {
        const x = v * (G - 1) / 255;
        const i = Math.min(G - 1, Math.max(0, Math.round(x)));
        return ((i * G + i) * G + i) * 4;
      };
      return null;
    };
    const lut = window.QfsAcr.colorLut(tone, G, br);
    // 手动三线性采样（灰轴）
    const sample = (r, g, b) => {
      const S = G - 1, arr = lut.rgba;
      const x = Math.min(S, r * S / 255), y = Math.min(S, g * S / 255), z = Math.min(S, b * S / 255);
      const i0 = Math.min(S - 1, Math.floor(x)), j0 = Math.min(S - 1, Math.floor(y)), k0 = Math.min(S - 1, Math.floor(z));
      const fx = x - i0, fy = y - j0, fz = z - k0;
      const at2 = (ri, gi, bi) => ((gi * G + bi) * G + ri) * 4;
      const o = [];
      for (let ch = 0; ch < 3; ch++) {
        const c00 = arr[at2(i0, j0, k0) + ch] * (1 - fx) + arr[at2(i0 + 1, j0, k0) + ch] * fx;
        const c10 = arr[at2(i0, j0 + 1, k0) + ch] * (1 - fx) + arr[at2(i0 + 1, j0 + 1, k0) + ch] * fx;
        const c01 = arr[at2(i0, j0, k0 + 1) + ch] * (1 - fx) + arr[at2(i0 + 1, j0, k0 + 1) + ch] * fx;
        const c11 = arr[at2(i0, j0 + 1, k0 + 1) + ch] * (1 - fx) + arr[at2(i0 + 1, j0 + 1, k0 + 1) + ch] * fx;
        o.push((c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz);
      }
      return o;
    };
    const rows = [];
    for (let v = 0; v <= 255; v += 8) {
      const y = [F.r[v] * 255, F.g[v] * 255, F.b[v] * 255];
      const o = sample(y[0], y[1], y[2]);
      rows.push([v, Math.round(y[0]), Math.round(y[1]), Math.round(y[2]),
        Math.round(o[0]), Math.round(o[1]), Math.round(o[2])]);
    }
    // 彩色探针：暗部与黄叶
    const probes = [[40, 35, 30], [90, 110, 60], [200, 170, 70]].map((c) => {
      const o = sample(c[0], c[1], c[2]);
      return c.concat(o.map((x) => Math.round(x)));
    });
    return { rows, probes, hi: br.hi, hasLut: !!lut };
  })()`);
  console.log('LUT 存在', out.hasLut, 'hi 档', out.hi);
  console.log('v    滤镜后y(R G B)       LUT(y)  R  G  B   (应等于 y)');
  out.rows.forEach((r) => {
    console.log(String(r[0]).padStart(4), String(r[1]).padStart(9), String(r[2]).padStart(4), String(r[3]).padStart(4),
      '   ', String(r[4]).padStart(8), String(r[5]).padStart(4), String(r[6]).padStart(4));
  });
  console.log('\n彩色输入 → 三维LUT输出');
  out.probes.forEach((p) => console.log(JSON.stringify(p)));
  app.quit();
}).catch((e) => { console.error('FAIL', e); app.quit(); });
