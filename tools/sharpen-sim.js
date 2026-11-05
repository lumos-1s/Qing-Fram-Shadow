/* 锐化模拟器：逐字复刻 app-sharpen.js 的 applyCanvas 数学（含蒙版、亮度加权、
 * 余量保护），在裁切块上跑，用来快速扫参数、并拆出「蒙版吃掉多少力度」。
 *
 * 与线上代码的一致性靠 `--verify` 保证：拿 full_nosharp 当输入、用线上参数跑一遍，
 * 谱应该与真实渲染出来的 full_sharp2 重合（差 <2%）。不重合就说明模拟器漂了。
 */
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const OUT = path.join(__dirname, 'out');
const SIGMAS = [0.7, 1.0, 1.4, 2.0, 3.0, 4.5];

const RECT = (process.env.RECT || '0.09,0.41,0.10,0.09').split(',').map(Number);
const MARGIN = 40;

function load(fp) {
    const j = jpeg.decode(fs.readFileSync(fp), { useTArray: true, maxMemoryUsageInMB: 4096 });
    return { w: j.width, h: j.height, d: j.data };
}

function grabRGB(im) {
    const x0 = Math.max(0, Math.round(RECT[0] * im.w) - MARGIN);
    const y0 = Math.max(0, Math.round(RECT[1] * im.h) - MARGIN);
    const w = Math.round(RECT[2] * im.w) + MARGIN * 2;
    const h = Math.round(RECT[3] * im.h) + MARGIN * 2;
    const rgb = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = ((y0 + y) * im.w + x0 + x) * 4, q = (y * w + x) * 3;
            rgb[q] = im.d[p]; rgb[q + 1] = im.d[p + 1]; rgb[q + 2] = im.d[p + 2];
        }
    }
    return { rgb, w, h };
}

function kernelOf(sigma) {
    const r = Math.max(1, Math.round(sigma * 3));
    const n = r * 2 + 1;
    const a = new Float32Array(n);
    const s2 = 2 * sigma * sigma;
    let sum = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / s2); a[i + r] = v; sum += v; }
    for (let i = 0; i < n; i++) a[i] /= sum;
    return { r, a };
}

