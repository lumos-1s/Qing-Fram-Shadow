// 参照系审计：把「LR 自己的三档导出」和「我们的渲染」都用同一套几何变换贴到
// 截图的坐标系上，然后各自对截图做逐通道最小二乘增益拟合。
//
// 关键判据：如果 LR 自己的导出贴过去也需要「砍蓝 8%」，那说明截图本身在蓝通道上
// 就比任何 LR 输出都低（显示管线差异），照它修会把错误焊进产品；反之如果导出几乎
// 不需要改、只有我们需要，那这个增益就是真缺陷。
const jpeg = require('jpeg-js');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const load = (f) => {
  const j = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
  return { w: j.width, h: j.height, d: j.data };
};
const A = load(path.join(OUT, 'shot_lr.jpg'));
const W = A.w, H = A.h;
const CX = 0.4997, CY = 0.4953, SX = 0.9987, SY = 0.9919;

function warp(im) {
  const out = { w: W, h: H, d: Buffer.alloc(W * H * 4, 255) };
  for (let y = 0; y < H; y++) {
    const vy = (CY + ((y + 0.5) / H - 0.5) * SY) * im.h - 0.5;
    const y0 = Math.max(0, Math.min(im.h - 2, Math.floor(vy)));
    const fy = Math.max(0, Math.min(1, vy - y0));
    for (let x = 0; x < W; x++) {
      const vx = (CX + ((x + 0.5) / W - 0.5) * SX) * im.w - 0.5;
      const x0 = Math.max(0, Math.min(im.w - 2, Math.floor(vx)));
      const fx = Math.max(0, Math.min(1, vx - x0));
      const p00 = (y0 * im.w + x0) * 4, p10 = (y0 * im.w + x0 + 1) * 4;
      const p01 = ((y0 + 1) * im.w + x0) * 4, p11 = ((y0 + 1) * im.w + x0 + 1) * 4;
      const d = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) {
        const a = im.d[p00 + k] * (1 - fx) + im.d[p10 + k] * fx;
        const b = im.d[p01 + k] * (1 - fx) + im.d[p11 + k] * fx;
        out.d[d + k] = a * (1 - fy) + b * fy;
      }
      out.d[d + 3] = 255;
    }
  }
  return out;
}

const s2l = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };

function fit(B, label) {
  // 逐通道过原点最小二乘（线性光），并给出分带残差
  const num = [0, 0, 0], den = [0, 0, 0];
  let n = 0;
  const BANDS = [[0, 19], [19, 38], [38, 56], [56, 75], [75, 101]];
  const res = BANDS.map(() => ({ n: 0, dr: 0, dg: 0, db: 0 }));
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    const al = [s2l(A.d[p]), s2l(A.d[p + 1]), s2l(A.d[p + 2])];
    const bl = [s2l(B.d[p]), s2l(B.d[p + 1]), s2l(B.d[p + 2])];
    for (let k = 0; k < 3; k++) { num[k] += al[k] * bl[k]; den[k] += bl[k] * bl[k]; }
    // 分带：用截图的 L*
    const Y = lum(al[0], al[1], al[2]);
    const L = Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
    const bi = BANDS.findIndex(([lo, hi]) => L >= lo && L < hi);
    if (bi >= 0) {
      const q = res[bi]; q.n++;
      q.dr += B.d[p] - A.d[p]; q.dg += B.d[p + 1] - A.d[p + 1]; q.db += B.d[p + 2] - A.d[p + 2];
    }
    n++;
  }
  const gain = [0, 1, 2].map((k) => (den[k] > 0 ? num[k] / den[k] : 1));
  // 增益后的残差 MAE（sRGB 级）
  let mae = 0;
  const l2s = (v) => { v = Math.max(0, Math.min(1, v)); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055); };
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    for (let k = 0; k < 3; k++) mae += Math.abs(l2s(s2l(B.d[p + k]) * gain[k]) - A.d[p + k]);
  }
  mae /= W * H * 3;
  console.log(label.padEnd(12) + '需增益 R×' + gain[0].toFixed(3) + ' G×' + gain[1].toFixed(3) + ' B×' + gain[2].toFixed(3) +
    '   增益后 MAE ' + mae.toFixed(2) + '（未校正 ' + (() => { let m = 0; for (let i = 0; i < W * H; i++) { const p = i * 4; for (let k = 0; k < 3; k++) m += Math.abs(B.d[p + k] - A.d[p + k]); } return (m / (W * H * 3)).toFixed(2); })() + '）');
  console.log('   分带 ΔRGB（按截图 L*）：' + res.map((q, i) => (q.n ? 'L' + BANDS[i][0] + ' ' + [q.dr, q.dg, q.db].map((v) => (v / q.n >= 0 ? '+' : '') + (v / q.n).toFixed(1)).join(',') : 'L' + BANDS[i][0] + ' -')).join(' | '));
}

const srcs = [
  ['我们', path.join(OUT, 't_ours.jpg')],
  ['LR tint=0', 'C:/Users/lumos/Desktop/未命名导出/tint=0.jpg'],
  ['LR tint=50', 'C:/Users/lumos/Desktop/未命名导出/tint=50.jpg'],
  ['LR tint=100', 'C:/Users/lumos/Desktop/未命名导出/tint=100.jpg'],
];
console.log('目标 = LR 截图（1663×1100）。正数 = 该图比截图高\n');
for (const [name, fp] of srcs) {
  if (!fs.existsSync(fp)) { console.log(name, '（缺）'); continue; }
  fit(warp(load(fp)), name);
}
