// 对齐后的 1:1 并排裁切：左 = LR 截图，右 = 我们的渲染。
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

function side(name, cx, cy, ww, hh) {
  const x0 = Math.round((cx - ww / 2) * W), y0 = Math.round((cy - hh / 2) * H);
  const w = Math.round(ww * W), h = Math.round(hh * H);
  const gap = 6;
  const buf = Buffer.alloc((w * 2 + gap) * h * 4, 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.max(0, Math.min(W - 1, x0 + x)), sy = Math.max(0, Math.min(H - 1, y0 + y));
      const s = (sy * W + sx) * 4;
      for (let k = 0; k < 3; k++) {
        buf[(y * (w * 2 + gap) + x) * 4 + k] = A.d[s + k];
        buf[(y * (w * 2 + gap) + gap + w + x) * 4 + k] = B.d[s + k];
      }
    }
  }
  fs.writeFileSync(path.join(OUT, name), jpeg.encode({ data: buf, width: w * 2 + gap, height: h }, 95).data);
  console.log('落盘', name, (w * 2 + gap) + 'x' + h);
}

side('lr_leaves.jpg', 0.45, 0.09, 0.30, 0.16);
side('lr_wall.jpg', 0.12, 0.36, 0.22, 0.16);
side('lr_road.jpg', 0.46, 0.80, 0.26, 0.14);
side('lr_shadow.jpg', 0.20, 0.74, 0.24, 0.16);
side('lr_sky.jpg', 0.47, 0.24, 0.26, 0.14);

// 差异放大图（灰=一致，偏红=我们更红…）
const amp = Buffer.alloc(W * H * 4, 255);
for (let i = 0; i < W * H; i++) {
  const p = i * 4;
  for (let k = 0; k < 3; k++) {
    const v = 128 + (B.d[p + k] - A.d[p + k]) * 3;
    amp[p + k] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  amp[p + 3] = 255;
}
fs.writeFileSync(path.join(OUT, 'lr_diff.jpg'), jpeg.encode({ data: amp, width: W, height: H }, 95).data);
console.log('落盘 lr_diff.jpg');
