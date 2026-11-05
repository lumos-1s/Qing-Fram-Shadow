// 「我们 vs LR」两连对比图：左 = 当前实现，右 = Lightroom 同预设导出。
// 只做并排，不做插值，方便人眼直接看差距在哪。
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const dir = path.join(__dirname, 'out');
const read = (f) => jpeg.decode(fs.readFileSync(path.join(dir, f)), { useTArray: true, maxMemoryUsageInMB: 4096 });
const ours = read('sh_spatial.jpg');
const lr = read('sh_lr.jpg');
if (ours.width !== lr.width || ours.height !== lr.height) {
  console.error('尺寸不一致', ours.width, ours.height, lr.width, lr.height);
  process.exit(1);
}

// 相对坐标 [x0,y0,x1,y1] → 1:1 两连（间隔 6px）
const crops = [
  ['ab_dark.jpg', 0.02, 0.60, 0.42, 0.92, '暗部'],
  ['ab_sky.jpg', 0.36, 0.02, 0.70, 0.26, '天空'],
  ['ab_mid.jpg', 0.04, 0.18, 0.34, 0.44, '中间调']
];
for (const [out, rx0, ry0, rx1, ry1, note] of crops) {
  const x0 = Math.round(rx0 * lr.width), y0 = Math.round(ry0 * lr.height);
  const w = Math.round((rx1 - rx0) * lr.width), h = Math.round((ry1 - ry0) * lr.height);
  const gap = 6, W = w * 2 + gap, H = h;
  const buf = Buffer.alloc(W * H * 4, 255);
  [ours, lr].forEach((img, k) => {
    const ox = k * (w + gap);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = ((y + y0) * img.width + (x + x0)) * 4;
        const d = (y * W + ox + x) * 4;
        buf[d] = img.data[s]; buf[d + 1] = img.data[s + 1]; buf[d + 2] = img.data[s + 2]; buf[d + 3] = 255;
      }
    }
  });
  fs.writeFileSync(path.join(dir, out), jpeg.encode({ data: buf, width: W, height: H }, 94).data);
  console.log(out.padEnd(14), note.padEnd(5), W + 'x' + H, '（左：我们的实现 / 右：Lightroom）');
}

// 整图缩略两连：用 2×2 面积平均降到 700 宽
function thumb(img, TW) {
  const TH = Math.round(TW * img.height / img.width);
  const out = Buffer.alloc(TW * TH * 4, 255);
  const k = img.width / TW;
  for (let y = 0; y < TH; y++) {
    const y0 = Math.floor(y * img.height / TH), y1 = Math.max(y0 + 1, Math.floor((y + 1) * img.height / TH));
    for (let x = 0; x < TW; x++) {
      const x0 = Math.floor(x * img.width / TW), x1 = Math.max(x0 + 1, Math.floor((x + 1) * img.width / TW));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        const s = (sy * img.width + sx) * 4;
        r += img.data[s]; g += img.data[s + 1]; b += img.data[s + 2]; n++;
      }
      const d = (y * TW + x) * 4;
      out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n; out[d + 3] = 255;
    }
  }
  return { w: TW, h: TH, d: out, k };
}
{
  const TW = 760, gap = 8;
  const a = thumb(ours, TW), b = thumb(lr, TW);
  const W = a.w * 2 + gap, H = a.h;
  const buf = Buffer.alloc(W * H * 4, 255);
  [a, b].forEach((t, idx) => {
    const ox = idx * (a.w + gap);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < a.w; x++) {
        const s = (y * t.w + x) * 4, d = (y * W + ox + x) * 4;
        buf[d] = t.d[s]; buf[d + 1] = t.d[s + 1]; buf[d + 2] = t.d[s + 2]; buf[d + 3] = 255;
      }
    }
  });
  fs.writeFileSync(path.join(dir, 'ab_full.jpg'), jpeg.encode({ data: buf, width: W, height: H }, 92).data);
  console.log('ab_full.jpg'.padEnd(14), '整图  '.padEnd(5), W + 'x' + H, '（左：我们的实现 / 右：Lightroom）');
}
