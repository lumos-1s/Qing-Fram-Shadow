// 从三张已落盘的 1400px 整图里裁同一块，拼成「去阴影 | 空间阴影 | LR」三连，供人眼比对
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const dir = path.join(__dirname, 'out');
const names = ['sh_none.jpg', 'sh_spatial.jpg', 'sh_lr.jpg'];
const imgs = names.map((f) => jpeg.decode(fs.readFileSync(path.join(dir, f)), { useTArray: true, maxMemoryUsageInMB: 4096 }));

// 相对坐标 [x0,y0,x1,y1]，输出文件名
const crops = [
  ['crop_dark.jpg', 0.02, 0.60, 0.42, 0.92],
  ['crop_sky.jpg', 0.36, 0.02, 0.70, 0.26],
  ['crop_mid.jpg', 0.04, 0.18, 0.34, 0.44]
];

for (const [out, rx0, ry0, rx1, ry1] of crops) {
  const src = imgs[2];
  const x0 = Math.round(rx0 * src.width), y0 = Math.round(ry0 * src.height);
  const w = Math.round((rx1 - rx0) * src.width), h = Math.round((ry1 - ry0) * src.height);
  const gap = 6;
  const W = w * 3 + gap * 2, H = h;
  const out4 = Buffer.alloc(W * H * 4, 255);
  imgs.forEach((img, k) => {
    const ox = k * (w + gap);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = ((y + y0) * img.width + (x + x0)) * 4;
        const d = (y * W + ox + x) * 4;
        out4[d] = img.data[s]; out4[d + 1] = img.data[s + 1]; out4[d + 2] = img.data[s + 2]; out4[d + 3] = 255;
      }
    }
  });
  fs.writeFileSync(path.join(dir, out), jpeg.encode({ data: out4, width: W, height: H }, 95).data);
  console.log(out, W + 'x' + H);
}
