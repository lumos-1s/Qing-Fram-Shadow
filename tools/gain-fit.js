// 增益拟合：把我们 tint=0 / tint=50 的渲染，与 LR 同 tint 的导出逐通道对齐，
// 求「线性光下的最佳增益」。两次拟合若给出同一个数，说明这是链路的固定偏置
// （相当于相机 Profile 的通道平衡），可以作为一个常量校正落进产品。
const fs = require('fs');
const jpeg = require('jpeg-js');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const loadPPM = (fp) => {
  const b = fs.readFileSync(fp);
  // 头：P6\nW H\n255\n
  let p = 0, fields = [];
  while (fields.length < 4) {
    while (b[p] === 10 || b[p] === 13 || b[p] === 32) p++;
    if (b[p] === 35) { while (b[p] !== 10) p++; continue; }
    let s = '';
    while (b[p] !== 10 && b[p] !== 13 && b[p] !== 32) s += String.fromCharCode(b[p++]);
    fields.push(s);
  }
  p++; // 跳过 255 后的单个换行
  const w = +fields[1], h = +fields[2];
  return { w, h, d: b.subarray(p, p + w * h * 3) };
};
const loadJ = (fp) => {
  const j = jpeg.decode(fs.readFileSync(fp), { useTArray: true, maxMemoryUsageInMB: 4096 });
  return { w: j.width, h: j.height, d: j.data };
};

const s2l = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const l2s = (v) => { v = Math.max(0, Math.min(1, v)); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055); };
function labArr(R, G, B) {
  let X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  let Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const t = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  X = t(X); Z = t(Z); const Y2 = t(Y);
  return [116 * Y2 - 16, 500 * (X - Y2), 200 * (Y2 - Z)];
}

// 把 LR 大图用 3×3 均值 + 双线性采到目标网格
function resample(im, W, H) {
  const out = { w: W, h: H, d: Buffer.alloc(W * H * 4, 255) };
  const rx = im.w / W, ry = im.h / H;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cx = (x + 0.5) * rx, cy = (y + 0.5) * ry;
      const x0 = Math.max(0, Math.floor(cx - rx / 2)), x1 = Math.min(im.w, Math.ceil(cx + rx / 2));
      const y0 = Math.max(0, Math.floor(cy - ry / 2)), y1 = Math.min(im.h, Math.ceil(cy + ry / 2));
      let r = 0, g = 0, b = 0, n = 0;
      const stepX = Math.max(1, Math.floor((x1 - x0) / 4)), stepY = Math.max(1, Math.floor((y1 - y0) / 4));
      for (let yy = y0; yy < y1; yy += stepY) {
        for (let xx = x0; xx < x1; xx += stepX) {
          const p = (yy * im.w + xx) * 4;
          r += im.d[p]; g += im.d[p + 1]; b += im.d[p + 2]; n++;
        }
      }
      const d = (y * W + x) * 4;
      out.d[d] = r / n; out.d[d + 1] = g / n; out.d[d + 2] = b / n; out.d[d + 3] = 255;
    }
  }
  return out;
}

const PATCHES = [
  ['黄叶上中', 0.40, 0.055, 0.14, 0.075], ['黄叶左下', 0.24, 0.115, 0.12, 0.07],
  ['墙', 0.10, 0.34, 0.10, 0.07], ['天光', 0.45, 0.205, 0.12, 0.05],
  ['路面', 0.44, 0.80, 0.12, 0.06], ['暗部', 0.18, 0.72, 0.10, 0.06],
];

