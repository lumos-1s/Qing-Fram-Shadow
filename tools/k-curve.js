// 直接测「需要乘多少」：逐像素取我们与 LR 的线性亮度，按我们的 Y 分箱，取比值中位数。
// 得到一条 k(Y) 曲线——这就是色调链还缺的那一段（比按色带比均值可靠，不会被
// 部分截断的像素带偏）。
const fs = require('fs');
const jpeg = require('jpeg-js');

const load = (f) => {
    const j = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
    return { w: j.width, h: j.height, d: j.data };
};
const A = load('tools/out/full_ours.jpg');
const B = load('C:/Users/lumos/Desktop/未命名导出/tint=50.jpg');
const s2l = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const Y = (im, p) => 0.2126 * s2l(im.d[p]) + 0.7152 * s2l(im.d[p + 1]) + 0.0722 * s2l(im.d[p + 2]);

const N = 500, BINS = 20;
const bins = Array.from({ length: BINS }, () => []);
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = Math.floor((i + 0.5) * A.w / N), y = Math.floor((j + 0.5) * A.h / N);
    const pa = (y * A.w + x) * 4, pb = (y * B.w + x) * 4;
    const ya = Y(A, pa), yb = Y(B, pb);
    if (ya < 1e-4) continue;
    const bi = Math.min(BINS - 1, Math.floor(Math.pow(ya, 1 / 2.2) * BINS));
    bins[bi].push([ya, yb / ya]);
}
console.log('Y 分箱（按我们的亮度）  点的比例  需要乘 k 的中位数   百分位 25/75');
const curve = [];
for (let b = 0; b < BINS; b++) {
    const arr = bins[b];
    if (arr.length < 40) { console.log(String(b).padStart(2) + '  —'); curve.push(null); continue; }
    const ks = arr.map((v) => v[1]).sort((p, q) => p - q);
    const med = ks[Math.floor(ks.length / 2)];
    const y0 = (b / BINS) ** 2.2, y1 = ((b + 1) / BINS) ** 2.2;
    curve.push([(y0 + y1) / 2, med]);
    console.log('  ' + (b / BINS).toFixed(2) + '-' + ((b + 1) / BINS).toFixed(2) +
        '  ' + (arr.length / (N * N) * 100).toFixed(1).padStart(5) + '%' +
        '   k ' + med.toFixed(3) +
        '   [' + ks[Math.floor(ks.length * 0.25)].toFixed(3) + ', ' + ks[Math.floor(ks.length * 0.75)].toFixed(3) + ']');
}
console.log('\n可用锚点（Y, k）：');
console.log(curve.filter(Boolean).map(([y, k]) => '(' + y.toFixed(3) + ', ' + k.toFixed(3) + ')').join(' '));
