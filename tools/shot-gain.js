// 在对齐后的图像上做逐通道增益拟合：ours * g ≈ LR（线性光下）。
// 若单一增益三元组就能解释大部分残差，说明是白平衡/染色问题，而不是曲线形状问题。
const jpeg = require('jpeg-js');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const load = (f) => {
  const j = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
  return { w: j.width, h: j.height, d: j.data };
};
const A = load(path.join(OUT, 'shot_lr.jpg'));
const B = load(path.join(OUT, 'shot_ours.jpg'));
const W = A.w, H = A.h;

const s2l = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const l2s = (v) => { v = Math.max(0, Math.min(1, v)); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055); };

function fit(lo, hi) {
  const num = [0, 0, 0], den = [0, 0, 0];
  const ratios = [[], [], []];
  let n = 0;
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    const la = 0.2126 * A.d[p] + 0.7152 * A.d[p + 1] + 0.0722 * A.d[p + 2];
    if (la < lo || la > hi) continue;
    n++;
    for (let k = 0; k < 3; k++) {
      const a = s2l(A.d[p + k]), b = s2l(B.d[p + k]);
      num[k] += a * b; den[k] += b * b;
      if (b > 0.002 && a > 0.002) ratios[k].push(a / b);
    }
  }
  const gain = num.map((v, k) => v / den[k]);
  const med = ratios.map((r) => { r.sort((x, y) => x - y); return r[Math.floor(r.length / 2)]; });
  console.log('  L' + lo + '-' + hi, ('n=' + n).padStart(9),
    ' 最小二乘增益 R', gain[0].toFixed(4), 'G', gain[1].toFixed(4), 'B', gain[2].toFixed(4),
    ' | 中位比 R', med[0].toFixed(3), 'G', med[1].toFixed(3), 'B', med[2].toFixed(3));
  return { gain, n };
}

console.log('逐通道增益（把我们乘上这些数 = LR；1 表示一致）');
const all = fit(16, 250);
fit(16, 64);
fit(64, 128);
fit(128, 190);
fit(190, 250);

// 用全图增益校正后，重算分带残差，看还剩多少
const g = all.gain;
console.log('\n套用增益 R×' + g[0].toFixed(3) + ' G×' + g[1].toFixed(3) + ' B×' + g[2].toFixed(3) + ' 之后：');
const bands = [[0, 48], [48, 96], [96, 144], [144, 192], [192, 256]];
const acc = bands.map(() => ({ n: 0, dl: 0, abs: 0 }));
const acc0 = bands.map(() => ({ n: 0, dl: 0, abs: 0 }));
let absAll = 0, absAll0 = 0, nAll = 0;
for (let i = 0; i < W * H; i++) {
  const p = i * 4;
  const la = 0.2126 * A.d[p] + 0.7152 * A.d[p + 1] + 0.0722 * A.d[p + 2];
  const lin = [0, 1, 2].map((k) => l2s(s2l(B.d[p + k]) * g[k]));
  const lb = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  const lb0 = 0.2126 * B.d[p] + 0.7152 * B.d[p + 1] + 0.0722 * B.d[p + 2];
  const k = bands.findIndex(([x, y]) => la >= x && la < y);
  absAll += Math.abs(lb - la); absAll0 += Math.abs(lb0 - la); nAll++;
  if (k < 0) continue;
  acc[k].n++; acc[k].dl += lb - la; acc[k].abs += Math.abs(lb - la);
  acc0[k].n++; acc0[k].dl += lb0 - la; acc0[k].abs += Math.abs(lb0 - la);
}
for (let k = 0; k < bands.length; k++) {
  const c = acc[k], c0 = acc0[k];
  if (!c.n) continue;
  console.log('  L' + String(bands[k][0]).padStart(3) + '-' + String(bands[k][1]).padEnd(3),
    String((100 * c.n / nAll).toFixed(1) + '%').padStart(6),
    ' 原始 ΔL', (c0.dl / c0.n).toFixed(1).padStart(6), '|Δ|', (c0.abs / c0.n).toFixed(1).padStart(5),
    ' → 校正后 ΔL', (c.dl / c.n).toFixed(1).padStart(6), '|Δ|', (c.abs / c.n).toFixed(1).padStart(5));
}
console.log('  全图 |ΔL|', (absAll0 / nAll).toFixed(2), '→', (absAll / nAll).toFixed(2));
