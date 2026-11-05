// 把 LR 窗口截图与我们的渲染做几何对齐（缩放+平移），输出对齐后的对比与差异图。
// 截图里的照片区比例与原始 3:2 差 0.8%，未对齐时亮斑/暗边会被错配，统计会失真。
const jpeg = require('jpeg-js');
const fs = require('fs');
const path = require('path');

const SHOT = 'C:/Users/lumos/.workbuddy/clipboard-images/clipboard-2026-11-04T12-51-55-527Z-61c9021d.jpg';
const OUT = path.join(__dirname, 'out');
const load = (f) => {
  const j = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
  return { w: j.width, h: j.height, d: j.data };
};

const raw = load(SHOT);
const X0 = 0, X1 = 1663, Y0 = 4, Y1 = 1104;
const W = X1 - X0, H = Y1 - Y0;
const N = { w: W, h: H, d: Buffer.alloc(W * H * 4) };
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const s = ((y + Y0) * raw.w + (x + X0)) * 4, d = (y * W + x) * 4;
    N.d[d] = raw.d[s]; N.d[d + 1] = raw.d[s + 1]; N.d[d + 2] = raw.d[s + 2]; N.d[d + 3] = 255;
  }
}

// 灰度 + 降采样到 GW 宽
function grayDown(im, gw) {
  const gh = Math.max(1, Math.round(gw * im.h / im.w));
  const out = new Float32Array(gw * gh);
  const sx = im.w / gw, sy = im.h / gh;
  for (let y = 0; y < gh; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.min(im.h, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < gw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(im.w, Math.max(x0 + 1, Math.ceil((x + 1) * sx)));
      let s = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const p = (yy * im.w + xx) * 4;
          s += 0.2126 * im.d[p] + 0.7152 * im.d[p + 1] + 0.0722 * im.d[p + 2]; n++;
        }
      }
      out[y * gw + x] = s / n;
    }
  }
  return { w: gw, h: gh, d: out };
}

const oursFull = load(path.join(OUT, 't_ours.jpg'));
const GW = 200;
const NG = grayDown(N, GW);
const OG = grayDown(oursFull, GW);

// 模型：截图坐标 (u,v) 归一化到 [0,1]，映射到我们图像的归一化坐标
//   x = cx + (u - 0.5) * sx ; y = cy + (v - 0.5) * sy
function score(cx, cy, sx, sy) {
  let e = 0, n = 0;
  for (let y = 0; y < NG.h; y++) {
    const gn = (y + 0.5) / NG.h;
    const vy = (cy + (gn - 0.5) * sy) * OG.h - 0.5;
    const y0 = Math.max(0, Math.min(OG.h - 2, Math.floor(vy)));
    const fy = Math.max(0, Math.min(1, vy - y0));
    for (let x = 0; x < NG.w; x++) {
      const gx = (x + 0.5) / NG.w;
      const vx = (cx + (gx - 0.5) * sx) * OG.w - 0.5;
      if (vx < 0 || vx > OG.w - 2) { n++; e += 60; continue; }
      const x0 = Math.floor(vx), fx = vx - x0;
      const a = OG.d[y0 * OG.w + x0] * (1 - fx) + OG.d[y0 * OG.w + x0 + 1] * fx;
      const b = OG.d[(y0 + 1) * OG.w + x0] * (1 - fx) + OG.d[(y0 + 1) * OG.w + x0 + 1] * fx;
      const v = a * (1 - fy) + b * fy;
      e += Math.abs(v - NG.d[y * NG.w + x]); n++;
    }
  }
  return e / n;
}

let best = { cx: 0.5, cy: 0.5, sx: 1, sy: 1, e: 1e9 };
// 阶段一：粗搜
for (let sx = 0.975; sx <= 1.0001; sx += 0.005) {
  for (let sy = 0.975; sy <= 1.0001; sy += 0.005) {
    for (let cx = 0.485; cx <= 0.5151; cx += 0.01) {
      for (let cy = 0.485; cy <= 0.5151; cy += 0.01) {
        const e = score(cx, cy, sx, sy);
        if (e < best.e) best = { cx, cy, sx, sy, e };
      }
    }
  }
}
// 阶段二：细化
let step = 0.005;
for (let it = 0; it < 4; it++) {
  const b = { ...best };
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dsx = -1; dsx <= 1; dsx++) {
        for (let dsy = -1; dsy <= 1; dsy++) {
          const c = { cx: b.cx + dx * step * 0.5, cy: b.cy + dy * step * 0.5, sx: b.sx + dsx * step, sy: b.sy + dsy * step };
          const e = score(c.cx, c.cy, c.sx, c.sy);
          if (e < best.e) best = { ...c, e };
        }
      }
    }
  }
  step /= 2;
}
console.log('对齐参数 cx', best.cx.toFixed(4), 'cy', best.cy.toFixed(4), 'sx', best.sx.toFixed(4), 'sy', best.sy.toFixed(4), 'MAE', best.e.toFixed(2));

