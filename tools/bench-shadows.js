// 纯 JS 阴影 pass 的耗时基准：1600px 预览与全尺寸各跑一次
const W = 1600, H = 1067;
const N = W * H;
const px = new Uint8ClampedArray(N * 4);
for (let i = 0; i < N; i++) {
  const v = (i * 37 + (i >> 7) * 11) & 255;
  px[i * 4] = v; px[i * 4 + 1] = (v * 0.9) | 0; px[i * 4 + 2] = (v * 0.8) | 0; px[i * 4 + 3] = 255;
}

const dec = new Float64Array(256);
for (let i = 0; i < 256; i++) { const e = i / 255; dec[i] = e <= 0.04045 ? e / 12.92 : Math.pow((e + 0.055) / 1.055, 2.4); }
// 增益表：256 级输入 × 65 档 lift
const LIFT_LO = -1.2, LIFT_HI = 1.2, LIFT_N = 65;
const tab = new Uint8Array(256 * LIFT_N);
for (let j = 0; j < LIFT_N; j++) {
  const g = Math.pow(2, LIFT_LO + (LIFT_HI - LIFT_LO) * j / (LIFT_N - 1));
  for (let i = 0; i < 256; i++) {
    const l = dec[i] * g;
    const e = l <= 0 ? 0 : l >= 1 ? 1 : (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
    tab[j * 256 + i] = Math.round(e * 255);
  }
}

// 假 field：384×256 的 a/b
const lw = 384, lh = Math.max(1, Math.round(H / (W / 384)));
const fa = new Float32Array(lw * lh).fill(0.8);
const fb = new Float32Array(lw * lh).fill(-1.5);
const scaleX = W / lw, scaleY = H / lh;

function run() {
  const t0 = performance.now();
  const kStep = (LIFT_HI - LIFT_LO) / (LIFT_N - 1);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(lh - 1, Math.max(0, (y + 0.5) / scaleY - 0.5));
    const y0 = fy | 0, y1 = y0 + 1 < lh ? y0 + 1 : y0, ty = fy - y0;
    const rowA = y0 * lw, rowB = y1 * lw;
    let p = y * W * 4;
    for (let x = 0; x < W; x++, p += 4) {
      const r = dec[px[p]], g = dec[px[p + 1]], b = dec[px[p + 2]];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const level = Math.log2(lum < 1.220703125e-4 ? 1.220703125e-4 : lum);
      const fx = Math.min(lw - 1, Math.max(0, (x + 0.5) / scaleX - 0.5));
      const x0 = fx | 0, x1 = x0 + 1 < lw ? x0 + 1 : x0, tx = fx - x0;
      const sa = (fa[rowA + x0] * (1 - tx) + fa[rowA + x1] * tx) * (1 - ty) + (fa[rowB + x0] * (1 - tx) + fa[rowB + x1] * tx) * ty;
      const sb = (fb[rowA + x0] * (1 - tx) + fb[rowA + x1] * tx) * (1 - ty) + (fb[rowB + x0] * (1 - tx) + fb[rowB + x1] * tx) * ty;
      const region = sa * level + sb;
      const detail = level - region;
      const lift = 0.1 + 0.3 * (detail > 0 ? detail : 0) + 0.2 * (detail < 0 ? detail : 0);
      let jf = (lift - LIFT_LO) / kStep;
      jf = jf < 0 ? 0 : jf > LIFT_N - 1 ? LIFT_N - 1 : jf;
      const j0 = jf | 0, j1 = j0 + 1 < LIFT_N ? j0 + 1 : j0, jt = jf - j0;
      const o0 = j0 * 256, o1 = j1 * 256;
      px[p] = tab[o0 + px[p]] * (1 - jt) + tab[o1 + px[p]] * jt;
      px[p + 1] = tab[o0 + px[p + 1]] * (1 - jt) + tab[o1 + px[p + 1]] * jt;
      px[p + 2] = tab[o0 + px[p + 2]] * (1 - jt) + tab[o1 + px[p + 2]] * jt;
    }
  }
  return performance.now() - t0;
}

run(); run();
console.log('1600px:', run().toFixed(1), 'ms  (', N, 'px )');
