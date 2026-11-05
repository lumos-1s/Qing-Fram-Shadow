// 三格：修改前（把高光收口反解回去） | 修改后 | LR 导出。全分辨率同尺寸，1:1 裁切。
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const OUT = path.join(__dirname, 'out');
const load = (f) => {
    const j = jpeg.decode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 4096 });
    return { w: j.width, h: j.height, d: j.data };
};
const A = load(path.join(OUT, 'full_ours.jpg'));      // 修改后（含收口 + 平衡淡出）
const LR = load('C:/Users/lumos/Desktop/未命名导出/tint=50.jpg');

// 与 app-acr.js 里同一组锚点
const PTS = [[0, 1], [0.30, 1], [0.45, 0.962], [0.55, 0.948], [0.65, 0.936], [0.75, 0.912], [0.85, 0.890], [0.92, 0.894], [1, 1]];
function kOf(y) {
    let i = 0;
    while (i < PTS.length - 2 && y > PTS[i + 1][0]) i++;
    const [x0, y0] = PTS[i], [x1, y1] = PTS[i + 1];
    const t = Math.min(1, Math.max(0, (y - x0) / (x1 - x0)));
    return y0 + (y1 - y0) * t;
}
const s2l = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const l2s = (v) => { v = Math.max(0, Math.min(1, v)); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055); };
const BEFORE = { w: A.w, h: A.h, d: Buffer.alloc(A.w * A.h * 4, 255) };
for (let i = 0; i < A.w * A.h; i++) {
    const p = i * 4;
    const r = A.d[p], g = A.d[p + 1], b = A.d[p + 2];
    const y = 0.2126 * s2l(r) + 0.7152 * s2l(g) + 0.0722 * s2l(b);
    const k = y < 0.16 ? 1 : kOf(y);
    BEFORE.d[p] = l2s(s2l(r) / k); BEFORE.d[p + 1] = l2s(s2l(g) / k); BEFORE.d[p + 2] = l2s(s2l(b) / k);
}

function panel(im, x0, y0, W, H) {
    const o = Buffer.alloc(W * H * 3, 255);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const p = ((y0 + y) * im.w + (x0 + x)) * 4, q = (y * W + x) * 3;
        o[q] = im.d[p]; o[q + 1] = im.d[p + 1]; o[q + 2] = im.d[p + 2];
    }
    return o;
}

const SHOTS = [['fix_gap', 0.46, 0.38], ['fix_gap2', 0.52, 0.46]];
for (const [name, cx, cy] of SHOTS) {
    const W = 400, H = 290, gap = 8;
    const x0 = Math.round(cx * A.w), y0 = Math.round(cy * A.h);
    const a = panel(BEFORE, x0, y0, W, H), b = panel(A, x0, y0, W, H), c = panel(LR, x0, y0, W, H);
    const tw = W * 3 + gap * 2;
    const buf = Buffer.alloc(tw * H * 4, 255);
    for (let y = 0; y < H; y++) for (let x = 0; x < tw; x++) {
        let s = null, sx = 0;
        if (x < W) { s = a; sx = x; }
        else if (x >= W + gap && x < W * 2 + gap) { s = b; sx = x - W - gap; }
        else if (x >= W * 2 + gap * 2) { s = c; sx = x - W * 2 - gap * 2; }
        if (!s) continue;
        const q = (y * W + sx) * 3, d = (y * tw + x) * 4;
        buf[d] = s[q]; buf[d + 1] = s[q + 1]; buf[d + 2] = s[q + 2];
    }
    const fp = path.join(OUT, name + '.jpg');
    fs.writeFileSync(fp, jpeg.encode({ data: buf, width: tw, height: H }, 96).data);
    console.log(fp);
}