/* 完全按 applyCanvas 的顺序：抽亮度 → 横卷积(A) → 纵卷积(B) → 合成 */
function sharpen(P, S) {
    const { w, h } = S;
    const rgb = Float32Array.from(S.rgb);
    const { r, a: k } = kernelOf(P.radius);
    const A = new Float32Array(w * h);
    const row = new Float32Array(w);
    for (let y = 0; y < h; y++) {
        const base = y * w;
        for (let x = 0; x < w; x++) {
            const p = (base + x) * 3;
            row[x] = 0.2126 * rgb[p] + 0.7152 * rgb[p + 1] + 0.0722 * rgb[p + 2];
        }
        for (let x = 0; x < w; x++) {
            let s = 0;
            const lo = x - r < 0 ? 0 : x - r, hi = x + r >= w ? w - 1 : x + r;
            for (let i = lo; i <= hi; i++) s += row[i] * k[i - x + r];
            A[base + x] = s;
        }
    }
    const B = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        const lo = y - r < 0 ? 0 : y - r, hi = y + r >= h ? h - 1 : y + r;
        for (let x = 0; x < w; x++) {
            let s = 0;
            for (let i = lo; i <= hi; i++) s += A[i * w + x] * k[i - y + r];
            B[y * w + x] = s;
        }
    }

    const maskOn = P.masking > 0;
    const floor = maskOn ? 0.35 * (1 - P.masking / 100) : 1;
    const MS = P.maskScale || 24;
    const t0 = maskOn ? (P.masking / 100) * MS : 0;
    const t1 = t0 + MS / 2;
    const lp = Math.max(0, Math.min(1, P.lumPow));
    const LW = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        const lowEnd = 1 - lp + lp * Math.sqrt(t);
        const highEnd = t <= 0.82 ? 1 : 1 - 0.5 * (t - 0.82) / 0.18;
        LW[i] = lowEnd * highEnd;
    }
    const HEAD = 24;
    let wSum = 0, n = 0, clipNew = 0, clipOld = 0, over = 0, overN = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = (y * w + x) * 3;
            const L = 0.2126 * rgb[p] + 0.7152 * rgb[p + 1] + 0.0722 * rgb[p + 2];
            const hp = L - B[y * w + x];
            let ww = 1;
            if (maskOn) {
                const xl = x > 0 ? x - 1 : 0, xr = x < w - 1 ? x + 1 : w - 1;
                const yu = y > 0 ? y - 1 : 0, yd = y < h - 1 ? y + 1 : h - 1;
                const grad = Math.abs(B[y * w + xr] - B[y * w + xl])
                    + Math.abs(B[yd * w + x] - B[yu * w + x]);
                const r0 = grad <= t0 ? 0 : (grad >= t1 ? 1 : (grad - t0) / (t1 - t0));
                ww = floor + (1 - floor) * r0;
            }
            wSum += ww; n++;
            if (!ww) continue;
            const L255 = L < 0 ? 0 : (L > 255 ? 255 : L | 0);
            let delta = P.amount * hp * ww * LW[L255];
            if (delta > 0) {
                const mx = Math.max(rgb[p], rgb[p + 1], rgb[p + 2]);
                const head = 255 - mx;
                if (head < HEAD) delta *= head <= 0 ? 0 : head / HEAD;
            }
            const m0 = Math.max(rgb[p], rgb[p + 1], rgb[p + 2]);
            if (m0 >= 255) clipOld++;
            if (delta > 0) { over += delta; overN++; }
            for (let c = 0; c < 3; c++) {
                const v = rgb[p + c] + delta;
                rgb[p + c] = v < 0 ? 0 : (v > 255 ? 255 : v);
            }
            if (Math.max(rgb[p], rgb[p + 1], rgb[p + 2]) >= 255 && m0 < 255) clipNew++;
        }
    }
    return { rgb, w, h, meanW: wSum / n, clipNew: clipNew / n * 100, clipOld: clipOld / n * 100, meanDelta: overN ? over / overN : 0 };
}

function blur(src, w, h, sigma) {
    const { r, a: k } = kernelOf(sigma);
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

function spectrumFromRGB(R, skip) {
    const { w, h } = R;
    const L = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
        L[i] = 0.2126 * R.rgb[i * 3] + 0.7152 * R.rgb[i * 3 + 1] + 0.0722 * R.rgb[i * 3 + 2];
    }
    return SIGMAS.map((s) => {
        const B = blur(L, w, h, s);
        let acc = 0, n = 0;
        for (let y = skip; y < h - skip; y++) {
            for (let x = skip; x < w - skip; x++) {
                const d = L[y * w + x] - B[y * w + x];
                acc += d * d; n++;
            }
        }
        return Math.sqrt(acc / n);
    });
}

const base = grabRGB(load(path.join(OUT, 'full_nosharp.jpg')));
const lr = grabRGB(load('C:/Users/lumos/Desktop/未命名导出/tint=50.jpg'));
const real = grabRGB(load(path.join(OUT, process.env.REAL || 'full_sharp2.jpg')));
const SKIP = MARGIN;

const pLR = spectrumFromRGB(lr, SKIP);
const p0 = spectrumFromRGB(base, SKIP);
console.log('LR 目标          ' + pLR.map((v) => v.toFixed(2).padStart(7)).join(''));
console.log('未锐化           ' + p0.map((v) => v.toFixed(2).padStart(7)).join(''));

