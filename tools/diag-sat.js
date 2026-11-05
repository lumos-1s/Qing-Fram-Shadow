// ① 检测导出图的白边 ② 用「把软件的影调拉回 LR」的方式，检验饱和度差距有多少是影调带出来的
const fs = require('fs');
const jpeg = require('jpeg-js');

const APP = 'C:/Users/lumos/Desktop/ps修后图片/DSC09381_边框_2.jpg';
const REF = 'C:/Users/lumos/Desktop/DSC09381.jpg';

function load(f) {
  const img = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
  return img;
}

function detectBorder(img) {
  const { width: w, height: h, data: d } = img;
  const isWhiteRow = (y) => {
    let sum = 0, n = 0;
    for (let x = 0; x < w; x += 7) { const i = (y * w + x) * 4; sum += (d[i] + d[i + 1] + d[i + 2]) / 3; n++; }
    return sum / n > 246;
  };
  const isWhiteCol = (x) => {
    let sum = 0, n = 0;
    for (let y = 0; y < h; y += 7) { const i = (y * w + x) * 4; sum += (d[i] + d[i + 1] + d[i + 2]) / 3; n++; }
    return sum / n > 246;
  };
  let top = 0, bot = 0, left = 0, right = 0;
  while (top < h / 4 && isWhiteRow(top)) top++;
  while (bot < h / 4 && isWhiteRow(h - 1 - bot)) bot++;
  while (left < w / 4 && isWhiteCol(left)) left++;
  while (right < w / 4 && isWhiteCol(w - 1 - right)) right++;
  return { top, bot, left, right };
}

function sample(img, box, target = 250000) {
  const { width: w, height: h, data: d } = img;
  const x0 = box.left, y0 = box.top, x1 = w - box.right, y1 = h - box.bot;
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / target)));
  const px = [];
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    const i = (y * w + x) * 4;
    px.push([d[i], d[i + 1], d[i + 2]]);
  }
  return px;
}

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

function report(name, px) {
  const ch = [0, 1, 2].map((c) => px.map((p) => p[c]));
  const lums = px.map((p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]);
  const sats = px.map((p) => { const mx = Math.max(...p), mn = Math.min(...p); return mx > 0 ? (mx - mn) / mx : 0; });
  console.log(name.padEnd(14),
    'RGB', JSON.stringify(ch.map((c) => Math.round(mean(c)))).padEnd(16),
    'P1', JSON.stringify(ch.map((c) => pct(c, 0.01))).padEnd(16),
    'P50', JSON.stringify(ch.map((c) => pct(c, 0.5))).padEnd(16),
    'P99', JSON.stringify(ch.map((c) => pct(c, 0.99))).padEnd(16),
    '亮度', [0.05, 0.25, 0.5, 0.75, 0.95].map((p) => Math.round(pct(lums, p))).join('/').padEnd(20),
    '饱和', (mean(sats) * 100).toFixed(1) + '%');
  return { ch, lums, sats };
}

const A = load(APP), R = load(REF);
const bA = detectBorder(A), bR = detectBorder(R);
console.log('边框检测 软件:', JSON.stringify(bA), ' 参考:', JSON.stringify(bR));

const pxA0 = sample(A, bA), pxR0 = sample(R, bR);
console.log('\n--- 原始统计 ---');
const sA = report('软件导出', pxA0);
const sR = report('LR参考', pxR0);

// 把软件图的每个通道按 P1/P99 线性拉伸到参考图的 P1/P99，再量饱和度
function stretch(px, src, dst) {
  const lim = [0, 1, 2].map((c) => [pct(src[c], 0.01), pct(src[c], 0.99), pct(dst[c], 0.01), pct(dst[c], 0.99)]);
  return px.map((p) => p.map((v, c) => {
    const [a0, a1, b0, b1] = lim[c];
    const t = (v - a0) / Math.max(1e-6, a1 - a0);
    return Math.max(0, Math.min(255, Math.round(b0 + t * (b1 - b0))));
  }));
}
const pxA1 = stretch(pxA0, sA.ch, sR.ch);
console.log('\n--- 只把影调拉回 LR（不动颜色） ---');
report('拉伸后', pxA1);
