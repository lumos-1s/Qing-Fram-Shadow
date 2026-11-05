// 比较各渲染与 LR 的平均 Lab（a* 绿-红，b* 蓝-黄），判断色调强度
const fs = require('fs');
const jpeg = require('jpeg-js');

const FILES = [
  ['当前 tint38', 'tools/out/h_当前.jpg'],
  ['tint19', 'tools/out/h_色调19.jpg'],
  ['tint0', 'tools/out/h_色调0.jpg'],
  ['LR 参考', 'C:/Users/lumos/Desktop/DSC09381.jpg'],
  ['原图', 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg'],
];

const inv = (u) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));
function lab(R, G, B) {
  const r = inv(R / 255), g = inv(G / 255), b = inv(B / 255);
  let X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  let Y = (0.2126 * r + 0.7152 * g + 0.0722 * b);
  let Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  X = f(X); Y = f(Y); Z = f(Z);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

for (const [name, f] of FILES) {
  if (!fs.existsSync(f)) { console.log(name, '(缺失)'); continue; }
  const img = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
  const W = 800, H = Math.round(800 * img.height / img.width);
  const d = img.data, iw = img.width, ih = img.height;
  let L = 0, A = 0, B2 = 0, n = 0, sat = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (Math.floor(y * ih / H) * iw + Math.floor(x * iw / W)) * 4;
    const R = d[i], G = d[i + 1], Bl = d[i + 2];
    const v = lab(R, G, Bl);
    L += v[0]; A += v[1]; B2 += v[2]; n++;
    const mx = Math.max(R, G, Bl), mn = Math.min(R, G, Bl);
    sat += mx ? (mx - mn) / mx : 0;
  }
  console.log(name.padEnd(12), 'L', (L / n).toFixed(1).padStart(5), 'a*', (A / n).toFixed(1).padStart(6), 'b*', (B2 / n).toFixed(1).padStart(6), '饱和', (100 * sat / n).toFixed(1));
}
