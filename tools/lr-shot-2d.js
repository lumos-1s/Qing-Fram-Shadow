// LR 截图（用户提供的 LR 窗口截图）与我们的渲染 / PS 成片的二维分档对比。
// 目的：判断「饱和不足」是集中在高光（提前截断），还是全图性的。
const jpeg = require('jpeg-js');
const fs = require('fs');
const path = require('path');

const SHOT = 'C:/Users/lumos/.workbuddy/clipboard-images/clipboard-2026-11-04T12-51-55-527Z-61c9021d.jpg';
const dir = path.join(__dirname, 'out');

const load = (f) => {
  const j = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
  return { w: j.width, h: j.height, d: j.data };
};

function resize(im, w, h) {
  const out = Buffer.alloc(w * h * 4, 255);
  const sx = im.w / w, sy = im.h / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.min(im.h, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(im.w, Math.max(x0 + 1, Math.ceil((x + 1) * sx)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * im.w * 4;
        for (let xx = x0; xx < x1; xx++) {
          const p = row + xx * 4;
          r += im.d[p]; g += im.d[p + 1]; b += im.d[p + 2]; n++;
        }
      }
      const d = (y * w + x) * 4;
      out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n; out[d + 3] = 255;
    }
  }
  return { w, h, d: out };
}

const raw = load(SHOT);
// 截图内容区：去掉顶部 4 行与最右 1 列 LR 界面
const X0 = 0, X1 = 1663, Y0 = 4, Y1 = 1104;
const W = X1 - X0, H = Y1 - Y0;
const N = { w: W, h: H, d: Buffer.alloc(W * H * 4) };
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const s = ((y + Y0) * raw.w + (x + X0)) * 4, d = (y * W + x) * 4;
    N.d[d] = raw.d[s]; N.d[d + 1] = raw.d[s + 1]; N.d[d + 2] = raw.d[s + 2]; N.d[d + 3] = 255;
  }
}

const O = resize(load(path.join(dir, 't_ours.jpg')), W, H);
const T = resize(load(path.join(dir, 't_target.jpg')), W, H);
const R = resize(load(path.join(dir, 't_lr50.jpg')), W, H);

const L = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const Cc = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);

const LB = [[0, 64], [64, 96], [96, 128], [128, 160], [160, 192], [192, 225], [225, 256]];
const CB = [[0, 10], [10, 25], [25, 45], [45, 70], [70, 300]];

function table(A, B, label) {
  console.log('\n' + label + '  单元格 = ΔL / ΔC   覆盖率');
  const grid = LB.map(() => CB.map(() => ({ n: 0, dl: 0, dc: 0 })));
  let tot = 0;
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    const ar = A.d[p], ag = A.d[p + 1], ab = A.d[p + 2];
    const br = B.d[p], bg = B.d[p + 1], bb = B.d[p + 2];
    const la = L(ar, ag, ab), ca = Cc(ar, ag, ab);
    const li = LB.findIndex(([x, y]) => la >= x && la < y);
    if (li < 0) continue;
    const ci = CB.findIndex(([x, y]) => ca >= x && ca < y);
    if (ci < 0) continue;
    const g = grid[li][ci];
    g.n++; g.dl += L(br, bg, bb) - la; g.dc += Cc(br, bg, bb) - ca; tot++;
  }
  console.log('  亮度\\彩度  ' + CB.map((c) => ('C' + c[0] + '-' + c[1]).padStart(14)).join(''));
  grid.forEach((row, i) => {
    const cells = row.map((c) => {
      if (!c.n) return '             -';
      const dl = c.dl / c.n, dc = c.dc / c.n;
      return (dl >= 0 ? '+' : '') + dl.toFixed(0) + '/' + (dc >= 0 ? '+' : '') + dc.toFixed(0)
        + ' ' + (100 * c.n / tot).toFixed(0) + '%';
    });
    console.log('  L' + String(LB[i][0]).padStart(3) + '-' + String(LB[i][1]).padEnd(4)
      + cells.map((s) => s.padStart(14)).join(''));
  });
}

table(N, O, 'LR → 我们');
table(N, T, 'LR → PS成片');
table(N, R, 'LR → LR tint=50 导出');
