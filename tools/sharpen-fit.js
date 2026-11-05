/* 锐化参数拟合：在裁切块上离线做 USM，扫 (amount, sigma)，看哪组能复现 LR 的频带谱。
 *
 * 只看图不够——肉眼对「锐」的判断会被对比度和色相带偏。这里用六级 DoG 的 RMS
 * 作为目标向量，取对数比的最小平方误差。对数域比较等于要求「每个尺度都按比例对上」，
 * 而不是靠某一级堆能量把总分拉低。
 *
 * 同时报告两个代价项：
 *   · clip —— 因为锐化而新增的 255 截断像素占比（超过 0.05% 就会看成死白）
 *   · halo —— 边缘两侧的过冲幅度（USM 的招牌副作用，LR 的 Detail 就是压它的）
 */
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const OUT = path.join(__dirname, 'out');
const SRC = 'C:/Users/lumos/Desktop/未命名导出/tint=50.jpg';   // 目标
const BASE = path.join(OUT, 'full_nosharp.jpg');                // 我们的未锐化全分辨率

const SIGMAS = [0.7, 1.0, 1.4, 2.0, 3.0, 4.5];
const RECT = (process.env.RECT || '0.46,0.38,0.09,0.10').split(',').map(Number);   // 归一化裁切（比统计区大一圈，留 margin）

function load(fp) {
    const j = jpeg.decode(fs.readFileSync(fp), { useTArray: true, maxMemoryUsageInMB: 4096 });
    return { w: j.width, h: j.height, d: j.data };
}

/* 取块：返回 RGB（Float32，3 通道平面）+ 亮度 */
function grab(im) {
    const x0 = Math.round(RECT[0] * im.w), y0 = Math.round(RECT[1] * im.h);
    const w = Math.round(RECT[2] * im.w), h = Math.round(RECT[3] * im.h);
    const rgb = new Float32Array(w * h * 3);
    const L = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = ((y0 + y) * im.w + x0 + x) * 4, q = (y * w + x) * 3;
            const r = im.d[p], g = im.d[p + 1], b = im.d[p + 2];
            rgb[q] = r; rgb[q + 1] = g; rgb[q + 2] = b;
            L[y * w + x] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }
    }
    return { rgb, L, w, h };
}

function blur(src, w, h, sigma) {
    const r = Math.max(1, Math.round(sigma * 3));
    const k = new Float32Array(r * 2 + 1);
    const s2 = 2 * sigma * sigma;
    let sum = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / s2); k[i + r] = v; sum += v; }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        const b = y * w;
        for (let x = 0; x < w; x++) {
            let s = 0;
            const lo = x - r < 0 ? 0 : x - r, hi = x + r >= w ? w - 1 : x + r;
            for (let i = lo; i <= hi; i++) s += src[b + i] * k[i - x + r];
            tmp[b + x] = s;
        }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        const lo = y - r < 0 ? 0 : y - r, hi = y + r >= h ? h - 1 : y + r;
        for (let x = 0; x < w; x++) {
            let s = 0;
            for (let i = lo; i <= hi; i++) s += tmp[i * w + x] * k[i - y + r];
            out[y * w + x] = s;
        }
    }
    return out;
}

/* 频带谱：DoG(σ) 的高斯是「高通截止在 σ」，所以大 σ 也含细部，只是权重低 */
function profile(L, w, h, skip) {
    const res = [];
    for (const s of SIGMAS) {
        const B = blur(L, w, h, s);
        let acc = 0, n = 0;
        for (let y = skip; y < h - skip; y++) {
            for (let x = skip; x < w - skip; x++) {
                const i = y * w + x, d = L[i] - B[i];
                acc += d * d; n++;
            }
        }
        res.push(Math.sqrt(acc / n));
    }
    return res;
}

const tgt = grab(load(SRC));
const base = grab(load(BASE));
const SKIP = 30;
const pT = profile(tgt.L, tgt.w, tgt.h, SKIP);
const p0 = profile(base.L, base.w, base.h, SKIP);

