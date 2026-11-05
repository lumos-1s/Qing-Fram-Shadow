// 找「最大色差在哪」：ΔE00 分布 + 最差区块 + 按源色相的 ΔC/Δh。
// 只吃已经落盘的两张图（t_target.jpg / t_ours.jpg），不启 Electron。
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const dir = path.join(__dirname, 'out');
const load = (f) => {
  const j = jpeg.decode(fs.readFileSync(path.join(dir, f)), { useTArray: true, maxMemoryUsageInMB: 4096 });
  const d = new Float32Array(j.width * j.height * 3);
  for (let i = 0, p = 0; i < j.data.length; i += 4, p += 3) {
    d[p] = j.data[i]; d[p + 1] = j.data[i + 1]; d[p + 2] = j.data[i + 2];
  }
  return { w: j.width, h: j.height, d };
};

const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
function lab(r, g, b) {
  const R = f(r), G = f(g), B = f(b);
  let X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  let Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const t = (v) => v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
  return [116 * t(Y) - 16, 500 * (t(X) - t(Y)), 200 * (t(Y) - t(Z))];
}
// ΔE00（CIEDE2000），用于判断"肉眼能不能看出来"
function de00(l1, l2) {
  const [L1, a1, b1] = l1, [L2, a2, b2] = l2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cm, 7) / (Math.pow(Cm, 7) + Math.pow(25, 7))));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h1p = (Math.atan2(b1, a1p) * 180 / Math.PI + 360) % 360;
  const h2p = (Math.atan2(b2, a2p) * 180 / Math.PI + 360) % 360;
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = h2p - h1p;
  if (C1p * C2p === 0) dhp = 0;
  else if (dhp > 180) dhp -= 360;
  else if (dhp < -180) dhp += 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp * Math.PI / 360);
  const Lpm = (L1 + L2) / 2, Cpm = (C1p + C2p) / 2;
  let hpm = (h1p + h2p) / 2;
  if (Math.abs(h1p - h2p) > 180) hpm += 180;
  const T = 1 - 0.17 * Math.cos((hpm - 30) * Math.PI / 180) + 0.24 * Math.cos(2 * hpm * Math.PI / 180)
    + 0.32 * Math.cos((3 * hpm + 6) * Math.PI / 180) - 0.2 * Math.cos((4 * hpm - 63) * Math.PI / 180);
  const SL = 1 + 0.015 * Math.pow(Lpm - 50, 2) / Math.sqrt(20 + Math.pow(Lpm - 50, 2));
  const SC = 1 + 0.045 * Cpm, SH = 1 + 0.015 * Cpm * T;
  const RT = -2 * Math.sqrt(Math.pow(Cpm, 7) / (Math.pow(Cpm, 7) + Math.pow(25, 7)))
    * Math.sin(60 * Math.exp(-Math.pow((hpm - 275) / 25, 2)) * Math.PI / 180);
  return Math.sqrt(Math.pow(dLp / SL, 2) + Math.pow(dCp / SC, 2) + Math.pow(dHp / SH, 2) + RT * (dCp / SC) * (dHp / SH));
}

const T = load('t_target.jpg');
const O = load('t_ours.jpg');
const N = T.w * T.h;

// ① ΔE00 分布
const de = new Float32Array(N);
let sum = 0;
for (let i = 0; i < N; i++) {
  const p = i * 3;
  const v = de00(lab(T.d[p], T.d[p + 1], T.d[p + 2]), lab(O.d[p], O.d[p + 1], O.d[p + 2]));
  de[i] = v; sum += v;
}
const sorted = Array.from(de).sort((a, b) => a - b);
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2);
console.log('ΔE00  均值', (sum / N).toFixed(2), ' P50', q(0.5), ' P90', q(0.9), ' P99', q(0.99), ' max', sorted[sorted.length - 1].toFixed(1));

