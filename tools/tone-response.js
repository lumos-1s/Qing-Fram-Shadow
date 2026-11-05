// 经验响应曲线：原图亮度 → 软件输出 / LR 输出（同一像素对应）
const fs = require('fs');
const jpeg = require('jpeg-js');

const F = {
  src: 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg',
  app: 'C:/Users/lumos/Desktop/ps修后图片/DSC09381_边框.jpg',
  lr: 'C:/Users/lumos/Desktop/未命名导出/DSC09381.jpg',
};

function load(p) {
  const img = jpeg.decode(fs.readFileSync(p), { useTArray: true, maxMemoryUsageInMB: 4096 });
  return { w: img.width, h: img.height, d: img.data };
}

const S = load(F.src), A = load(F.app), L = load(F.lr);
const N = 24, bins = Array.from({ length: N }, () => ({ s: 0, a: 0, l: 0, n: 0 }));
const step = 3;
for (let y = 0; y < S.h; y += step) {
  for (let x = 0; x < S.w; x += step) {
    const i = (y * S.w + x) * 4;
    const ls = 0.2126 * S.d[i] + 0.7152 * S.d[i + 1] + 0.0722 * S.d[i + 2];
    const la = 0.2126 * A.d[i] + 0.7152 * A.d[i + 1] + 0.0722 * A.d[i + 2];
    const ll = 0.2126 * L.d[i] + 0.7152 * L.d[i + 1] + 0.0722 * L.d[i + 2];
    const k = Math.min(N - 1, Math.floor(ls / 256 * N));
    bins[k].s += ls; bins[k].a += la; bins[k].l += ll; bins[k].n++;
  }
}

console.log('输入亮度   →  软件输出    LR 输出     软件−LR   软件斜率  LR斜率');
const pts = bins.filter(b => b.n > 500).map(b => ({
  s: b.s / b.n, a: b.a / b.n, l: b.l / b.n, n: b.n,
}));
for (let i = 0; i < pts.length; i++) {
  const p = pts[i];
  const pa = pts[i - 1], pl = pts[i - 1];
  const sa = pa ? (p.a - pa.a) / (p.s - pa.s) : NaN;
  const sl = pl ? (p.l - pl.l) / (p.s - pl.s) : NaN;
  console.log(
    p.s.toFixed(0).padStart(6), '→',
    p.a.toFixed(0).padStart(8), p.l.toFixed(0).padStart(8),
    (p.a - p.l).toFixed(0).padStart(9),
    (isFinite(sa) ? sa.toFixed(2) : '—').padStart(8),
    (isFinite(sl) ? sl.toFixed(2) : '—').padStart(8)
  );
}

// 线性拟合 软件输出 = k * LR输出 + b，看是不是简单的比例问题
let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
for (const p of pts) { sx += p.l; sy += p.a; sxx += p.l * p.l; sxy += p.l * p.a; n++; }
const k = (n * sxy - sx * sy) / (n * sxx - sx * sx);
const b = (sy - k * sx) / n;
console.log(`\n拟合: 软件 = ${k.toFixed(3)} × LR + ${b.toFixed(1)}   (k<1 表示对比度不足)`);
