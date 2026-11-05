// 逐像素拟合：判断"软件渲染"与"你的导出图"之间是全局曲线差还是局部算法差
const fs = require('fs');
const jpeg = require('jpeg-js');

const W = 900, H = 600;

function load(p, outW = W, outH = H) {
  const img = jpeg.decode(fs.readFileSync(p), { useTArray: true, maxMemoryUsageInMB: 4096 });
  const { width: w, height: h, data: d } = img;
  const out = new Uint8Array(outW * outH * 3);
  const sx = w / outW, sy = h / outH;
  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.min(h, Math.floor((y + 1) * sy));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(w, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * w + xx) * 4;
          r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
        }
      }
      const o = (y * outW + x) * 3;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return out;
}

const mine = load('tools/out/mine_900.jpg');
const user = load('C:/Users/lumos/Desktop/ps修后图片/DSC09381_边框.jpg');
const lr = load('C:/Users/lumos/Desktop/未命名导出/DSC09381.jpg');

// 逐通道：以 mine 的值分箱，看 user 的均值 → 若是单调曲线则是全局色调差
function channelMap(a, b, ch) {
  const bins = Array.from({ length: 16 }, () => ({ sa: 0, sb: 0, n: 0 }));
  for (let i = 0; i < a.length; i += 3) {
    const va = a[i + ch], vb = b[i + ch];
    const k = Math.min(15, va >> 4);
    bins[k].sa += va; bins[k].sb += vb; bins[k].n++;
  }
  return bins.filter(x => x.n > 200).map(x => [Math.round(x.sa / x.n), Math.round(x.sb / x.n)]);
}

const names = ['R', 'G', 'B'];
console.log('=== 我渲染的值 → 你导出图的值（每 16 级一个点）===');
for (let ch = 0; ch < 3; ch++) {
  console.log(names[ch] + ': ' + channelMap(mine, user, ch).map(p => p[0] + '→' + p[1]).join('  '));
}

// 残差与局部对比度的相关性：>0.3 说明局部算子（清晰度/高光阴影）差异显著
function localContrast(a) {
  const out = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 3;
      const c = a[i] * 0.2126 + a[i + 1] * 0.7152 + a[i + 2] * 0.0722;
      const l = a[i - 3] * 0.2126 + a[i - 2] * 0.7152 + a[i - 1] * 0.0722;
      const r = a[i + 3] * 0.2126 + a[i + 4] * 0.7152 + a[i + 5] * 0.0722;
      out[y * W + x] = Math.abs(c - (l + r) / 2);
    }
  }
  return out;
}
function corr(x, y) {
  let sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0, n = 0;
  for (let i = 0; i < x.length; i++) {
    if (!x[i] && !y[i]) continue;
    sx += x[i]; sy += y[i]; sxy += x[i] * y[i]; sxx += x[i] * x[i]; syy += y[i] * y[i]; n++;
  }
  const mx = sx / n, my = sy / n;
  return ((sxy / n) - mx * my) / Math.sqrt(((sxx / n) - mx * mx) * ((syy / n) - my * my));
}

const lum = (a) => { const o = new Float32Array(W * H); for (let i = 0; i < W * H; i++) o[i] = a[i * 3] * 0.2126 + a[i * 3 + 1] * 0.7152 + a[i * 3 + 2] * 0.0722; return o; };
const lm = lum(mine), lu = lum(user), ll = lum(lr);
const resid = new Float32Array(W * H).map((_, i) => lu[i] - lm[i]);
const lrResid = new Float32Array(W * H).map((_, i) => lu[i] - ll[i]);
const lc = localContrast(mine);

console.log('\n=== 局部差异相关性 ===');
console.log('残差(你导出 − 我渲染) vs 局部对比度:', corr(resid, lc).toFixed(3));
console.log('残差(你导出 − LR)     vs 局部对比度:', corr(lrResid, lc).toFixed(3));

// 直接对比我渲染 vs LR，看谁的算法更像 LR
console.log('\n=== 我渲染 vs LR ===');
for (let ch = 0; ch < 3; ch++) {
  console.log(names[ch] + ': ' + channelMap(mine, lr, ch).map(p => p[0] + '→' + p[1]).join('  '));
}
console.log('残差(我渲染 − LR) vs 局部对比度:', corr(new Float32Array(W * H).map((_, i) => lm[i] - ll[i]), lc).toFixed(3));