// 用最优变换重采样我们的渲染到截图尺寸，落盘供后续统计/出图
function warp(im, cx, cy, sx, sy, w, h) {
  const out = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++) {
    const gn = (y + 0.5) / h;
    const vy = (cy + (gn - 0.5) * sy) * im.h - 0.5;
    const y0 = Math.max(0, Math.min(im.h - 2, Math.floor(vy)));
    const fy = Math.max(0, Math.min(1, vy - y0));
    for (let x = 0; x < w; x++) {
      const gx = (x + 0.5) / w;
      const vx = (cx + (gx - 0.5) * sx) * im.w - 0.5;
      const x0 = Math.max(0, Math.min(im.w - 2, Math.floor(vx)));
      const fx = Math.max(0, Math.min(1, vx - x0));
      const p00 = (y0 * im.w + x0) * 4, p10 = (y0 * im.w + x0 + 1) * 4;
      const p01 = ((y0 + 1) * im.w + x0) * 4, p11 = ((y0 + 1) * im.w + x0 + 1) * 4;
      const d = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        const a = im.d[p00 + k] * (1 - fx) + im.d[p10 + k] * fx;
        const b = im.d[p01 + k] * (1 - fx) + im.d[p11 + k] * fx;
        out[d + k] = a * (1 - fy) + b * fy;
      }
      out[d + 3] = 255;
    }
  }
  return { w, h, d: out };
}

const warped = warp(oursFull, best.cx, best.cy, best.sx, best.sy, W, H);
fs.writeFileSync(path.join(OUT, 'shot_ours.jpg'), jpeg.encode({ data: warped.d, width: W, height: H }, 95).data);
// 把截图内容区也存一份，便于并排
fs.writeFileSync(path.join(OUT, 'shot_lr.jpg'), jpeg.encode({ data: N.d, width: W, height: H }, 95).data);
console.log('落盘 shot_ours.jpg / shot_lr.jpg', W + 'x' + H);

// 对齐后逐像素差（按 LR 亮度分带）
const bands = [[0, 48], [48, 96], [96, 144], [144, 192], [192, 256]];
const acc = bands.map(() => ({ n: 0, dl: 0, abs: 0, dr: 0, dg: 0, db: 0 }));
let absAll = 0, nAll = 0;
for (let i = 0; i < W * H; i++) {
  const p = i * 4;
  const ar = N.d[p], ag = N.d[p + 1], ab = N.d[p + 2];
  const br = warped.d[p], bg = warped.d[p + 1], bb = warped.d[p + 2];
  const la = 0.2126 * ar + 0.7152 * ag + 0.0722 * ab;
  const lb = 0.2126 * br + 0.7152 * bg + 0.0722 * bb;
  const k = bands.findIndex(([x, y]) => la >= x && la < y);
  const d = lb - la;
  absAll += Math.abs(d); nAll++;
  if (k < 0) continue;
  const c = acc[k];
  c.n++; c.dl += d; c.abs += Math.abs(d); c.dr += br - ar; c.dg += bg - ag; c.db += bb - ab;
}
console.log('\n对齐后（我们 − LR），按 LR 亮度分带');
for (let k = 0; k < bands.length; k++) {
  const c = acc[k];
  if (!c.n) continue;
  console.log('  L' + String(bands[k][0]).padStart(3) + '-' + String(bands[k][1]).padEnd(3),
    String((100 * c.n / nAll).toFixed(1) + '%').padStart(6),
    'ΔL', (c.dl / c.n).toFixed(1).padStart(6),
    '|Δ|', (c.abs / c.n).toFixed(1).padStart(5),
    'ΔRGB', [c.dr / c.n, c.dg / c.n, c.db / c.n].map((v) => v.toFixed(1)).join(','));
}
console.log('  全图 |ΔL|', (absAll / nAll).toFixed(2));