function run(name, oursFp, lrFp, lrTint) {
  const A = loadPPM(path.join(OUT, oursFp));
  const raw = loadJ(lrFp);
  const B = resample(raw, A.w, A.h);
  const W = A.w, H = A.h;

  // 逐通道过原点最小二乘 + 饱和区剔除（>250 的像素对拟合贡献不大还容易主导）
  const num = [0, 0, 0], den = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < W * H; i++) {
    const p = i * 3, q = i * 4;
    if (A.d[p] > 250 && A.d[q] > 250) continue;
    for (let k = 0; k < 3; k++) {
      const a = s2l(A.d[p + k]), b = s2l(B.d[q + k]);
      num[k] += a * b; den[k] += b * b;
    }
    n++;
  }
  const gain = [0, 1, 2].map((k) => num[k] / den[k]);

  const stat = (gains) => {
    let dL = 0, da = 0, db = 0, m = 0, dE = 0;
    for (let i = 0; i < W * H; i++) {
      const p = i * 3, q = i * 4;
      const la = labArr(s2l(A.d[p]), s2l(A.d[p + 1]), s2l(A.d[p + 2]));
      const lb = labArr(s2l(B.d[q]) * gains[0], s2l(B.d[q + 1]) * gains[1], s2l(B.d[q + 2]) * gains[2]);
      dL += lb[0] - la[0]; da += lb[1] - la[1]; db += lb[2] - la[2];
      dE += Math.hypot(lb[0] - la[0], lb[1] - la[1], lb[2] - la[2]);
      m++;
    }
    return { dL: dL / m, da: da / m, db: db / m, dE: dE / m };
  };

  const before = stat([1, 1, 1]);
  const after = stat(gain);
  console.log('\n' + name + '  (n=' + n + ')');
  console.log('  最佳增益  R×' + gain[0].toFixed(4) + '  G×' + gain[1].toFixed(4) + '  B×' + gain[2].toFixed(4));
  console.log('  校正前     ΔL ' + before.dL.toFixed(2) + '  Δa ' + before.da.toFixed(2) + '  Δb ' + before.db.toFixed(2) + '  ΔE ' + before.dE.toFixed(2));
  console.log('  校正后     ΔL ' + after.dL.toFixed(2) + '  Δa ' + after.da.toFixed(2) + '  Δb ' + after.db.toFixed(2) + '  ΔE ' + after.dE.toFixed(2));

  // 分块验证：校正后各块的 Δa / ΔL
  const patchMean = (im, ch, nx, ny, nw, nh, gains) => {
    const x0 = Math.round(nx * W), y0 = Math.round(ny * H);
    const x1 = Math.round((nx + nw) * W), y1 = Math.round((ny + nh) * H);
    let r = 0, g = 0, b = 0, k = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * im.w + x) * ch;
        r += im.d[p] * (gains ? gains[0] : 1);
        g += im.d[p + 1] * (gains ? gains[1] : 1);
        b += im.d[p + 2] * (gains ? gains[2] : 1);
        k++;
      }
    }
    return [r / k, g / k, b / k];
  };
  console.log('  分块（校前 → 校后，ΔL/Δa）');
  for (const [pn, nx, ny, nw, nh] of PATCHES) {
    const a = patchMean(A, 3, nx, ny, nw, nh);
    const b0 = patchMean(B, 4, nx, ny, nw, nh);
    const b1 = patchMean(B, 4, nx, ny, nw, nh, gain);
    const la = labArr(s2l(a[0]), s2l(a[1]), s2l(a[2]));
    const l0 = labArr(s2l(b0[0]), s2l(b0[1]), s2l(b0[2]));
    const l1 = labArr(s2l(b1[0]), s2l(b1[1]), s2l(b1[2]));
    console.log('    ' + pn.padEnd(9) + 'ΔL ' + (l0[0] - la[0]).toFixed(1).padStart(6) + ' → ' + (l1[0] - la[0]).toFixed(1).padStart(5) +
      '   Δa ' + (l0[1] - la[1]).toFixed(1).padStart(6) + ' → ' + (l1[1] - la[1]).toFixed(1).padStart(5));
  }
  return gain;
}

const g0 = run('tint=0  vs LR tint=0', 'ours_t0.ppm', 'C:/Users/lumos/Desktop/未命名导出/tint=0.jpg', 0);
const g50 = run('tint=50 vs LR tint=50', 'ours_t50.ppm', 'C:/Users/lumos/Desktop/未命名导出/tint=50.jpg', 50);
console.log('\n两次拟合的差异：ΔR ' + (g0[0] - g50[0]).toFixed(4) + '  ΔG ' + (g0[1] - g50[1]).toFixed(4) + '  ΔB ' + (g0[2] - g50[2]).toFixed(4));
console.log('平均：R×' + ((g0[0] + g50[0]) / 2).toFixed(4) + ' G×' + ((g0[1] + g50[1]) / 2).toFixed(4) + ' B×' + ((g0[2] + g50[2]) / 2).toFixed(4));
