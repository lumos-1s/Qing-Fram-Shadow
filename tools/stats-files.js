// 用同一套指标量任意几张 JPEG：平均 RGB / 亮度分位 / 饱和度 / ICC
const fs = require('fs');
const jpeg = require('jpeg-js');
const { readIccName } = require('../src/main/exif-read.js');

const FILES = [
  ['原图 22MB', 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg'],
  ['未命名导出', 'C:/Users/lumos/Desktop/未命名导出/DSC09381.jpg'],
  ['软件导出', 'C:/Users/lumos/Desktop/ps修后图片/DSC09381_边框.jpg'],
];

function stats(file) {
  const buf = fs.readFileSync(file);
  const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 4096 });
  const { width: w, height: h, data: d } = img;
  const x0 = Math.round(w * 0.06), y0 = Math.round(h * 0.06);
  const x1 = Math.round(w * 0.94), y1 = Math.round(h * 0.94);
  let r = 0, g = 0, b = 0, n = 0, satSum = 0;
  const lums = [];
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 200000)));
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * w + x) * 4;
      const R = d[i], G = d[i + 1], B = d[i + 2];
      r += R; g += G; b += B; n++;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      satSum += mx > 0 ? (mx - mn) / mx : 0;
      lums.push(0.2126 * R + 0.7152 * G + 0.0722 * B);
    }
  }
  lums.sort((a, b2) => a - b2);
  const q = (p) => Math.round(lums[Math.floor(lums.length * p)] || 0);
  return {
    w, h,
    rgb: [Math.round(r / n), Math.round(g / n), Math.round(b / n)],
    lv: [q(0.05), q(0.25), q(0.5), q(0.75), q(0.95)],
    sat: ((satSum / n) * 100).toFixed(1),
    icc: null,
  };
}

(async () => {
  for (const [name, f] of FILES) {
    if (!fs.existsSync(f)) { console.log(name, '(文件不存在)'); continue; }
    const t0 = Date.now();
    const s = stats(f);
    s.icc = await readIccName(fs.readFileSync(f));
    console.log(
      name.padEnd(10),
      `${s.w}x${s.h}`.padEnd(11),
      '平均RGB', JSON.stringify(s.rgb).padEnd(16),
      '亮度', s.lv.join('/').padEnd(20),
      '饱和', s.sat + '%',
      'ICC:', s.icc || '(无)',
      `(${Date.now() - t0}ms)`
    );
  }
})();
