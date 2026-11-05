// 高频能量对比：同一分辨率下「我们」和「LR」的细节量差多少。
//
// 分带统计（区块平均）看不见零均值高频，所以之前那条「差在锐度」只有目视结论。
// 这里补一个能量口径：|Laplacian| 的均值，按亮度分档，并按「边缘强度」分开统计
// —— 平地区域（天空/墙面）的能量主要来自噪声与锐化，边缘区来自锐化与重采样。
//
//   node tools/hf-energy.js [ours] [lr]
const fs = require('fs');
const jpeg = require('jpeg-js');

function loadRGB(f) {
    const j = jpeg.decode(fs.readFileSync(f), { maxMemoryUsageInMB: 4096 });
    const { width: W, height: H, data } = j;
    const out = new Float32Array(W * H * 3);
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
        out[i * 3] = data[p]; out[i * 3 + 1] = data[p + 1]; out[i * 3 + 2] = data[p + 2];
    }
    return { W, H, rgb: out };
}

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// 5 点 Laplacian 的绝对值；同时给出该点的梯度模（用来判「是不是边缘」）
function energy(im) {
    const { W, H, rgb } = im;
    const L = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) L[i] = lum(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    const lap = new Float32Array(W * H);
    const grad = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
            const i = y * W + x;
            const c = L[i];
            lap[i] = Math.abs(4 * c - L[i - 1] - L[i + 1] - L[i - W] - L[i + W]);
            grad[i] = Math.abs(L[i + 1] - L[i - 1]) + Math.abs(L[i + W] - L[i - W]);
        }
    }
    return { L, lap, grad, W, H };
}

function report(name, e) {
    const { lap, grad, L, W, H } = e;
    // 只看内部：边缘一圈的 Laplacian 不可靠
    const flat = [], edge = [];
    for (let y = 2; y < H - 2; y++) {
        for (let x = 2; x < W - 2; x++) {
            const i = y * W + x;
            if (grad[i] < 6) flat.push(lap[i]);      // 平地
            else if (grad[i] > 40) edge.push(lap[i]); // 明确边缘
        }
    }
    const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
    const pct = (a, q) => { const b = a.slice().sort((p, q2) => p - q2); return b[Math.floor(q * (b.length - 1))]; };
    // 亮度分档的细节量：暗部/中间调/亮部的纹理强度
    const byL = [[0, 64], [64, 160], [160, 256]].map(([lo, hi]) => {
        const a = [];
        for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
            const i = y * W + x;
            if (L[i] >= lo && L[i] < hi) a.push(lap[i]);
        }
        return { band: lo + '-' + hi, n: a.length, m: +mean(a).toFixed(3) };
    });
    return {
        name, flat: +mean(flat).toFixed(3), edge: +mean(edge).toFixed(3),
        flatP90: +pct(flat, 0.9).toFixed(2), nFlat: flat.length, nEdge: edge.length, byL
    };
}

const A = process.argv[2] || 'tools/out/sh_spatial.jpg';
const B = process.argv[3] || 'tools/out/sh_lr.jpg';
const a = report('ours', energy(loadRGB(A)));
const b = report('lr', energy(loadRGB(B)));
console.log('\n 口径           我们      LR      LR/我们');
const row = (k, x, y) => console.log(' ' + k.padEnd(14) + String(x).padStart(7) + String(y).padStart(8)
    + '  ' + (x ? (y / x).toFixed(3) : '-').padStart(7));
row('平地 |∇L|', a.flat, b.flat);
row('边缘 |∇L|', a.edge, b.edge);
row('平地 P90', a.flatP90, b.flatP90);
console.log('\n 亮度档      我们      LR      LR/我们');
for (let i = 0; i < a.byL.length; i++) {
    const x = a.byL[i], y = b.byL[i];
    console.log(' ' + x.band.padEnd(11) + String(x.m).padStart(7) + String(y.m).padStart(8)
        + '  ' + (x.m ? (y.m / x.m).toFixed(3) : '-').padStart(7));
}
console.log('\n 平地像素占比', (a.nFlat / (a.nFlat + a.nEdge)).toFixed(3));
