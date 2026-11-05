// 引擎级两级定标（通道平衡 BAL + 高光收口 HI_K）的离线评估。
// 拿 full_nobal.jpg（两级全关）当底，按代码里的数学重新施加，扫出最优组合。
//   node tools/bal-eval.js
'use strict';

const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const OUT = path.join(__dirname, 'out');
const load = (f) => {
    const j = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
    return { w: j.width, h: j.height, d: j.data };
};
const s2l = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const l2s = (v) => {
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
};
const lab = (r, g, b) => {
    const R = s2l(r), G = s2l(g), B = s2l(b);
    const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
    const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const fx = f(X), fy = f(Y), fz = f(Z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};

// 复刻 app-acr.js 的 BAL_LUT：线性光乘增益 → 编码回 8bit
function gainLut(g) {
    const t = new Uint8Array(256);
    for (let v = 0; v < 256; v++) t[v] = Math.round(255 * l2s(Math.min(1, s2l(v) * g)));
    return t;
}
const BAL_LIN = new Float32Array(256);
for (let v = 0; v < 256; v++) BAL_LIN[v] = s2l(v);

// 复刻 hiRolloff 的 HI_K（单调三次插值，存的是乘数）
const HI_K_PTS = [[0, 1], [0.30, 1], [0.45, 0.962], [0.55, 0.948], [0.65, 0.936],
    [0.75, 0.912], [0.85, 0.890], [0.92, 0.894], [1, 1]];
const HI_K = (() => {
    const pts = HI_K_PTS, n = pts.length;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const d = [], m = new Array(n).fill(0);
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
        if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
        const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
        if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    const out = new Float32Array(256);
    for (let v = 0; v < 256; v++) {
        const x = v / 255;
        let i = 0;
        while (i < n - 2 && x > xs[i + 1]) i++;
        const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h;
        const t2 = t * t, t3 = t2 * t;
        const y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i]
            + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
        out[v] = Math.max(0.5, Math.min(1.2, y));
    }
    out[255] = 1;
    return out;
})();

const BAL_FADE = [0.60, 0.88];

// 施加一级或两级定标，返回新像素
function apply(src, bal, hi) {
    const n = src.d.length / 4;
    const out = new Uint8ClampedArray(src.d.length);
    const LR = bal ? gainLut(bal.r) : null;
    const LG = bal ? gainLut(bal.g) : null;
    const LB = bal ? gainLut(bal.b) : null;
    const lo = BAL_FADE[0], span = BAL_FADE[1] - BAL_FADE[0];
    for (let i = 0; i < n; i++) {
        const p = i * 4;
        let r = src.d[p], g = src.d[p + 1], b = src.d[p + 2];
        if (bal) {
            const y = 0.2126 * BAL_LIN[r] + 0.7152 * BAL_LIN[g] + 0.0722 * BAL_LIN[b];
            let t = (y - lo) / span;
            if (t <= 0) {
                r = LR[r]; g = LG[g]; b = LB[b];
            } else if (t < 1) {
                const w = 1 - t * t * (3 - 2 * t);
                r = Math.round(r + (LR[r] - r) * w);
                g = Math.round(g + (LG[g] - g) * w);
                b = Math.round(b + (LB[b] - b) * w);
            }
        }
        if (hi) {
            const y = 0.2126 * BAL_LIN[r] + 0.7152 * BAL_LIN[g] + 0.0722 * BAL_LIN[b];
            if (y >= 0.16) {
                const k = HI_K[Math.round(y * 255)];
                if (k < 0.999) {
                    r = Math.round(255 * l2s(BAL_LIN[r] * k));
                    g = Math.round(255 * l2s(BAL_LIN[g] * k));
                    b = Math.round(255 * l2s(BAL_LIN[b] * k));
                }
            }
        }
        out[p] = r; out[p + 1] = g; out[p + 2] = b; out[p + 3] = 255;
    }
    return { w: src.w, h: src.h, d: out };
}

