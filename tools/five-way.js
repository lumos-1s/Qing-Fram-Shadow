// 五方色彩统计：LR 截图 vs LR 自带导出的 tint 阶梯 vs 我们的渲染。
// 只比统计量（全图均值、按亮度的分带、黄带 a*/b*/L*），不需要几何对齐。
const jpeg = require('jpeg-js');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
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

const BANDS = [[0, 19], [19, 38], [38, 56], [56, 75], [75, 101]]; // L* 五带（等价 0..255 刻度）

function stat(im, step = 2) {
  const bands = BANDS.map(() => ({ n: 0, r: 0, g: 0, b: 0 }));
  let sr = 0, sg = 0, sb = 0, n = 0, sL = 0, sC = 0;
  let ya = 0, yb = 0, yL = 0, yn = 0, yC = 0;
  for (let y = 0; y < im.h; y += step) {
    for (let x = 0; x < im.w; x += step) {
      const p = (y * im.w + x) * 4;
      const R = im.d[p], G = im.d[p + 1], B = im.d[p + 2];
      const t = lab(R, G, B);
      sr += R; sg += G; sb += B; n++;
      sL += t[0]; const c = Math.hypot(t[1], t[2]); sC += c;
      const bi = BANDS.findIndex(([lo, hi]) => t[0] >= lo && t[0] < hi);
      if (bi >= 0) { const q = bands[bi]; q.n++; q.r += R; q.g += G; q.b += B; }
      if (t[0] > 20 && t[0] < 96 && c > 14) {
        let h = Math.atan2(t[2], t[1]) * 180 / Math.PI; if (h < 0) h += 360;
        if (h >= 65 && h < 105) { ya += t[1]; yb += t[2]; yL += t[0]; yC += c; yn++; }
      }
    }
  }
  return {
    rgb: [sr / n, sg / n, sb / n], L: sL / n, C: sC / n,
    y: { a: ya / yn, b: yb / yn, L: yL / yn, C: yC / yn, n: yn / n },
    bands: bands.map((q) => (q.n ? [q.r / q.n, q.g / q.n, q.b / q.n, q.n / n] : null)),
  };
}

const files = [
  ['LR截图   ', path.join(OUT, 'shot_lr.jpg')],
  ['lr tint=0', 'C:/Users/lumos/Desktop/未命名导出/tint=0.jpg'],
  ['lr tint=25', 'C:/Users/lumos/Desktop/未命名导出/tint=25.jpg'],
  ['lr tint=50', 'C:/Users/lumos/Desktop/未命名导出/tint=50.jpg'],
  ['lr tint=100', 'C:/Users/lumos/Desktop/未命名导出/tint=100.jpg'],
  ['我们 tint38', path.join(OUT, 't_ours.jpg')],
  ['我们 tint0', path.join(OUT, 't_ours_tint0.jpg')],
];

console.log('图像            全图RGB             L*     C*  |  黄带 a*   b*    L*   C*  占比');
for (const [name, fp] of files) {
  if (!fs.existsSync(fp)) { console.log(name.padEnd(12), '（缺）'); continue; }
  const s = stat(load(fp));
  console.log(name.padEnd(12),
    s.rgb.map((v) => v.toFixed(1).padStart(6)).join(' '),
    s.L.toFixed(1).padStart(6), s.C.toFixed(1).padStart(5),
    ' | ', s.y.a.toFixed(1).padStart(6), s.y.b.toFixed(1).padStart(6),
    s.y.L.toFixed(1).padStart(6), s.y.C.toFixed(1).padStart(5),
    (100 * s.y.n).toFixed(1).padStart(5) + '%');
}
