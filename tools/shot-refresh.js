// 用固定几何变换把当前的 t_ours.jpg 贴到截图坐标，输出分带残差与黄色带色相差。
// 参数改动后跑这一支即可，不必重跑对齐搜索。
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
const CX = 0.4997, CY = 0.4953, SX = 0.9987, SY = 0.9919;

function warp(im) {
  const out = { w: W, h: H, d: Buffer.alloc(W * H * 4, 255) };
  for (let y = 0; y < H; y++) {
    const gn = (y + 0.5) / H;
    const vy = (CY + (gn - 0.5) * SY) * im.h - 0.5;
    const y0 = Math.max(0, Math.min(im.h - 2, Math.floor(vy)));
    const fy = Math.max(0, Math.min(1, vy - y0));
    for (let x = 0; x < W; x++) {
      const gx = (x + 0.5) / W;
      const vx = (CX + (gx - 0.5) * SX) * im.w - 0.5;
      const x0 = Math.max(0, Math.min(im.w - 2, Math.floor(vx)));
      const fx = Math.max(0, Math.min(1, vx - x0));
      const p00 = (y0 * im.w + x0) * 4, p10 = (y0 * im.w + x0 + 1) * 4;
      const p01 = ((y0 + 1) * im.w + x0) * 4, p11 = ((y0 + 1) * im.w + x0 + 1) * 4;
      const d = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) {
        const a = im.d[p00 + k] * (1 - fx) + im.d[p10 + k] * fx;
        const b = im.d[p01 + k] * (1 - fx) + im.d[p11 + k] * fx;
        out.d[d + k] = a * (1 - fy) + b * fy;
      }
      out.d[d + 3] = 255;
    }
  }
  return out;
}

const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
function lab(r, g, b) {
  const R = f(r), G = f(g), B2 = f(b);
  let X = (0.4124 * R + 0.3576 * G + 0.1805 * B2) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B2;
  let Z = (0.0193 * R + 0.1192 * G + 0.9505 * B2) / 1.08883;
  const t = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  X = t(X); Z = t(Z); const Y2 = t(Y);
  return [116 * Y2 - 16, 500 * (X - Y2), 200 * (Y2 - Z)];
}

const B = warp(load(path.join(OUT, 't_ours.jpg')));
fs.writeFileSync(path.join(OUT, 'shot_ours.jpg'), jpeg.encode({ data: B.d, width: W, height: H }, 95).data);

const bands = [[0, 48], [48, 96], [96, 144], [144, 192], [192, 256]];
const acc = bands.map(() => ({ n: 0, dl: 0, abs: 0, dr: 0, dg: 0, db: 0 }));
let absAll = 0, nAll = 0;
let yh = 0, yc = 0, yn = 0, oa = 0, ob = 0, oL = 0, on = 0;
for (let i = 0; i < W * H; i++) {
  const p = i * 4;
  const ar = A.d[p], ag = A.d[p + 1], ab = A.d[p + 2];
  const br = B.d[p], bg = B.d[p + 1], bb = B.d[p + 2];
  const la = 0.2126 * ar + 0.7152 * ag + 0.0722 * ab;
  const lb = 0.2126 * br + 0.7152 * bg + 0.0722 * bb;
  const k = bands.findIndex(([x, y]) => la >= x && la < y);
  absAll += Math.abs(lb - la); nAll++;
  if (k >= 0) {
    const c = acc[k];
    c.n++; c.dl += lb - la; c.abs += Math.abs(lb - la);
    c.dr += br - ar; c.dg += bg - ag; c.db += bb - ab;
  }
  const ta = lab(ar, ag, ab);
  if (ta[0] > 20 && ta[0] < 240 && Math.hypot(ta[1], ta[2]) > 12) {
    let ha = Math.atan2(ta[2], ta[1]) * 180 / Math.PI; if (ha < 0) ha += 360;
    if (ha >= 70 && ha < 100) {
      const tb = lab(br, bg, bb);
      let hb = Math.atan2(tb[2], tb[1]) * 180 / Math.PI;
      let d = hb - (ha > 180 ? ha - 360 : ha);
      while (d > 180) d -= 360; while (d < -180) d += 360;
      yh += d; yc += Math.hypot(tb[1], tb[2]) - Math.hypot(ta[1], ta[2]);
      oa += tb[1] - ta[1]; ob += tb[2] - ta[2]; oL += tb[0] - ta[0]; yn++;
    }
  }
}
console.log('我们 − LR截图，按 LR 亮度分带');
for (let k = 0; k < bands.length; k++) {
  const c = acc[k];
  if (!c.n) continue;
  console.log('  L' + String(bands[k][0]).padStart(3) + '-' + String(bands[k][1]).padEnd(3),
    String((100 * c.n / nAll).toFixed(1) + '%').padStart(6),
    'ΔL', (c.dl / c.n).toFixed(1).padStart(6), '|Δ|', (c.abs / c.n).toFixed(1).padStart(5),
    'ΔRGB', [c.dr, c.dg, c.db].map((v) => (v / c.n).toFixed(1)).join(','));
}
console.log('  全图 |ΔL|', (absAll / nAll).toFixed(2));
console.log('\n黄色带（LR 色相 70-100°，占', (100 * yn / (W * H)).toFixed(1) + '%）');
console.log('  Δh', (yh / yn).toFixed(1) + '°', ' ΔC*', (yc / yn).toFixed(1),
  ' ΔL*', (oL / yn).toFixed(1), ' Δa*', (oa / yn).toFixed(1), ' Δb*', (ob / yn).toFixed(1));