// ② 最差区块（16×10）
const GX = 16, GY = 10;
const bw = Math.floor(T.w / GX), bh = Math.floor(T.h / GY);
const cells = [];
for (let gy = 0; gy < GY; gy++) {
  for (let gx = 0; gx < GX; gx++) {
    let s = 0, n = 0, tr = 0, tg = 0, tb = 0, or_ = 0, og = 0, ob = 0;
    for (let y = gy * bh; y < (gy + 1) * bh; y += 2) {
      for (let x = gx * bw; x < (gx + 1) * bw; x += 2) {
        const i = y * T.w + x;
        s += de[i]; n++;
        const p = i * 3;
        tr += T.d[p]; tg += T.d[p + 1]; tb += T.d[p + 2];
        or_ += O.d[p]; og += O.d[p + 1]; ob += O.d[p + 2];
      }
    }
    cells.push({ gx, gy, de: s / n, t: [tr / n, tg / n, tb / n].map(Math.round), o: [or_ / n, og / n, ob / n].map(Math.round) });
  }
}
cells.sort((a, b) => b.de - a.de);
console.log('\n最差 8 个区块（ΔE00 均值 / 目标RGB → 我们RGB）');
for (const c of cells.slice(0, 8)) {
  const dR = c.o[0] - c.t[0], dG = c.o[1] - c.t[1], dB = c.o[2] - c.t[2];
  console.log(`  块(${c.gx},${c.gy})  ΔE ${c.de.toFixed(1)}  ${JSON.stringify(c.t)} → ${JSON.stringify(c.o)}  ΔRGB ${dR > 0 ? '+' : ''}${dR}/${dG > 0 ? '+' : ''}${dG}/${dB > 0 ? '+' : ''}${dB}`);
}
console.log('\n最好的 4 个区块');
for (const c of cells.slice(-4)) console.log(`  块(${c.gx},${c.gy})  ΔE ${c.de.toFixed(1)}`);

// ③ 按源图色相分桶（同像素），看色相/彩度偏差
console.log('\n按源色相分桶（同像素）：色相带  占比  源C*  目标C*  我们C*  ΔC*  Δh°');
const bands = [[0, 30], [30, 60], [60, 90], [90, 140], [140, 200], [200, 260], [260, 320], [320, 360]];
const acc = bands.map(() => ({ n: 0, cs: 0, ct: 0, co: 0, ht: 0, ho: 0, wt: 0 }));
for (let i = 0; i < N; i++) {
  const p = i * 3;
  const lg = lab(O.d[p], O.d[p + 1], O.d[p + 2]);
  if (lg[0] < 15 || lg[0] > 245) continue;
  const ls = lab(T.d[p], T.d[p + 1], T.d[p + 2]);
  const C = Math.hypot(ls[1], ls[2]);
  if (C < 8) continue;
  let h = Math.atan2(ls[2], ls[1]) * 180 / Math.PI;
  if (h < 0) h += 360;
  const bi = bands.findIndex((b) => h >= b[0] && h < b[1]);
  if (bi < 0) continue;
  const a = acc[bi];
  a.n++; a.cs += C; a.ct += Math.hypot(ls[1], ls[2]); a.co += Math.hypot(lg[1], lg[2]);
  a.ht += h; a.ho += Math.atan2(lg[2], lg[1]) * 180 / Math.PI;
}
const tot = acc.reduce((s, a) => s + a.n, 0);
acc.forEach((a, i) => {
  if (a.n / tot < 0.01) return;
  console.log(String(bands[i][0] + '-' + bands[i][1]).padEnd(9),
    (100 * a.n / tot).toFixed(1).padStart(5) + '%',
    (a.cs / a.n).toFixed(1).padStart(6), (a.ct / a.n).toFixed(1).padStart(6), (a.co / a.n).toFixed(1).padStart(6),
    ((a.co - a.ct) / a.n).toFixed(1).padStart(6), ((a.ho - a.ht) / a.n).toFixed(1).padStart(6));
});
