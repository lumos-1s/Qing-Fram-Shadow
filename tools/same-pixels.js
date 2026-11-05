// 同像素对比：按「源图」的色相/明度分桶，再看我们与 LR 在同一批像素上的
// 平均 C*、L*。分带统计会被「谁的像素落进这个带」污染（颜色一挪，成员就变），
// 按源图分桶就不会：桶是固定的，差异只能来自渲染。
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const dir = path.join(__dirname, 'out');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const FILES = { ours: process.argv[2] || 'sh_spatial.jpg', lr: 'sh_lr.jpg' };

const srgb = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const labF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const lab = (r, g, b) => {
  const R = srgb(r), G = srgb(g), B = srgb(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const fx = labF(X), fy = labF(Y), fz = labF(Z);
  const C = Math.hypot(500 * (fx - fy), 200 * (fy - fz));
  let h = Math.atan2(200 * (fy - fz), 500 * (fx - fy)) * 180 / Math.PI;
  if (h < 0) h += 360;
  return { L: 116 * fy - 16, C, h };
};

// 统一按面积平均缩到 LR 的尺寸
function loadTo(file, W, H) {
  const im = jpeg.decode(fs.readFileSync(file), { useTArray: true, maxMemoryUsageInMB: 4096 });
  const out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * im.height / H), y1 = Math.max(y0 + 1, Math.floor((y + 1) * im.height / H));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * im.width / W), x1 = Math.max(x0 + 1, Math.floor((x + 1) * im.width / W));
      let R = 0, G = 0, B = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        const s = (sy * im.width + sx) * 4;
        R += im.data[s]; G += im.data[s + 1]; B += im.data[s + 2]; n++;
      }
      const d = (y * W + x) * 3;
      out[d] = R / n; out[d + 1] = G / n; out[d + 2] = B / n;
    }
  }
  return out;
}

const lr = jpeg.decode(fs.readFileSync(path.join(dir, FILES.lr)), { useTArray: true, maxMemoryUsageInMB: 4096 });
const W = lr.width, H = lr.height;
const maps = { src: loadTo(SRC, W, H), ours: loadTo(path.join(dir, FILES.ours), W, H), lr: loadTo(path.join(dir, FILES.lr), W, H) };

const HUES = [[345, 15, '红'], [15, 45, '橙'], [45, 70, '黄'], [70, 100, '黄绿'],
  [100, 150, '绿'], [150, 200, '青'], [200, 260, '蓝'], [260, 300, '紫'], [300, 345, '洋红']];
const buckets = HUES.map(() => ({ n: 0, sc: 0, sl: 0, oc: 0, ol: 0, lc: 0, ll: 0 }));

const N = W * H;
for (let i = 0; i < N; i++) {
  const k = i * 3;
  const s = lab(maps.src[k], maps.src[k + 1], maps.src[k + 2]);
  if (s.C < 8) continue;                    // 近中性像素不参与色相分桶
  let bi = -1;
  for (let j = 0; j < HUES.length; j++) {
    const lo = HUES[j][0], hi = HUES[j][1];
    if (lo < hi ? (s.h >= lo && s.h < hi) : (s.h >= lo || s.h < hi)) { bi = j; break; }
  }
  if (bi < 0) continue;
  const o = lab(maps.ours[k], maps.ours[k + 1], maps.ours[k + 2]);
  const l = lab(maps.lr[k], maps.lr[k + 1], maps.lr[k + 2]);
  const b = buckets[bi];
  b.n++; b.sc += s.C; b.sl += s.L; b.oc += o.C; b.ol += o.L; b.lc += l.C; b.ll += l.L;
}

console.log(`尺寸 ${W}x${H}   源图分桶（C*≥8）   ours=${FILES.ours}`);
console.log('\n色相带       占比    源C*   我们C*    LR C*    ΔC*      我们L*   LR L*    ΔL*');
const tot = { n: 0, oc: 0, lc: 0, ol: 0, ll: 0 };
for (let j = 0; j < HUES.length; j++) {
  const b = buckets[j];
  if (!b.n) continue;
  tot.n += b.n; tot.oc += b.oc; tot.lc += b.lc; tot.ol += b.ol; tot.ll += b.ll;
  const pct = (b.n / N * 100).toFixed(1) + '%';
  console.log(HUES[j][2].padEnd(6), pct.padStart(6),
    (b.sc / b.n).toFixed(1).padStart(7), (b.oc / b.n).toFixed(1).padStart(7), (b.lc / b.n).toFixed(1).padStart(7),
    ((b.oc - b.lc) / b.n).toFixed(1).padStart(6),
    (b.ol / b.n).toFixed(1).padStart(8), (b.ll / b.n).toFixed(1).padStart(7),
    ((b.ol - b.ll) / b.n).toFixed(1).padStart(6));
}
console.log('合计'.padEnd(6), (tot.n / N * 100).toFixed(1).padStart(6) + '%',
  ''.padStart(7), (tot.oc / tot.n).toFixed(1).padStart(7), (tot.lc / tot.n).toFixed(1).padStart(7),
  ((tot.oc - tot.lc) / tot.n).toFixed(1).padStart(6),
  (tot.ol / tot.n).toFixed(1).padStart(8), (tot.ll / tot.n).toFixed(1).padStart(7),
  ((tot.ol - tot.ll) / tot.n).toFixed(1).padStart(6));
