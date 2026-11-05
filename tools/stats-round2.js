// 量新一轮对比图：新版软件导出 vs 参考图，并拆分「整体饱和」与「分色相饱和」
const fs = require('fs');
const jpeg = require('jpeg-js');

const FILES = [
  ['软件导出2(带框)', 'C:/Users/lumos/Desktop/ps修后图片/DSC09381_边框_2.jpg'],
  ['软件导出1(带框)', 'C:/Users/lumos/Desktop/ps修后图片/DSC09381_边框_1.jpg'],
  ['用户贴图1', 'C:/Users/lumos/.workbuddy/clipboard-images/clipboard-2026-11-04T08-06-38-133Z-fa23b767.jpg'],
  ['用户贴图2', 'C:/Users/lumos/.workbuddy/clipboard-images/clipboard-2026-11-04T08-06-38-137Z-41ebf587.jpg'],
  ['桌面DSC09381', 'C:/Users/lumos/Desktop/DSC09381.jpg'],
  ['原图22MB', 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg'],
  ['旧软件导出', 'C:/Users/lumos/Desktop/ps修后图片/DSC09381_边框.jpg'],
];

function rgb2hsv(R, G, B) {
  const r = R / 255, g = G / 255, b = B / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: mx > 0 ? d / mx : 0, v: mx };
}

function stats(file) {
  const img = jpeg.decode(fs.readFileSync(file), { useTArray: true, maxMemoryUsageInMB: 4096 });
  const { width: w, height: h, data: d } = img;
  const x0 = Math.round(w * 0.03), y0 = Math.round(h * 0.03);
  const x1 = Math.round(w * 0.97), y1 = Math.round(h * 0.97);
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 250000)));
  let r = 0, g = 0, b = 0, n = 0, satSum = 0;
  const lums = [];
  const bands = new Array(12).fill(0).map(() => ({ s: 0, n: 0, v: 0 }));
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * w + x) * 4;
      const R = d[i], G = d[i + 1], B = d[i + 2];
      r += R; g += G; b += B; n++;
      const { h: hh, s, v } = rgb2hsv(R, G, B);
      satSum += s;
      lums.push(0.2126 * R + 0.7152 * G + 0.0722 * B);
      // 只统计有颜色、不太黑不太白的像素
      if (v > 0.12 && v < 0.97 && s > 0.05) {
        const k = Math.min(11, Math.floor(hh / 30));
        bands[k].s += s; bands[k].n++; bands[k].v += v;
      }
    }
  }
  lums.sort((a, b2) => a - b2);
  const q = (p) => Math.round(lums[Math.floor(lums.length * p)] || 0);
  return {
    w, h,
    rgb: [Math.round(r / n), Math.round(g / n), Math.round(b / n)],
    lv: [q(0.05), q(0.25), q(0.5), q(0.75), q(0.95)],
    sat: +((satSum / n) * 100).toFixed(1),
    bands: bands.map((b2, i) => ({ i, s: b2.n ? +(100 * b2.s / b2.n).toFixed(0) : null, n: b2.n })),
    bandShare: bands.map((b2) => +(100 * b2.n / n).toFixed(1)),
  };
}

const out = [];
for (const [name, f] of FILES) {
  if (!fs.existsSync(f)) { console.log(name, '(缺失)'); continue; }
  const s = stats(f);
  out.push([name, s]);
  console.log(name.padEnd(16), `${s.w}x${s.h}`.padEnd(12), 'RGB', JSON.stringify(s.rgb).padEnd(16),
    '亮度', s.lv.join('/').padEnd(22), '饱和', String(s.sat).padStart(5) + '%');
}

console.log('\n=== 分色相饱和度（红30-60 橙 黄 绿 ...） ===');
const BAND = ['红0', '橙30', '黄60', '黄绿90', '绿120', '青绿150', '青180', '蓝210', '蓝紫240', '紫270', '品300', '粉330'];
console.log('文件'.padEnd(16), BAND.map((x) => x.padStart(5)).join(' '));
for (const [name, s] of out) {
  console.log(name.padEnd(16), s.bands.map((b2) => (b2.s === null ? '   - ' : String(b2.s).padStart(4) + ' ')).join(' '));
}
console.log('\n=== 色相占比 ===');
for (const [name, s] of out) {
  console.log(name.padEnd(16), s.bandShare.map((x) => String(x).padStart(5)).join(' '));
}
