// 量 LR 三张 tint 对照图的 Lab 响应，拟合 tint → a*/b* 的真实斜率
const fs = require('fs');
const jpeg = require('jpeg-js');

const FILES = [
  ['tint=0', 'C:/Users/lumos/.workbuddy/clipboard-images/clipboard-2026-11-04T09-06-26-912Z-d6c9e40f.jpg'],
  ['tint=50', 'C:/Users/lumos/.workbuddy/clipboard-images/clipboard-2026-11-04T09-06-26-915Z-bedfecfa.jpg'],
  ['tint=100', 'C:/Users/lumos/.workbuddy/clipboard-images/clipboard-2026-11-04T09-06-26-909Z-e09d058e.jpg'],
];

const inv = (u) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));
function toLab(R, G, B) {
  const r = inv(R / 255), g = inv(G / 255), b = inv(B / 255);
  let X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  let Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  X = f(X); Y = f(Y); Z = f(Z);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

// 三张图尺寸一致才可比，先打印
const rows = [];
for (const [name, f] of FILES) {
  if (!fs.existsSync(f)) { console.log(name, '(缺失)'); continue; }
  const img = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
  const iw = img.width, ih = img.height, d = img.data;
  const W = 700, H = Math.round(700 * ih / iw);
  let L = 0, A = 0, B2 = 0, n = 0, sat = 0;
  // 分段：暗 / 中 / 亮，看 tint 在不同亮度下的贡献是否一致
  const seg = { dark: [0, 0, 0], mid: [0, 0, 0], bright: [0, 0, 0] };
  const segN = { dark: 0, mid: 0, bright: 0 };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (Math.floor(y * ih / H) * iw + Math.floor(x * iw / W)) * 4;
    const R = d[i], G = d[i + 1], Bl = d[i + 2];
    const v = toLab(R, G, Bl);
    L += v[0]; A += v[1]; B2 += v[2]; n++;
    const mx = Math.max(R, G, Bl), mn = Math.min(R, G, Bl);
    sat += mx ? (mx - mn) / mx : 0;
    const k = v[0] < 40 ? 'dark' : v[0] < 70 ? 'mid' : 'bright';
    seg[k][0] += v[1]; seg[k][1] += v[2]; seg[k][2] += v[0]; segN[k]++;
  }
  rows.push({ name, w: iw, h: ih, L: L / n, a: A / n, b: B2 / n, sat: 100 * sat / n, seg, segN });
}

console.log('图'.padEnd(10), '尺寸'.padEnd(12), '   L      a*      b*    饱和');
for (const r of rows) {
  console.log(r.name.padEnd(10), `${r.w}x${r.h}`.padEnd(12), r.L.toFixed(1).padStart(5), r.a.toFixed(1).padStart(7), r.b.toFixed(1).padStart(7), r.sat.toFixed(1).padStart(6));
}

if (rows.length === 3) {
  const [t0, t50, t100] = rows;
  console.log('\nLR 真实斜率：');
  console.log('  a*: 0→50  Δ', (t50.a - t0.a).toFixed(2), ' 0→100 Δ', (t100.a - t0.a).toFixed(2),
    ' 每 +1 tint 贡献 a*', ((t100.a - t0.a) / 100).toFixed(4));
  console.log('  b*: 0→50  Δ', (t50.b - t0.b).toFixed(2), ' 0→100 Δ', (t100.b - t0.b).toFixed(2),
    ' 每 +1 tint 贡献 b*', ((t100.b - t0.b) / 100).toFixed(4));
  console.log('  L : 0→100 Δ', (t100.L - t0.L).toFixed(2), ' 饱和 0→100 Δ', (t100.sat - t0.sat).toFixed(2));
  console.log('\n分段 a*（看 tint 是否只在某段起作用）：');
  for (const k of ['dark', 'mid', 'bright']) {
    const v = [t0, t50, t100].map((r) => (r.seg[k][0] / r.segN[k]).toFixed(2));
    console.log('  ' + k.padEnd(7), v.join('  →  '), '  n=' + t0.segN[k]);
  }
}
