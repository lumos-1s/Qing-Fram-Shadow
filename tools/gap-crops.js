// 三格：源 JPEG | 我们的渲染 | LR 导出。用来判断高光那块的细节到底是「源里就没有」
// 还是「我们有但被链路冲掉了」。
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const OUT = path.join(__dirname, 'out');
const load = (f) => {
    const j = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
    return { w: j.width, h: j.height, d: j.data, st: 4 };
};
const SRC = load('C:/Users/lumos/Desktop/新建文件夹/DSC09381.jpg');
const LR = load('C:/Users/lumos/Desktop/未命名导出/tint=50.jpg');
const OURS = load(path.join(OUT, 'full_ours.jpg'));

// 统一到归一化坐标取块，各自用自己分辨率
function crop(im, cx, cy, cw, ch, ow, oh) {
    const out = Buffer.alloc(ow * oh * 3, 255);
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
        const u = cx + (x + 0.5) / ow * cw, v = cy + (y + 0.5) / oh * ch;
        const sx = Math.min(im.w - 1, Math.max(0, Math.round(u * im.w - 0.5)));
        const sy = Math.min(im.h - 1, Math.max(0, Math.round(v * im.h - 0.5)));
        const p = (sy * im.w + sx) * im.st, q = (y * ow + x) * 3;
        out[q] = im.d[p]; out[q + 1] = im.d[p + 1]; out[q + 2] = im.d[p + 2];
    }
    return out;
}
function save(buf, w, h, fp, quality) {
    const rgba = Buffer.alloc(w * h * 4, 255);
    for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = buf[i * 3]; rgba[i * 4 + 1] = buf[i * 3 + 1]; rgba[i * 4 + 2] = buf[i * 3 + 2];
    }
    fs.writeFileSync(fp, jpeg.encode({ data: rgba, width: w, height: h }, quality || 95).data);
}

const SHOTS = process.argv[2] === 'wall'
    ? [['gap_wall', 0.06, 0.30, 0.16, 0.16]]
    : [['gap_center', 0.44, 0.36, 0.16, 0.16], ['gap_sun', 0.55, 0.47, 0.14, 0.14]];

for (const [name, cx, cy, cw, ch] of SHOTS) {
    const W = 520, H = Math.round(W * ch / cw);
    const a = crop(SRC, cx, cy, cw, ch, W, H);
    const b = crop(OURS, cx, cy, cw, ch, W, H);
    const c = crop(LR, cx, cy, cw, ch, W, H);
    const gap = 8, tw = W * 3 + gap * 2;
    const buf = Buffer.alloc(tw * H * 3, 255);
    for (let y = 0; y < H; y++) for (let x = 0; x < tw; x++) {
        const q = (y * tw + x) * 3;
        let src = null, sx = 0;
        if (x < W) { src = a; sx = x; } else if (x >= W + gap && x < W * 2 + gap) { src = b; sx = x - W - gap; }
        else if (x >= W * 2 + gap * 2) { src = c; sx = x - W * 2 - gap * 2; }
        if (!src) continue;
        const s = (y * W + sx) * 3;
        buf[q] = src[s]; buf[q + 1] = src[s + 1]; buf[q + 2] = src[s + 2];
    }
    const fp = path.join(OUT, name + '.jpg');
    save(buf, tw, H, fp);
    console.log(fp, tw + 'x' + H);
}
