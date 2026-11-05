// 检测图片白边（相框）范围，并只统计照片区域
const fs = require('fs');
const jpeg = require('jpeg-js');

const FILES = [
  ['原图', 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg'],
  ['LR导出', 'C:/Users/lumos/Desktop/未命名导出/DSC09381.jpg'],
  ['软件导出', 'C:/Users/lumos/Desktop/ps修后图片/DSC09381_边框.jpg'],
];

const near = (d, i, v, tol) => Math.abs(d[i] - v) <= tol && Math.abs(d[i + 1] - v) <= tol && Math.abs(d[i + 2] - v) <= tol;

// 从四边向内扫，找第一个明显不是纯白/纯底色的位置
function bbox(img) {
  const { width: w, height: h, data: d } = img;
  const rowWhite = (y, v) => {
    let c = 0;
    for (let x = 0; x < w; x += 3) if (near(d, (y * w + x) * 4, v, 10)) c++;
    return c / Math.ceil(w / 3);
  };
  const colWhite = (x, v) => {
    let c = 0;
    for (let y = 0; y < h; y += 3) if (near(d, (y * w + x) * 4, v, 10)) c++;
    return c / Math.ceil(h / 3);
  };
  const v = d[(Math.floor(h / 2) * w + 2) * 4]; // 用左边第一列的像素当底色
  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  while (top < h * 0.3 && rowWhite(top, v) > 0.9) top++;
  while (bottom > h * 0.7 && rowWhite(bottom, v) > 0.9) bottom--;
  while (left < w * 0.3 && colWhite(left, v) > 0.9) left++;
  while (right > w * 0.7 && colWhite(right, v) > 0.9) right--;
  return { top, bottom, left, right, bg: v };
}

function statsIn(img, x0, y0, x1, y1, inset) {
  const { width: w, data: d } = img;
  const ix = Math.round((x1 - x0) * (inset || 0)), iy = Math.round((y1 - y0) * (inset || 0));
  x0 += ix; x1 -= ix; y0 += iy; y1 -= iy;
  let r = 0, g = 0, b = 0, n = 0, s = 0;
  const L = [];
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 200000)));
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * w + x) * 4;
      const R = d[i], G = d[i + 1], B = d[i + 2];
      r += R; g += G; b += B; n++;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      s += mx > 0 ? (mx - mn) / mx : 0;
      L.push(0.2126 * R + 0.7152 * G + 0.0722 * B);
    }
  }
  L.sort((a, b2) => a - b2);
  const q = (p) => Math.round(L[Math.floor(L.length * p)] || 0);
  return { rgb: [Math.round(r / n), Math.round(g / n), Math.round(b / n)], lv: [q(0.05), q(0.25), q(0.5), q(0.75), q(0.95)], sat: +((s / n) * 100).toFixed(1) };
}

for (const [name, f] of FILES) {
  if (!fs.existsSync(f)) { console.log(name, '(缺)'); continue; }
  const img = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
  const bb = bbox(img);
  const padded = statsIn(img, 0, 0, img.width, img.height, 0.06);
  const inner = statsIn(img, bb.left, bb.top, bb.right, bb.bottom, 0.01);
  console.log(`\n${name}  ${img.width}x${img.height}  底色=${bb.bg}`);
  console.log(`  照片区: x ${bb.left}..${bb.right} (${bb.right - bb.left})  y ${bb.top}..${bb.bottom} (${bb.bottom - bb.top})`);
  console.log(`  白边占比: 上 ${(bb.top / img.height * 100).toFixed(1)}%  下 ${((img.height - 1 - bb.bottom) / img.height * 100).toFixed(1)}%  左 ${(bb.left / img.width * 100).toFixed(1)}%  右 ${((img.width - 1 - bb.right) / img.width * 100).toFixed(1)}%`);
  console.log(`  旧口径(裁6%): RGB ${JSON.stringify(padded.rgb)}  亮度 ${padded.lv.join('/')}  饱和 ${padded.sat}%`);
  console.log(`  只量照片   : RGB ${JSON.stringify(inner.rgb)}  亮度 ${inner.lv.join('/')}  饱和 ${inner.sat}%`);
}
