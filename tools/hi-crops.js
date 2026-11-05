// 高光并排裁切：左 = LR 自己的导出（按比例盒降采样到我们尺寸），右 = 我们的渲染。
// 只用 LR 导出当参照（截图那侧与 XMP 状态不一致，已弃用做像素基准）。
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
    return { w: +f[1], h: +f[2], d: b.subarray(p), st: 3 };
}
function readJPG(fp) {
    const j = jpeg.decode(fs.readFileSync(fp), { useTArray: true, maxMemoryUsageInMB: 4096 });
    return { w: j.width, h: j.height, d: j.data, st: 4 };
}

const OURS = readPPM(path.join(OUT, 'ours_t50.ppm'));
const LRf = readJPG('C:/Users/lumos/Desktop/未命名导出/tint=50.jpg');
const W = OURS.w, H = OURS.h;

// 盒降采样 LR → 我们的尺寸（每个目标像素取对应的 3.39×3.39 源块均值）
const LR = { w: W, h: H, d: Buffer.alloc(W * H * 3), st: 3 };
{
    const kx = LRf.w / W, ky = LRf.h / H;
    for (let y = 0; y < H; y++) {
        const y0 = Math.floor(y * ky), y1 = Math.min(LRf.h, Math.floor((y + 1) * ky));
        for (let x = 0; x < W; x++) {
            const x0 = Math.floor(x * kx), x1 = Math.min(LRf.w, Math.floor((x + 1) * kx));
            let r = 0, g = 0, b = 0, n = 0;
            for (let yy = y0; yy < y1; yy += 2) for (let xx = x0; xx < x1; xx += 2) {
                const p = (yy * LRf.w + xx) * 4;
                r += LRf.d[p]; g += LRf.d[p + 1]; b += LRf.d[p + 2]; n++;
            }
            const q = (y * W + x) * 3;
            LR.d[q] = r / n; LR.d[q + 1] = g / n; LR.d[q + 2] = b / n;
        }
    }
}

function crop(im, cx, cy, cw, ch, zoom) {
    const x0 = Math.round(cx * W), y0 = Math.round(cy * H);
    const w0 = Math.round(cw * W), h0 = Math.round(ch * H);
    const w = w0 * zoom, h = h0 * zoom;
    const out = Buffer.alloc(w * h * 3, 255);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = Math.min(im.w - 1, x0 + Math.floor(x / zoom));
        const sy = Math.min(im.h - 1, y0 + Math.floor(y / zoom));
        const p = (sy * im.w + sx) * im.st, q = (y * w + x) * 3;
        out[q] = im.d[p]; out[q + 1] = im.d[p + 1]; out[q + 2] = im.d[p + 2];
    }
    return { w, h, d: out };
}

function save(im, fp) {
    const rgba = Buffer.alloc(im.w * im.h * 4, 255);
    for (let i = 0; i < im.w * im.h; i++) {
        rgba[i * 4] = im.d[i * 3]; rgba[i * 4 + 1] = im.d[i * 3 + 1]; rgba[i * 4 + 2] = im.d[i * 3 + 2];
    }
    fs.writeFileSync(fp, jpeg.encode({ data: rgba, width: im.w, height: im.h }, 95).data);
}

const SHOTS = [
    ['hi_center', 0.50, 0.40, 0.14, 0.14, 3],
    ['hi_sun', 0.58, 0.50, 0.12, 0.12, 3],
    ['hi_sky', 0.66, 0.02, 0.16, 0.10, 3],
];

for (const [name, cx, cy, cw, ch, z] of SHOTS) {
    const a = crop(LR, cx, cy, cw, ch, z), b = crop(OURS, cx, cy, cw, ch, z);
    const gap = 8, w = a.w * 2 + gap, h = a.h;
    const rgba = Buffer.alloc(w * h * 4, 255);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let s;
            if (x < a.w) s = (y * a.w + x) * 3; else if (x >= a.w + gap) s = (y * b.w + x - a.w - gap) * 3; else continue;
            const src = x < a.w ? a.d : b.d;
            const q = (y * w + x) * 4;
            rgba[q] = src[s]; rgba[q + 1] = src[s + 1]; rgba[q + 2] = src[s + 2];
        }
    }
    const fp = path.join(OUT, name + '.jpg');
    fs.writeFileSync(fp, jpeg.encode({ data: rgba, width: w, height: h }, 95).data);
    console.log(fp, w + 'x' + h);
}
