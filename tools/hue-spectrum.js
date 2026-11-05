// 色相扇区彩度谱：每 30° 一个扇区，统计 C* 均值与占比。
// 用来判断「黄叶不够黄」到底是全局饱和度问题，还是按色相的错误分配。
const jpeg = require('jpeg-js');
const fs = require('fs');
const path = require('path');

const load = (f) => {
  const j = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
  return { w: j.width, h: j.height, d: j.data };
};
const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
function lab(r, g, b) {
  const R = f(r), G = f(g), B2 = f(b);
  let X = (0.4124 * R + 0.3576 * G + 0.1805 * B2) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B2;
  let Z = (0.0193 * R + 0.1192 * G + 0.9505 * B2) / 1.08883;
  const t = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  X = t(X); Z = t(Z); const Y2 = t(Y);
  return [116 * Y2 - 16, 500 * (X - Y2), 200 * (Y2 - Z)];
}

const SECTORS = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

function spec(fp, step = 2) {
  const im = load(fp);
  const acc = new Map();
  let n = 0;
  for (let y = 0; y < im.h; y += step) {
    for (let x = 0; x < im.w; x += step) {
      const p = (y * im.w + x) * 4;
      const t = lab(im.d[p], im.d[p + 1], im.d[p + 2]);
      const c = Math.hypot(t[1], t[2]);
      n++;
      if (t[0] < 18 || t[0] > 96 || c < 8) continue; // 只看有颜色的中间调
      let h = Math.atan2(t[2], t[1]) * 180 / Math.PI; if (h < 0) h += 360;
      const k = Math.floor(h / 30) * 30;
      const q = acc.get(k) || { c: 0, n: 0 };
      q.c += c; q.n++; acc.set(k, q);
    }
  }
  const out = { all: 0, n: 0 };
  let sc = 0, sn = 0;
  for (const k of SECTORS) {
    const q = acc.get(k);
    if (!q) { out[k] = null; continue; }
    out[k] = { c: q.c / q.n, share: q.n / n };
    sc += q.c; sn += q.n;
  }
  out.all = sn ? sc / sn : 0; out.n = sn / n;
  return out;
}

const files = [
  ['LR tint=0  ', 'C:/Users/lumos/Desktop/未命名导出/tint=0.jpg'],
  ['LR tint=50 ', 'C:/Users/lumos/Desktop/未命名导出/tint=50.jpg'],
  ['LR 截图    ', path.join(__dirname, 'out', 'shot_lr.jpg')],
  ['我们 tint38', path.join(__dirname, 'out', 't_ours.jpg')],
];

const specs = files.filter(([, fp]) => fs.existsSync(fp)).map(([n, fp]) => [n, spec(fp)]);
console.log('色相扇区彩度 C*（关键：黄 60-90 / 90-120 相对绿 120-150 的比例）\n');
console.log('图像         ' + SECTORS.map((k) => (k + '°').padStart(7)).join('') + '   加权');
for (const [n, s] of specs) {
  console.log(n + ' ' + SECTORS.map((k) => (s[k] ? s[k].c.toFixed(1) : '-').padStart(7)).join('') + '  ' + s.all.toFixed(1).padStart(5));
}
console.log('\n占比 %');
for (const [n, s] of specs) {
  console.log(n + ' ' + SECTORS.map((k) => (s[k] ? (100 * s[k].share).toFixed(1) : '-').padStart(7)).join(''));
}
console.log('\n黄/绿 彩度比（60-120° 对 120-180°）');
for (const [n, s] of specs) {
  const y = [s[60], s[90]].filter(Boolean);
  const g = [s[120], s[150]].filter(Boolean);
  const ym = y.reduce((a, b) => a + b.c, 0) / Math.max(1, y.length);
  const gm = g.reduce((a, b) => a + b.c, 0) / Math.max(1, g.length);
  console.log(' ' + n + '  黄 ' + ym.toFixed(1) + '  绿 ' + gm.toFixed(1) + '  比 ' + (ym / gm).toFixed(3));
}
