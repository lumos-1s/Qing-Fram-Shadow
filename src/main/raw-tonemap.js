'use strict';

// RAW 显影的色调映射：LibRaw 给出 8bit sRGB（已去马赛克 + 相机白平衡 + 色彩矩阵），
// 这里把「曝光 / 对比 / 高光肩 / 色温 / 色调」折成三条 256 项查表，再逐像素套用。
//
// 为什么不逐像素算：24MP 每通道一次 Math.pow 要 2s 以上，拖不动滑块。而这几档调整
// 都是逐通道单调函数（色温色调只是通道增益），完全可以预先折进表里，全图只剩
// 三次查表 + 一次写 BGRA，24MP 约 150ms。
//
// 高光肩是逐通道做的：真实的高光压缩本来就会让高光去饱和，观感上比按亮度缩放更接近
// Lightroom；代价是极端色（纯红高光）会略掉饱和，这在 8bit 输出里可以接受。

const DEFAULTS = { exposure: 0, contrast: 0, highlights: 0, temperature: 0, tint: 0 };
const LIMITS = {
    exposure: [-5, 5],
    contrast: [-100, 100],
    highlights: [-100, 100],
    temperature: [-100, 100],
    tint: [-100, 100]
};

// sRGB 8bit → 线性。源数据是 LibRaw 编好的 sRGB，逆回去才能做曝光和肩部。
const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
    const c = i / 255;
    SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const linToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const num = (v, fb) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
};

// 参数一律裁剪到合法区间：URL / 草稿 / 旧版本都可能塞进越界值，越界会让查表溢出成黑边。
function normalize(params) {
    const p = params && typeof params === 'object' ? params : {};
    const out = {};
    for (const k of Object.keys(DEFAULTS)) {
        const [lo, hi] = LIMITS[k];
        out[k] = Math.min(hi, Math.max(lo, num(p[k], DEFAULTS[k])));
    }
    return out;
}

// 自动基线：把 99.7% 分位亮度映射到 0.9 线性，既不裁高光也不让欠曝的片子发灰。
// 这是"自动亮度"该有的做法——LibRaw 自带的自动亮度会为了拉亮中间调把高光切掉 0.13%。
function autoGain(src, colors, total) {
    const hist = new Uint32Array(256);
    const step = total > 4000000 ? 7 : 1; // 大图抽样即可，分位数不需要每个像素
    const ch = colors || 3;
    for (let i = 0; i < total; i += step) {
        const j = i * ch;
        const l = (src[j] * 77 + src[j + 1] * 150 + src[j + 2] * 29) >> 8;
        hist[l]++;
    }
    let seen = 0;
    let counted = 0;
    for (let i = 0; i < 256; i++) counted += hist[i];
    if (!counted) return 1;
    const target = counted * 0.997;
    let p = 255;
    for (let i = 0; i < 256; i++) {
        seen += hist[i];
        if (seen >= target) { p = i; break; }
    }
    const lin = SRGB_TO_LIN[p] || 0.0001;
    // 已经是亮的图（p 接近 255）gain 会被压在 1 附近；夜景也别一次拉过 3 倍。
    return Math.min(3, Math.max(0.5, 0.9 / Math.max(lin, 0.002)));
}

// 通道增益。色温在绿-红/蓝之间反向推，色调在绿-洋红之间推；系数取保守值，
// 滑块拉到头也不会变成滤镜，只是白平衡偏移。
function channelGains(p) {
    const t = p.temperature / 100;
    const g = p.tint / 100;
    return [
        1 + 0.32 * t + 0.10 * g,   // R：暖 → 加红，洋红 → 也加红
        1 - 0.12 * Math.abs(t) - 0.16 * g, // G：暖冷两头都略收绿，洋红收得更多
        1 - 0.30 * t + 0.10 * g    // B：暖 → 减蓝
    ];
}

function buildLut(params, gain) {
    const p = normalize(params);
    const g = channelGains(p);
    const expo = Math.pow(2, p.exposure);
    const hl = p.highlights / 100;
    // highlights > 0 提前压高光，< 0 反而把肩抬高（让高光更硬）
    const knee = Math.min(0.98, Math.max(0.35, 0.80 - 0.30 * hl));
    const contrast = p.contrast / 100;
    const lut = new Uint8Array(768);
    for (let c = 0; c < 3; c++) {
        const k = g[c] * gain * expo;
        for (let i = 0; i < 256; i++) {
            let v = SRGB_TO_LIN[i] * k;
            if (v > knee) {
                const over = v - knee;
                const room = 1 - knee;
                v = knee + room * (1 - Math.exp(-over / room));
            }
            let e = linToSrgb(clamp01(v));
            if (contrast) {
                const s = e * e * (3 - 2 * e); // smoothstep：中间调不变，两端拉开
                e = e + contrast * 0.62 * (s - e);
            }
            lut[c * 256 + i] = Math.round(clamp01(e) * 255);
        }
    }
    return lut;
}

// 缩放用面积平均（box）：缩小不会像最近邻那样出现锯齿，对代理图足够。
function resizeBox(src, sw, sh, dw, dh, channels) {
    if (dw === sw && dh === sh) return src;
    const out = new Uint8Array(dw * dh * 4);
    const xr = sw / dw;
    const yr = sh / dh;
    const ch = channels || 3;
    for (let y = 0; y < dh; y++) {
        const y0 = Math.floor(y * yr);
        const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil((y + 1) * yr)));
        for (let x = 0; x < dw; x++) {
            const x0 = Math.floor(x * xr);
            const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil((x + 1) * xr)));
            let r = 0, g = 0, b = 0, n = 0;
            for (let sy = y0; sy < y1; sy++) {
                let idx = (sy * sw + x0) * ch;
                for (let sx = x0; sx < x1; sx++) {
                    r += src[idx];
                    g += src[idx + 1];
                    b += src[idx + 2];
                    idx += ch;
                    n++;
                }
            }
            const o = (y * dw + x) * 4;
            out[o] = (r / n) | 0;
            out[o + 1] = (g / n) | 0;
            out[o + 2] = (b / n) | 0;
            out[o + 3] = 255;
        }
    }
    return out;
}

// 把已经缩好的 RGB 铺成 BGRA（nativeImage.createFromBitmap 要的顺序），顺手套表。
function toBgra(src, colors, width, height, lut) {
    const total = width * height;
    const out = new Uint8ClampedArray(total * 4);
    const ch = colors || 3;
    for (let i = 0; i < total; i++) {
        const s = i * ch;
        const o = i * 4;
        out[o] = lut[512 + src[s + 2]];
        out[o + 1] = lut[256 + src[s + 1]];
        out[o + 2] = lut[src[s]];
        out[o + 3] = 255;
    }
    return out;
}

module.exports = { DEFAULTS, LIMITS, normalize, autoGain, buildLut, resizeBox, toBgra, SRGB_TO_LIN };
