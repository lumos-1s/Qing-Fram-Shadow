// 诊断扫描：在渲染结果上乘一个逐通道增益（线性光），看能把「对截图的色相差」压到多少。
// 只用于判断方向与量级，不落盘。
const jpeg = require('jpeg-js');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const load = (f) => {
  const j = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
  return { w: j.width, h: j.height, d: j.data };
};
const A = load(path.join(OUT, 'shot_lr.jpg'));
const B = load(path.join(OUT, 'shot_ours.jpg'));
const W = A.w, H = A.h;

const s2l = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const l2s = (v) => { v = Math.max(0, Math.min(1, v)); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055); };
const f = (v) => s2l(v);
function lab(r, g, b) {
  const R = f(r), G = f(g), B2 = f(b);
  let X = (0.4124 * R + 0.3576 * G + 0.1805 * B2) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B2;
  let Z = (0.0193 * R + 0.1192 * G + 0.9505 * B2) / 1.08883;
  const t = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  X = t(X); Z = t(Z); const Y2 = t(Y);
  return [116 * Y2 - 16, 500 * (X - Y2), 200 * (Y2 - Z)];
}

function score(gr, gg, gb) {
  let dE = 0, n = 0, dh = 0, dC = 0, ny = 0, dL = 0, dW = 0, nw = 0;
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    const ar = A.d[p], ag = A.d[p + 1], ab = A.d[p + 2];
    const br = l2s(s2l(B.d[p]) * gr), bg = l2s(s2l(B.d[p + 1]) * gg), bb = l2s(s2l(B.d[p + 2]) * gb);
    const la = lab(ar, ag, ab), lb = lab(br, bg, bb);
    dE += Math.hypot(lb[0] - la[0], lb[1] - la[1], lb[2] - la[2]); dL += lb[0] - la[0]; n++;
    const Ca = Math.hypot(la[1], la[2]);
    if (la[0] > 20 && la[0] < 240 && Ca > 12) {
      let ha = Math.atan2(la[2], la[1]) * 180 / Math.PI; if (ha < 0) ha += 360;
      if (ha >= 70 && ha < 100) {
        let hb = Math.atan2(lb[2], lb[1]) * 180 / Math.PI;
        let d = hb - (ha > 180 ? ha - 360 : ha);
        while (d > 180) d -= 360; while (d < -180) d += 360;
        dh += d; dC += Math.hypot(lb[1], lb[2]) - Ca; ny++;
      }
    }
    if (Ca < 8 && la[0] > 30) { dW += Math.hypot(lb[1], lb[2]) - Ca; nw++; }
  }
  return { dE: dE / n, dL: dL / n, dh: dh / ny, dC: dC / ny, dW: nw ? dW / nw : 0 };
}

const base = score(1, 1, 1);
console.log('基准（无校正）        ΔE', base.dE.toFixed(2), ' ΔL', base.dL.toFixed(1),
  ' 黄带Δh', base.dh.toFixed(1) + '°', ' 黄带ΔC', base.dC.toFixed(1), ' 中性区ΔC', base.dW.toFixed(1));
console.log('\n   G增益  B增益     ΔE      ΔL   黄带Δh   黄带ΔC  中性ΔC');
const rows = [];
for (const gg of [1.0, 1.03, 1.06, 1.09, 1.12]) {
  for (const gb of [1.0, 0.96, 0.92]) {
    const s = score(1, gg, gb);
    rows.push({ gg, gb, ...s });
    console.log('  ' + gg.toFixed(2).padStart(6) + gb.toFixed(2).padStart(7)
      + s.dE.toFixed(2).padStart(8) + s.dL.toFixed(1).padStart(7)
      + s.dh.toFixed(1).padStart(8) + s.dC.toFixed(1).padStart(9) + s.dW.toFixed(1).padStart(8));
  }
}
const best = rows.slice().sort((a, b) => a.dE - b.dE)[0];
console.log('\nΔE 最优：G×' + best.gg + ' B×' + best.gb, ' ΔE', best.dE.toFixed(2),
  ' 黄带Δh', best.dh.toFixed(1) + '°');