console.log('目标（LR 导出）频带谱  ' + pT.map((v) => v.toFixed(2).padStart(7)).join(''));
console.log('基准（我们未锐化）      ' + p0.map((v) => v.toFixed(2).padStart(7)).join(''));
console.log('需要放大的倍数          ' + pT.map((v, i) => (v / p0[i]).toFixed(2).padStart(7)).join(''));

/* 对每档参数做 USM，重算频带谱 */
const B0 = base;
const rows = [];
for (const sigma of [0.45, 0.55, 0.65, 0.75, 0.9, 1.1, 1.4, 1.8]) {
    const Bl = blur(B0.L, B0.w, B0.h, sigma);
    for (const amt of [0.3, 0.45, 0.6, 0.75, 0.9, 1.1, 1.3, 1.6, 2.0]) {
        const L2 = new Float32Array(B0.L.length);
        const n = B0.L.length;
        let clip = 0, mx = 0;
        for (let i = 0; i < n; i++) {
            const d = amt * (B0.L[i] - Bl[i]);
            const v = B0.L[i] + d;
            L2[i] = v;
            // 截断按「最可能撞顶的通道」估：亮度加完后原通道也一起加
            const p3 = i * 3;
            const m = Math.max(B0.rgb[p3], B0.rgb[p3 + 1], B0.rgb[p3 + 2]) + d;
            if (m >= 255 && Math.max(B0.rgb[p3], B0.rgb[p3 + 1], B0.rgb[p3 + 2]) < 255) clip++;
            if (d < 0) { const a = -d; if (a > mx) mx = a; }
        }
        const pr = profile(L2, B0.w, B0.h, SKIP);
        let e = 0;
        for (let i = 0; i < pr.length; i++) { const t = Math.log(pr[i] / pT[i]); e += t * t; }
        rows.push({ sigma, amt, err: Math.sqrt(e / pr.length), pr, clip: clip / n * 100 });
    }
}
/* 把「当前线上参数」也丢进同一把尺子里：σ = shr*1.6*longPx/1600 = 2.95，amount 0.453 */
for (const [sig, amt] of [[2.95, 0.453]]) {
    const Bl = blur(B0.L, B0.w, B0.h, sig);
    const L2 = new Float32Array(B0.L.length);
    const n = B0.L.length;
    let clip = 0;
    for (let i = 0; i < n; i++) {
        const d = amt * (B0.L[i] - Bl[i]);
        L2[i] = B0.L[i] + d;
        const p3 = i * 3;
        const m = Math.max(B0.rgb[p3], B0.rgb[p3 + 1], B0.rgb[p3 + 2]);
        if (m + d >= 255 && m < 255) clip++;
    }
    const pr = profile(L2, B0.w, B0.h, SKIP);
    let e = 0;
    for (let i = 0; i < pr.length; i++) { const t = Math.log(pr[i] / pT[i]); e += t * t; }
    console.log('\n当前线上参数 sigma ' + sig + ' amount ' + amt +
        '  err ' + (Math.sqrt(e / pr.length) * 100).toFixed(1) + '%  谱 ' +
        pr.map((v) => v.toFixed(1).padStart(6)).join('') + '  新增撞顶 ' + (clip / n * 100).toFixed(3) + '%');
}

rows.sort((a, b) => a.err - b.err);
console.log('\n按「六级频带对数误差」排序（越小越像 LR）：');
for (const r of rows.slice(0, 10)) {
    console.log('  sigma ' + r.sigma.toFixed(2) + '  amount ' + r.amt.toFixed(2) +
        '  err ' + (r.err * 100).toFixed(1) + '%  谱 ' + r.pr.map((v) => v.toFixed(1).padStart(6)).join('') +
        '  新增撞顶 ' + r.clip.toFixed(3) + '%');
}

/* 只按最细一级（σ0.7）对齐需要多少——给个直观的「力度」尺度 */
const need = pT[0] / p0[0];
console.log('\n仅看最细一级：LR / 我们 = ' + need.toFixed(2) + '×');
console.log('单档 USM 在 σ→0 时增益上限 = 1 + amount，所以要达到 ' + need.toFixed(2) +
    '× 需要 amount ≈ ' + (need - 1).toFixed(2));
