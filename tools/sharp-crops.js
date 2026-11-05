/* 1:1 锐化三格：左=我们（不锐化） 中=我们（当前锐化） 右=LR 导出
 * 不做缩放，直接按原分辨率裁切，任何重采样都会掩盖真实的锐度差。
 */
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const OUT = path.join(__dirname, 'out');
const load = (f) => {
    const j = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
    return { w: j.width, h: j.height, d: j.data };
};

const NOSHARP = load(path.join(OUT, 'full_nosharp.jpg'));
const OURS = load(path.join(OUT, process.env.SHARP || 'full_sharp3.jpg'));
const LR = load('C:/Users/lumos/Desktop/未命名导出/tint=50.jpg');

const RECTS = {
    wall: [0.10, 0.42, 0.070, 0.055],
    leaves: [0.46, 0.38, 0.070, 0.055],
    edge: [0.30, 0.52, 0.070, 0.055],
};

const GAP = 8;
for (const [name, r] of Object.entries(RECTS)) {
    const x0 = Math.round(r[0] * NOSHARP.w), y0 = Math.round(r[1] * NOSHARP.h);
    const W = Math.round(r[2] * NOSHARP.w), H = Math.round(r[3] * NOSHARP.h);
    const tw = W * 3 + GAP * 2;
    const out = Buffer.alloc(tw * H * 4, 255);
    const panels = [NOSHARP, OURS, LR];
    for (let y = 0; y < H; y++) {
        for (let p = 0; p < 3; p++) {
            const im = panels[p];
            const dx0 = p * (W + GAP);
            for (let x = 0; x < W; x++) {
                const sp = ((y0 + y) * im.w + (x0 + x)) * 4;
                const dp = (y * tw + dx0 + x) * 4;
                out[dp] = im.d[sp]; out[dp + 1] = im.d[sp + 1]; out[dp + 2] = im.d[sp + 2];
            }
        }
    }
    const fp = path.join(OUT, 'sharp_' + name + '.jpg');
    fs.writeFileSync(fp, jpeg.encode({ data: out, width: tw, height: H }, 96).data);
    console.log(path.basename(fp), tw + 'x' + H);
}
