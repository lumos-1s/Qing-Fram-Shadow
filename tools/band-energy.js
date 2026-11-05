/* 频带能量谱：用一组不同 σ 的高斯差分（DoG）量出各尺度还剩多少细节。
 *
 * 单一「拉普拉斯」只能看 1px 那一档，说不清是「整体不够锐」还是「频带错位」。
 * 这里按 σ = 0.7 / 1.0 / 1.4 / 2.0 / 3.0 / 4.5 分别算 RMS，等于把画面拆成
 * 六级细节层，然后横向比源图 / 我们 / LR，缺哪一级一目了然。
 *
 * 只在裁切块上算（带 3σ 余量，避免边界吸附），所以 23MP 的原图也很快。
 */
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const OUT = path.join(__dirname, 'out');
const SRC = 'C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg';
const LRF = 'C:/Users/lumos/Desktop/未命名导出/tint=50.jpg';

function load(fp) {
    const j = jpeg.decode(fs.readFileSync(fp), { useTArray: true, maxMemoryUsageInMB: 4096 });
    return { w: j.width, h: j.height, d: j.data, name: path.basename(fp) };
}

function lum(im) {
    const { w, h, d } = im;
    const L = new Float32Array(w * h);
    for (let i = 0, p = 0; i < L.length; i++, p += 4) {
        L[i] = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
    }
    return L;
}

/* 可分离高斯，反射边界（比零填充更接近真实内容，避免边界把 RMS 抬高） */
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
            for (let i = -r; i <= r; i++) {
                let xx = x + i;
                if (xx < 0) xx = -xx; else if (xx >= w) xx = 2 * w - 2 - xx;
                s += src[b + xx] * k[i + r];
            }
            tmp[b + x] = s;
        }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let s = 0;
            for (let i = -r; i <= r; i++) {
                let yy = y + i;
                if (yy < 0) yy = -yy; else if (yy >= h) yy = 2 * h - 2 - yy;
                s += tmp[yy * w + x] * k[i + r];
            }
            out[y * w + x] = s;
        }
    }
    return out;
}

/* 取块（归一化坐标），返回 {L, w, h, ox, oy}，带 margin 供卷积呼吸 */
function patch(im, nx, ny, nw, nh, margin) {
    const x0 = Math.max(0, Math.round(nx * im.w) - margin);
    const y0 = Math.max(0, Math.round(ny * im.h) - margin);
    const x1 = Math.min(im.w, Math.round((nx + nw) * im.w) + margin);
    const y1 = Math.min(im.h, Math.round((ny + nh) * im.h) + margin);
    const w = x1 - x0, h = y1 - y0;
    const L = lum(im);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        const s = (y0 + y) * im.w + x0;
        out.set(L.subarray(s, s + w), y * w);
    }
    return { L: out, w, h, ox: x0, oy: y0, margin };
}

const SIGMAS = [0.7, 1.0, 1.4, 2.0, 3.0, 4.5];

/* 在裁切块上算每级 DoG 的 RMS；只统计去掉 margin 之后的核心区 */
function profile(p) {
    const { L, w, h, margin } = p;
    const inner = (y) => y >= margin && y < h - margin;
    const core = (x, y) => x >= margin && x < w - margin && inner(y);
    const res = [];
    for (const s of SIGMAS) {
        const B = blur(L, w, h, s);
        let acc = 0, n = 0;
        for (let y = margin; y < h - margin; y++) {
            for (let x = margin; x < w - margin; x++) {
                const i = y * w + x;
                if (!core(x, y)) continue;
                const d = L[i] - B[i];
                acc += d * d; n++;
            }
        }
        res.push(Math.sqrt(acc / n));
    }
    return res;
}

const CROPS = [
    ['叶子（中）', 0.46, 0.38, 0.07, 0.08],
    ['叶子（左上）', 0.20, 0.16, 0.07, 0.08],
    ['墙面', 0.10, 0.42, 0.07, 0.08],
    ['全图中部', 0.30, 0.30, 0.20, 0.20],
];

const imgs = [
    ['源', load(SRC)],
    ['我们', load(path.join(OUT, process.env.OURS || 'full_ours.jpg'))],
    ['LR', load(LRF)],
];

console.log('σ 档：' + SIGMAS.map((s) => s.toFixed(1)).join('  '));
for (const [nm, nx, ny, nw, nh] of CROPS) {
    console.log('\n' + nm);
    for (const [tag, im] of imgs) {
        const pr = profile(patch(im, nx, ny, nw, nh, 24));
        console.log('  ' + tag.padEnd(4) + pr.map((v) => v.toFixed(2).padStart(7)).join(''));
    }
}
