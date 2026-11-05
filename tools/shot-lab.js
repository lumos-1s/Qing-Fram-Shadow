// 把「我们 − LR截图」分解到 Lab：按源色相分带看 Δa*/Δb*，判断是色相旋转、彩度缩放还是明度偏移。
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

// 以 LR 的色相为分带依据，逐带统计
const bands = [
  ['黄 70-100', 70, 100], ['黄绿 100-130', 100, 130], ['绿 130-180', 130, 180],
  ['青 180-230', 180, 230], ['蓝 230-280', 230, 280], ['品红 280-330', 280, 330],
  ['红 330-360/0-30', -30, 30], ['橙 30-70', 30, 70],
];
const acc = bands.map(() => ({ n: 0, dL: 0, da: 0, db: 0, dC: 0, dh: 0, h: 0, C: 0 }));
let tot = 0;
for (let i = 0; i < W * H; i++) {
  const p = i * 4;
  const la = lab(A.d[p], A.d[p + 1], A.d[p + 2]);
  const lb = lab(B.d[p], B.d[p + 1], B.d[p + 2]);
  const Ca = Math.hypot(la[1], la[2]);
  if (la[0] < 18 || la[0] > 244 || Ca < 12) continue;
  let ha = Math.atan2(la[2], la[1]) * 180 / Math.PI;
  const Cb = Math.hypot(lb[1], lb[2]);
  let hb = Math.atan2(lb[2], lb[1]) * 180 / Math.PI;
  let dh = hb - ha; while (dh > 180) dh -= 360; while (dh < -180) dh += 360;
  let hh = ha; if (hh < 0) hh += 360;
  let k = bands.findIndex(([, lo, hi]) => hh >= lo && hh < hi);
  if (k < 0 && (hh >= 330 || hh < 30)) k = 6;
  if (k < 0) continue;
  const c = acc[k];
  c.n++; c.dL += lb[0] - la[0]; c.da += lb[1] - la[1]; c.db += lb[2] - la[2];
  c.dC += Cb - Ca; c.dh += dh; c.h += hh; c.C += Ca;
}
console.log('源色相带       占比     LR的C*   我们−LR: ΔL    Δa*    Δb*    ΔC*    Δh(度)');
for (let i = 0; i < bands.length; i++) {
  const c = acc[i];
  if (!c.n) continue;
  console.log('  ' + bands[i][0].padEnd(16), (100 * c.n / W * 0 + 100 * c.n / (W * H)).toFixed(1).padStart(5) + '%',
    (c.C / c.n).toFixed(1).padStart(8),
    (c.dL / c.n).toFixed(1).padStart(7), (c.da / c.n).toFixed(1).padStart(7),
    (c.db / c.n).toFixed(1).padStart(7), (c.dC / c.n).toFixed(1).padStart(7),
    (c.dh / c.n).toFixed(1).padStart(7));
}

// 全局：若存在纯色相旋转 θ 使 ours 旋转后 ≈ LR
let s2 = 0, cross = 0, n2 = 0;
let sumC = 0, sumCL = 0;
for (let i = 0; i < W * H; i++) {
  const p = i * 4;
  const la = lab(A.d[p], A.d[p + 1], A.d[p + 2]);
  const lb = lab(B.d[p], B.d[p + 1], B.d[p + 2]);
  if (la[0] < 18 || la[0] > 244 || Math.hypot(la[1], la[2]) < 12) continue;
  // 把 ours 的 (a,b) 旋转到 LR 的最佳角度：最小二乘
  const ax = lb[1], bx = lb[2], ay = la[1], by = la[2];
  s2 += ax * ax + bx * bx;
  cross += ax * ay + bx * by;
  sumC += Math.hypot(ax, bx); sumCL += Math.hypot(ay, by);
  n2++;
}
const cosT = cross / s2;
const theta = Math.acos(Math.max(-1, Math.min(1, cosT))) * 180 / Math.PI;
console.log('\n纯色相旋转拟合：θ =', theta.toFixed(2), '度（正 = 我们需逆时针转）');
console.log('彩度比 LR/我们 =', (sumCL / sumC).toFixed(4), ' (n=' + n2 + ')');

// 叠一个「色相 + 彩度」双参数拟合后的残差
const k = sumCL / sumC;
let resid = 0, base = 0;
for (let i = 0; i < W * H; i++) {
  const p = i * 4;
  const la = lab(A.d[p], A.d[p + 1], A.d[p + 2]);
  const lb = lab(B.d[p], B.d[p + 1], B.d[p + 2]);
  if (la[0] < 18 || la[0] > 244 || Math.hypot(la[1], la[2]) < 12) continue;
  const a2 = (lb[1] * cosT - lb[2] * Math.sqrt(1 - cosT * cosT)) * k;
  const b2 = (lb[1] * Math.sqrt(1 - cosT * cosT) + lb[2] * cosT) * k;
  resid += Math.hypot(a2 - la[1], b2 - la[2]);
  base += Math.hypot(lb[1] - la[1], lb[2] - la[2]);
}
console.log('Δ(a,b) 平均距离：校正前', (base / n2).toFixed(2), '→ 校正后', (resid / n2).toFixed(2));
