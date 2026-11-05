// 关键实验：ACR 的色调 stage 是 17³ 三维表，我们现在只取了「灰轴对角线」当逐通道曲线用。
// 对彩色像素，这两种做法给出不同的彩度。这个脚本把两条路都算出来，直接对比。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const raw = fs.readFileSync(path.join(ROOT, 'shared', 'acr', 'cr-tables.bin'));
const SIZE = raw.readUInt16LE(4), COUNT = raw.readUInt16LE(6), STEP = raw.readUInt16LE(8);
const src = new Uint8Array(zlib.inflateSync(raw.slice(10)));
const cells = SIZE * SIZE * SIZE, entries = cells * 3;
const data = new Float32Array(COUNT * entries);
{
  const level = [];
  for (let i = 0; i < SIZE; i++) level.push(Math.round(i * 255 / (SIZE - 1)));
  for (let t = 0; t < COUNT; t++) {
    for (let ch = 0; ch < 3; ch++) {
      const base = (t * 3 + ch) * cells;
      let run = 0;
      for (let cell = 0; cell < cells; cell++) {
        run += (src[base + cell] << 24) >> 24;
        const axis = ch === 0 ? (cell / (SIZE * SIZE)) | 0
          : ch === 1 ? ((cell / SIZE) | 0) % SIZE : cell % SIZE;
        let v = level[axis] + run * STEP;
        data[t * entries + cell * 3 + ch] = v < 0 ? 0 : (v > 255 ? 255 : v);
      }
    }
  }
}
console.log('表:', { SIZE, COUNT, STEP });

// 表区（与 app-acr.js 一致）
const START = { expo: 81, whites: 102, blacks: 111, sat: 120, vib: 129, con: 138, hi: 187, sh: 236 };
const BRIGHT = [53, 80, 104, 130, 160, 190, 224];
const AVAL = [-100, -50, -25, 0, 25, 50, 100];

const betweenPts = (v, pts) => {
  v = Math.min(pts[pts.length - 1], Math.max(pts[0], v));
  let i = 0;
  while (i < pts.length - 2 && v > pts[i + 1]) i++;
  return [i, (v - pts[i]) / (pts[i + 1] - pts[i])];
};
const span = (v, low, step, n) => {
  const pos = Math.min(n - 1, Math.max(0, (v - low) / step));
  const i = Math.min(n - 2, Math.floor(pos));
  return [i, pos - i];
};
const adaptive = (start, value, bright) => {
  const [row, down] = betweenPts(bright, BRIGHT);
  const [col, across] = betweenPts(value, AVAL);
  const w = AVAL.length, base = start + row * w + col;
  return [[base, (1 - down) * (1 - across)], [base + 1, (1 - down) * across],
    [base + w, down * (1 - across)], [base + w + 1, down * across]];
};
const plain = (start, v) => {
  const [i, f] = span(v, -100, 25, 9);
  return [[start + i, 1 - f], [start + i + 1, f]];
};
const exposure = (ev) => {
  const [i, f] = span(ev, -5, 0.5, 21);
  return [[START.expo + i, 1 - f], [START.expo + i + 1, f]];
};

// 三线性采样一张 stage 的合成表
function sample3d(parts, r, g, b) {
  const S = SIZE - 1;
  const x = Math.min(S, Math.max(0, r * S / 255)), y = Math.min(S, Math.max(0, g * S / 255)), z = Math.min(S, Math.max(0, b * S / 255));
  const i0 = Math.min(S - 1, Math.floor(x)), j0 = Math.min(S - 1, Math.floor(y)), k0 = Math.min(S - 1, Math.floor(z));
  const fx = x - i0, fy = y - j0, fz = z - k0;
  const out = [0, 0, 0];
  for (const [off, w] of parts) {
    if (!w) continue;
    const base = off * entries;
    for (let ch = 0; ch < 3; ch++) {
      const at = (ii, jj, kk) => data[base + ((ii * SIZE + jj) * SIZE + kk) * 3 + ch];
      const c00 = at(i0, j0, k0) * (1 - fx) + at(i0 + 1, j0, k0) * fx;
      const c10 = at(i0, j0 + 1, k0) * (1 - fx) + at(i0 + 1, j0 + 1, k0) * fx;
      const c01 = at(i0, j0, k0 + 1) * (1 - fx) + at(i0 + 1, j0, k0 + 1) * fx;
      const c11 = at(i0, j0 + 1, k0 + 1) * (1 - fx) + at(i0 + 1, j0 + 1, k0 + 1) * fx;
      const c0 = c00 * (1 - fy) + c10 * fy, c1 = c01 * (1 - fy) + c11 * fy;
      out[ch] += w * (c0 * (1 - fz) + c1 * fz);
    }
  }
  return out;
}

// 灰轴对角线（我们现在的做法）：输入 v → 输出
function diag(parts, v) {
  const o = sample3d(parts, v, v, v);
  return (o[0] + o[1] + o[2]) / 3;
}

const srgb = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const labF = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
function lab(r, g, b) {
  const R = srgb(r), G = srgb(g), Bl = srgb(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * Bl) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * Bl;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * Bl) / 1.08883;
  const fx = labF(X), fy = labF(Y), fz = labF(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const chroma = (c) => Math.hypot(c[1], c[2]);

const stages = [
  ['exposure', exposure(0.56)],
  ['contrast', adaptive(START.con, 20, 128)],
  ['highlights', adaptive(START.hi, -100, 222)],
  ['whites', plain(START.whites, 23)],
  ['blacks', plain(START.blacks, 26)]
];

// 逐通道对角线合成（等价于 app 里的 composeDiags）
function applyDiag(v, level) {
  let o = v;
  for (const [, parts] of stages) {
    const d = diag(parts, o);
    o = d;
  }
  return o;
}

const tests = [
  ['黄叶(200,170,70)', 200, 170, 70],
  ['黄绿(160,150,70)', 160, 150, 70],
  ['深绿(90,110,60)', 90, 110, 60],
  ['暖墙(190,150,120)', 190, 150, 120],
  ['中灰(128,128,128)', 128, 128, 128],
  ['暗部(55,50,45)', 55, 50, 45]
];

console.log('\n输入                 3D 合成(真实)            对角线(我们)        C* 变化');
for (const [name, r, g, b] of tests) {
  let R = r, G = g, B = b;
  for (const [, parts] of stages) {
    const o = sample3d(parts, R, G, B);
    R = o[0]; G = o[1]; B = o[2];
  }
  const out3d = [R, G, B];
  const outDiag = [applyDiag(r, 0), applyDiag(g, 0), applyDiag(b, 0)];
  const c0 = chroma(lab(r, g, b)), c3 = chroma(lab(...out3d)), cd = chroma(lab(...outDiag));
  console.log(name.padEnd(18),
    out3d.map((v) => v.toFixed(0)).join(',').padEnd(22),
    outDiag.map((v) => v.toFixed(0)).join(',').padEnd(16),
    `${c0.toFixed(1)} → 3D ${c3.toFixed(1)} / 对角 ${cd.toFixed(1)}  (${((cd / c3 - 1) * 100).toFixed(0)}%)`);
}
