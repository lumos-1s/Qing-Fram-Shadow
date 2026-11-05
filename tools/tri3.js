// 三联图：LR 截图 | 本次修改前 | 修改后。
// 「修改前」不用重渲：通道平衡是一条已知曲线，逐像素反解回去就是原样
// （before = sRGB(linear(after)/g)），比再跑一遍 Electron 稳。
const jpeg = require('jpeg-js');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const load = (f) => {
  const j = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
  return { w: j.width, h: j.height, d: j.data };
};
const A = load(path.join(OUT, 'shot_lr.jpg'));
const B = load(path.join(OUT, 't_ours.jpg'));
const W = A.w, H = A.h;
const CX = 0.4997, CY = 0.4953, SX = 0.9987, SY = 0.9919;
const BAL = [1.034, 1.095, 1.0];

function warp(im) {
  const st = im.d.length >= im.w * im.h * 4 ? 4 : 3;
  const out = { w: W, h: H, d: Buffer.alloc(W * H * 3, 255) };
  for (let y = 0; y < H; y++) {
    const vy = (CY + ((y + 0.5) / H - 0.5) * SY) * im.h - 0.5;
    const y0 = Math.max(0, Math.min(im.h - 2, Math.floor(vy)));
    const fy = Math.max(0, Math.min(1, vy - y0));
    for (let x = 0; x < W; x++) {
      const vx = (CX + ((x + 0.5) / W - 0.5) * SX) * im.w - 0.5;
      const x0 = Math.max(0, Math.min(im.w - 2, Math.floor(vx)));
      const fx = Math.max(0, Math.min(1, vx - x0));
      const p00 = (y0 * im.w + x0) * st, p10 = (y0 * im.w + x0 + 1) * st;
      const p01 = ((y0 + 1) * im.w + x0) * st, p11 = ((y0 + 1) * im.w + x0 + 1) * st;
      const d = (y * W + x) * 3;
      for (let k = 0; k < 3; k++) {
        const a = im.d[p00 + k] * (1 - fx) + im.d[p10 + k] * fx;
        const b = im.d[p01 + k] * (1 - fx) + im.d[p11 + k] * fx;
        out.d[d + k] = a * (1 - fy) + b * fy;
      }
    }
  }
  return out;
}

const s2l = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const l2s = (v) => { v = Math.max(0, Math.min(1, v)); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055); };

const after = warp(B);
const before = { w: W, h: H, d: Buffer.alloc(W * H * 3, 255) };
for (let i = 0; i < W * H; i++) {
  for (let k = 0; k < 3; k++) before.d[i * 3 + k] = l2s(s2l(after.d[i * 3 + k]) / BAL[k]);
}

// 三联：同一块叶子区域，放大 2 倍
function tri(name, nx, ny, nw, nh, zoom) {
  const x0 = Math.round(nx * W), y0 = Math.round(ny * H);
  const w0 = Math.round(nw * W), h0 = Math.round(nh * H);
  const w = w0 * zoom, h = h0 * zoom;
  const gap = 6;
  const tw = w * 3 + gap * 2;
  const buf = Buffer.alloc(tw * h * 4, 255);
  const panels = [
    (x, y) => { const p = ((y0 + y) * W + x0 + x) * 4; return [A.d[p], A.d[p + 1], A.d[p + 2]]; },
    (x, y) => { const p = ((y0 + y) * W + x0 + x) * 3; return [before.d[p], before.d[p + 1], before.d[p + 2]]; },
    (x, y) => { const p = ((y0 + y) * W + x0 + x) * 3; return [after.d[p], after.d[p + 1], after.d[p + 2]]; },
  ];
  for (let pi = 0; pi < 3; pi++) {
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const c = panels[pi](Math.min(w0 - 1, (xx / zoom) | 0), Math.min(h0 - 1, (yy / zoom) | 0));
        const o = (yy * tw + pi * (w + gap) + xx) * 4;
        buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2];
      }
    }
  }
  fs.writeFileSync(path.join(OUT, name), jpeg.encode({ data: buf, width: tw, height: h }, 92).data);
  console.log('落盘', name, tw + 'x' + h);
}

tri('tri3_leaves.jpg', 0.40, 0.055, 0.13, 0.075, 2);
tri('tri3_wall.jpg', 0.09, 0.33, 0.10, 0.065, 2);