const BASE = load(path.join(OUT, 'full_nobal.jpg'));
const LR = load('C:/Users/lumos/Desktop/未命名导出/tint=50.jpg');
const NOW = load(path.join(OUT, 'full_sharp4.jpg'));

const BLOCKS = [['黄叶1', 0.46, 0.38], ['黄叶2', 0.18, 0.30], ['墙面', 0.10, 0.44],
    ['天光', 0.42, 0.16], ['路面', 0.50, 0.72], ['暗部', 0.03, 0.35]];

function score(im) {
    let se = 0, n = 0, sa = 0, sb = 0;
    for (let y = 4; y < im.h - 4; y += 7) {
        for (let x = 4; x < im.w - 4; x += 7) {
            const p = (y * im.w + x) * 4, q = (y * LR.w + x) * 4;
            const A = lab(im.d[p], im.d[p + 1], im.d[p + 2]);
            const B = lab(LR.d[q], LR.d[q + 1], LR.d[q + 2]);
            const dL = A[0] - B[0], da = A[1] - B[1], db = A[2] - B[2];
            se += dL * dL + da * da + db * db; sa += da; sb += db; n++;
        }
    }
    const blocks = BLOCKS.map(([nm, nx, ny]) => {
        const x0 = Math.round(nx * im.w), y0 = Math.round(ny * im.h);
        const w = Math.round(0.05 * im.w), h = Math.round(0.05 * im.h);
        let t = [0, 0, 0], m = 0;
        for (let y = y0; y < y0 + h; y += 3) for (let x = x0; x < x0 + w; x += 3) {
            const p = (y * im.w + x) * 4, q = (y * LR.w + x) * 4;
            const A = lab(im.d[p], im.d[p + 1], im.d[p + 2]);
            const B = lab(LR.d[q], LR.d[q + 1], LR.d[q + 2]);
            t[0] += A[0] - B[0]; t[1] += A[1] - B[1]; t[2] += A[2] - B[2]; m++;
        }
        return nm + ' ' + t.map((v) => (v / m >= 0 ? '+' : '') + (v / m).toFixed(1)).join('/');
    });
    return { dE: Math.sqrt(se / n), da: sa / n, db: sb / n, blocks };
}

const CANDS = [
    ['两级全关', null, false],
    ['只 HI_K', null, true],
    ['只 BAL G1.095（上轮）', { r: 1.034, g: 1.095, b: 1.0 }, false],
    ['只 BAL G1.050', { r: 1.020, g: 1.050, b: 1.0 }, false],
    ['只 R1.034（不提绿）', { r: 1.034, g: 1.0, b: 1.0 }, false],
    ['BAL G1.095 + HI_K（当前）', { r: 1.034, g: 1.095, b: 1.0 }, true],
    ['BAL G1.050 + HI_K', { r: 1.020, g: 1.050, b: 1.0 }, true],
    ['BAL G1.025 + HI_K', { r: 1.010, g: 1.025, b: 1.0 }, true],
    ['只 R1.034 + HI_K', { r: 1.034, g: 1.0, b: 1.0 }, true],
];

console.log('方案                        ΔE    Δa均   Δb均   六块 ΔL/Δa/Δb');
for (const [name, bal, hi] of CANDS) {
    const im = apply(BASE, bal, hi);
    const s = score(im);
    console.log(name.padEnd(26),
        s.dE.toFixed(2).padStart(5),
        (s.da >= 0 ? '+' : '') + s.da.toFixed(2),
        (s.db >= 0 ? '+' : '') + s.db.toFixed(2),
        '  ' + s.blocks.join(' | '));
}
const sNow = score(NOW);
console.log('\n已落盘 full_sharp4（真实渲染）'.padEnd(26), sNow.dE.toFixed(2).padStart(5),
    (sNow.da >= 0 ? '+' : '') + sNow.da.toFixed(2), (sNow.db >= 0 ? '+' : '') + sNow.db.toFixed(2),
    '  ' + sNow.blocks.join(' | '));