const live = { amount: 0.659, radius: 0.75, masking: 34, lumPow: 0.5 };
const sim = sharpen(live, base);
const pS = spectrumFromRGB(sim, SKIP);
const pR = spectrumFromRGB(real, SKIP);
console.log('真实渲染(sharp2) ' + pR.map((v) => v.toFixed(2).padStart(7)).join(''));
console.log('模拟器同参数     ' + pS.map((v) => v.toFixed(2).padStart(7)).join('') +
    '   平均蒙版权重 ' + sim.meanW.toFixed(3) + '  新增撞顶 ' + sim.clipNew.toFixed(3) + '%  原有撞顶 ' + sim.clipOld.toFixed(2) + '%');

if (process.env.CMP) {
    for (const [MS, amount] of [[24,0.66],[10,0.85],[10,1.0],[6,1.0],[16,1.1]]) {
        const r = sharpen({ amount, radius: 0.75, masking: 34, lumPow: 0.5, maskScale: MS }, base);
        const p = spectrumFromRGB(r, SKIP);
        let e = 0; for (let i = 0; i < p.length; i++) { const t = Math.log(p[i] / pLR[i]); e += t * t; }
        const gain = p[0] / p0[0];
        console.log('  ms ' + String(MS).padStart(2) + ' a ' + amount.toFixed(2) +
            '  err ' + (Math.sqrt(e / p.length) * 100).toFixed(1) + '%  meanW ' + r.meanW.toFixed(2) +
            '  细部增益 ' + gain.toFixed(2) + 'x  新增撞顶 ' + r.clipNew.toFixed(3) + '%  平均delta ' + r.meanDelta.toFixed(2));
    }
}
if (process.env.MASK) {
    console.log('\n蒙版尺度扫描（target 谱见上，LR 首档 ' + pLR[0].toFixed(2) + '）：');
    for (const MS of [24, 16, 10, 6, 4]) {
        for (const amount of [0.6, 0.8, 1.0, 1.2]) {
            const r = sharpen({ amount, radius: 0.75, masking: 34, lumPow: 0.5, maskScale: MS }, base);
            const p = spectrumFromRGB(r, SKIP);
            let e = 0; for (let i = 0; i < p.length; i++) { const t = Math.log(p[i] / pLR[i]); e += t * t; }
            console.log('  scale ' + String(MS).padStart(2) + '  a ' + amount.toFixed(1) +
                '  err ' + (Math.sqrt(e / p.length) * 100).toFixed(1) + '%  meanW ' + r.meanW.toFixed(3) +
                '  谱 ' + p.map((v) => v.toFixed(1).padStart(6)).join(''));
        }
    }
}
if (process.env.SWEEP) {
    console.log('\n扫参数（固定蒙版 34）：');
    for (const radius of [0.65, 0.75, 0.9, 1.1]) {
        for (const amount of [0.6, 0.9, 1.2, 1.6]) {
            const r = sharpen({ amount, radius, masking: 34, lumPow: 0.5 }, base);
            const p = spectrumFromRGB(r, SKIP);
            let e = 0;
            for (let i = 0; i < p.length; i++) { const t = Math.log(p[i] / pLR[i]); e += t * t; }
            console.log('  σ ' + radius.toFixed(2) + '  a ' + amount.toFixed(2) +
                '  err ' + (Math.sqrt(e / p.length) * 100).toFixed(1) + '%  meanW ' + r.meanW.toFixed(3) +
                '  谱 ' + p.map((v) => v.toFixed(1).padStart(6)).join(''));
        }
    }
    console.log('\n蒙版量对力度的影响（σ 0.75 / a 0.66）：');
    for (const m of [0, 15, 25, 34, 50]) {
        const r = sharpen({ amount: 0.66, radius: 0.75, masking: m, lumPow: 0.5 }, base);
        const p = spectrumFromRGB(r, SKIP);
        console.log('  masking ' + String(m).padStart(3) + '  meanW ' + r.meanW.toFixed(3) +
            '  σ0.7 档 ' + p[0].toFixed(2) + '（LR ' + pLR[0].toFixed(2) + '）');
    }
}
