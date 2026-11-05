// 按色相分带比较「我们」与 LR 的彩度/明度：找出到底哪个色相不够艳
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const dir = path.join(__dirname, 'out');
const read = (f) => jpeg.decode(fs.readFileSync(path.join(dir, f)), { useTArray: true, maxMemoryUsageInMB: 4096 });
const A = read(process.argv[2] || 'sh_spatial.jpg');
const B = read(process.argv[3] || 'sh_lr.jpg');

const srgb = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const labF = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
function toLab(r, g, b) {
  const R = srgb(r), G = srgb(g), Bl = srgb(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * Bl) / 0.95047;
  const Y = (0.2126 * R + 0.7152 * G + 0.0722 * Bl);
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * Bl) / 1.08883;
  const fx = labF(X), fy = labF(Y), fz = labF(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const BANDS = [
  ['红 345-15', 345, 15], ['橙 15-45', 15, 45], ['黄 45-70', 45, 70], ['黄绿 70-100', 70, 100],
  ['绿 100-150', 100, 150], ['青 150-200', 150, 200], ['蓝 200-260', 200, 260],
  ['紫 260-300', 260, 300], ['品红 300-345', 300, 345]
];

function collect(img) {
  const acc = BANDS.map(() => ({ n: 0, C: 0, L: 0 }));
  let allC = 0, allL = 0, allN = 0;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lab = toLab(d[i], d[i + 1], d[i + 2]);
    const C = Math.hypot(lab[1], lab[2]);
    allC += C; allL += lab[0]; allN++;
    if (C < 6) continue;   // 近中性色没有可靠色相
    let h = Math.atan2(lab[2], lab[1]) * 180 / Math.PI;
    if (h < 0) h += 360;
    for (let k = 0; k < BANDS.length; k++) {
      const [lo, hi] = [BANDS[k][1], BANDS[k][2]];
      const inBand = lo < hi ? (h >= lo && h < hi) : (h >= lo || h < hi);
      if (inBand) { acc[k].n++; acc[k].C += C; acc[k].L += lab[0]; break; }
    }
  }
  return { acc, allC: allC / allN, allL: allL / allN, allN };
}

const a = collect(A), b = collect(B);
console.log('整体  C* 我们', a.allC.toFixed(2), ' LR', b.allC.toFixed(2),
  '   L* 我们', a.allL.toFixed(1), ' LR', b.allL.toFixed(1));
console.log('\n色相带          占比(我/LR)     C* 我们    C* LR    比值     L* 我们   L* LR   差');
BANDS.forEach((band, k) => {
  const x = a.acc[k], y = b.acc[k];
  if (!x.n || !y.n) return;
  const ca = x.C / x.n, cb = y.C / y.n, la = x.L / x.n, lb = y.L / y.n;
  console.log(band[0].padEnd(14), (100 * x.n / a.allN).toFixed(1).padStart(5) + '%/' + (100 * y.n / b.allN).toFixed(1) + '%',
    ca.toFixed(1).padStart(9), cb.toFixed(1).padStart(8), (ca / cb).toFixed(3).padStart(8),
    la.toFixed(1).padStart(8), lb.toFixed(1).padStart(7), (la - lb).toFixed(1).padStart(6));
});
