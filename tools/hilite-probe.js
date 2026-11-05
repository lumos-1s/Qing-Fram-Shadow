// 高光探针：只看「最亮的那部分像素」，查我们是不是冲白/洗彩度
// 用法：node tools/hilite-probe.js
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const OUT = path.join(__dirname, 'out');

function readPPM(fp) {
    const b = fs.readFileSync(fp);
    let p = 0; const f = [];
    while (f.length < 4) {
        while (b[p] === 10 || b[p] === 13 || b[p] === 32) p++;
        let s = '';
        while (b[p] !== 10 && b[p] !== 13 && b[p] !== 32) s += String.fromCharCode(b[p++]);
        f.push(s);
    }
    p++;
    const w = +f[1], h = +f[2];
    if (p + w * h * 3 > b.length + 1) throw new Error('PPM 长度不符');
    return { w, h, d: b.subarray(p, p + w * h * 3), st: 3 };
}
function readJPG(fp) {
    const j = jpeg.decode(fs.readFileSync(fp), { useTArray: true, maxMemoryUsageInMB: 4096 });
    return { w: j.width, h: j.height, d: j.data, st: 4 };
}

const s2l = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const linY = (r, g, b) => 0.2126 * s2l(r) + 0.7152 * s2l(g) + 0.0722 * s2l(b);
function lab(r, g, b) {
    const R = s2l(r), G = s2l(g), B = s2l(b);
    const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
    const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const fx = f(X), fy = f(Y), fz = f(Z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// 以 (cx,cy) 为中心取 (2r+1)² 的均值。LR 图比我们大 3.4 倍，半径也按比例放大，
// 否则「点采样 vs 块均值」的差异会混进 ΔRGB 里。
function avg(im, cx, cy, r) {
    const { w, d, st } = im;
    let rr = 0, gg = 0, bb = 0, n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const xx = Math.min(w - 1, Math.max(0, cx + dx)), yy = Math.min(im.h - 1, Math.max(0, cy + dy));
        const p = (yy * w + xx) * st;
        rr += d[p]; gg += d[p + 1]; bb += d[p + 2]; n++;
    }
    return [rr / n, gg / n, bb / n];
}

const OURS = readPPM(path.join(OUT, 'ours_t50.ppm'));
const LR = readJPG('C:/Users/lumos/Desktop/未命名导出/tint=50.jpg');
const W = Math.min(OURS.w, LR.w), H = Math.min(OURS.h, LR.h);
console.log('尺寸 我们', OURS.w + 'x' + OURS.h, ' LR', LR.w + 'x' + LR.h, ' 比', W + 'x' + H);

// 以 LR 的亮度排序，取最亮的若干分位
const N = 400;                       // 400×400 采样格
const rows = [];
// 两张图分辨率不同（LR 5905×3937 / 我们 1740×1160），必须各自按自己的尺寸取归一化坐标
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const u = (i + 0.5) / N, v = (j + 0.5) / N;
    const a = avg(LR, Math.floor(u * LR.w), Math.floor(v * LR.h), Math.max(1, Math.round(LR.w / OURS.w)));
    const b = avg(OURS, Math.floor(u * OURS.w), Math.floor(v * OURS.h), 1);
    rows.push({ a, b, Y: linY(a[0], a[1], a[2]) });
}
rows.sort((p, q) => q.Y - p.Y);

const bands = [[0, 0.01, '最亮 1%'], [0.01, 0.03, '1-3%'], [0.03, 0.06, '3-6%'], [0.06, 0.12, '6-12%'], [0.12, 0.25, '12-25%'], [0.25, 0.5, '25-50%']];
console.log('\n按 LR 亮度分位（每行：我们 − LR）');
for (const [lo, hi, name] of bands) {
    const s = rows.slice(Math.round(lo * rows.length), Math.round(hi * rows.length));
    let sr = 0, sg = 0, sb = 0, sL = 0, sa = 0, sb2 = 0, sC = 0, clipO = 0, clipL = 0;
    for (const r of s) {
        sr += r.b[0] - r.a[0]; sg += r.b[1] - r.a[1]; sb += r.b[2] - r.a[2];
        const la = lab(...r.a), lb = lab(...r.b);
        sL += lb[0] - la[0]; sa += lb[1] - la[1]; sb2 += lb[2] - la[2];
        sC += Math.hypot(lb[1], lb[2]) - Math.hypot(la[1], la[2]);
        if (Math.max(r.b[0], r.b[1], r.b[2]) >= 254) clipO++;
        if (Math.max(r.a[0], r.a[1], r.a[2]) >= 254) clipL++;
    }
    const n = s.length || 1;
    console.log(name.padEnd(8),
        'ΔRGB ' + [sr / n, sg / n, sb / n].map((v) => v.toFixed(1).padStart(6)).join(','),
        ' ΔL ' + (sL / n).toFixed(1).padStart(5),
        ' Δa ' + (sa / n).toFixed(1).padStart(5),
        ' Δb ' + (sb2 / n).toFixed(1).padStart(5),
        ' ΔC ' + (sC / n).toFixed(1).padStart(5),
        ' 冲白率 我们 ' + (clipO / n * 100).toFixed(0) + '% LR ' + (clipL / n * 100).toFixed(0) + '%');
}

// 逐通道直方图：最亮 3% 的通道值分布
console.log('\n最亮 3% 的通道均值');
const top = rows.slice(0, Math.round(0.03 * rows.length));
const avgCh = (k) => top.reduce((s, r) => s + r[k][0] + r[k][1] + r[k][2], 0) / (top.length * 3);
const avgC = (k, c) => top.reduce((s, r) => s + r[k][c], 0) / top.length;
console.log('  我们 R ' + avgC('b', 0).toFixed(1) + ' G ' + avgC('b', 1).toFixed(1) + ' B ' + avgC('b', 2).toFixed(1));
console.log('  LR   R ' + avgC('a', 0).toFixed(1) + ' G ' + avgC('a', 1).toFixed(1) + ' B ' + avgC('a', 2).toFixed(1));

// 色相：最亮 3% 在 Lab 里的角度
const ang = (k) => {
    let x = 0, y = 0;
    for (const r of top) { const l = lab(...r[k]); x += l[1]; y += l[2]; }
    return [Math.hypot(x, y) / top.length, (Math.atan2(y, x) * 180 / Math.PI + 360) % 360];
};
const [C1, h1] = ang('a'), [C2, h2] = ang('b');
console.log('  色相角 我们 ' + h2.toFixed(1) + '° (C ' + C2.toFixed(1) + ')  LR ' + h1.toFixed(1) + '° (C ' + C1.toFixed(1) + ')');

// 最亮像素里，两边「已到 255 的通道数」分布
console.log('\n最亮 6% 的通道截断统计（>=250 的通道数占比）');
for (const [nm, k] of [['我们', 'b'], ['LR', 'a']]) {
    const hist = [0, 0, 0, 0];
    const s = rows.slice(0, Math.round(0.06 * rows.length));
    for (const r of s) {
        const c = r[k].filter((v) => v >= 250).length;
        hist[c]++;
    }
    console.log('  ' + nm.padEnd(4) + hist.map((v, i) => i + 'ch ' + (v / s.length * 100).toFixed(0) + '%').join('  '));
}
