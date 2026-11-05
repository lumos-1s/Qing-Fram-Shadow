// 判定 LR 窗口截图到底等于哪一版：把 LR 的三档导出 + 我们的渲染 + PS 成片
// 用同一组几何变换对齐到截图，比较均值与分带残差。
// 若三档导出的对比都明显低于截图，说明截图是「屏幕显示」而非「导出文件」。
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
// 与 shot-align.js 求出的同一组变换
const CX = 0.4997, CY = 0.4953, SX = 0.9987, SY = 0.9919;

function warp(im, w, h) {
  const out = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++) {
    const gn = (y + 0.5) / h;
    const vy = (CY + (gn - 0.5) * SY) * im.h - 0.5;
    const y0 = Math.max(0, Math.min(im.h - 2, Math.floor(vy)));
    const fy = Math.max(0, Math.min(1, vy - y0));
    for (let x = 0; x < w; x++) {
      const gx = (x + 0.5) / w;
      const vx = (CX + (gx - 0.5) * SX) * im.w - 0.5;
      const x0 = Math.max(0, Math.min(im.w - 2, Math.floor(vx)));
      const fx = Math.max(0, Math.min(1, vx - x0));
      const p00 = (y0 * im.w + x0) * 4, p10 = (y0 * im.w + x0 + 1) * 4;
      const p01 = ((y0 + 1) * im.w + x0) * 4, p11 = ((y0 + 1) * im.w + x0 + 1) * 4;
      const d = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        const a = im.d[p00 + k] * (1 - fx) + im.d[p10 + k] * fx;
        const b = im.d[p01 + k] * (1 - fx) + im.d[p11 + k] * fx;
        out[d + k] = a * (1 - fy) + b * fy;
      }
      out[d + 3] = 255;
    }
  }
  return { w, h, d: out };
}

const bands = [[0, 48], [48, 96], [96, 144], [144, 192], [192, 256]];
function report(im, label) {
  const acc = bands.map(() => ({ n: 0, dl: 0, dr: 0, dg: 0, db: 0 }));
  let r = 0, g = 0, b = 0, n = 0, abs = 0;
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    const ar = A.d[p], ag = A.d[p + 1], ab = A.d[p + 2];
    const br = im.d[p], bg = im.d[p + 1], bb = im.d[p + 2];
    const la = 0.2126 * ar + 0.7152 * ag + 0.0722 * ab;
    const lb = 0.2126 * br + 0.7152 * bg + 0.0722 * bb;
    r += br; g += bg; b += bb; n++;
    abs += Math.abs(lb - la);
    const k = bands.findIndex(([x, y]) => la >= x && la < y);
    if (k < 0) continue;
    const c = acc[k];
    c.n++; c.dl += lb - la; c.dr += br - ar; c.dg += bg - ag; c.db += bb - ab;
  }
  console.log('\n' + label);
  console.log('  均值 RGB', [r / n, g / n, b / n].map((v) => v.toFixed(1)).join(' / '),
    ' |ΔL| 全图', (abs / n).toFixed(2));
  acc.forEach((c, k) => {
    if (!c.n) return;
    console.log('    L' + String(bands[k][0]).padStart(3) + '-' + String(bands[k][1]).padEnd(3),
      String((100 * c.n / n).toFixed(1) + '%').padStart(6),
      'ΔL', (c.dl / c.n).toFixed(1).padStart(6),
      'ΔRGB', [c.dr, c.dg, c.db].map((v) => (v / c.n).toFixed(1)).join(','));
  });
}

const refs = [
  ['LR tint=0', 'C:/Users/lumos/Desktop/未命名导出/tint=0.jpg'],
  ['LR tint=50', 'C:/Users/lumos/Desktop/未命名导出/tint=50.jpg'],
  ['LR tint=100', 'C:/Users/lumos/Desktop/未命名导出/tint=100.jpg'],
  ['我们的渲染', path.join(OUT, 't_ours.jpg')],
  ['PS 成片', path.join(OUT, 't_target.jpg')],
];
console.log('以下均为「参考 − LR截图」');
for (const [label, f] of refs) {
  if (!fs.existsSync(f)) { console.log(label, '(缺失)'); continue; }
  report(warp(load(f), W, H), label);
}
