'use strict';
// 把 8bit RGBA 的 PNG 重新编码成 RGB（去掉 alpha 通道）。
// iOS 的 1024 营销图标带 alpha 会被 App Store Connect 拒收，
// 而 Chromium 的 canvas 即使 alpha:false 也仍然输出 colorType 6，只能自己转。
const fs = require('fs');
const zlib = require('zlib');

const T = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
}
function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}
function decode(buf) {
    let i = 8, w = 0, h = 0, bd = 0, ct = 0;
    const idat = [];
    while (i < buf.length) {
        const len = buf.readUInt32BE(i);
        const type = buf.toString('ascii', i + 4, i + 8);
        const data = buf.subarray(i + 8, i + 8 + len);
        if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
        else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        i += 12 + len;
    }
    if (bd !== 8 || ct !== 6) throw new Error('只处理 8bit RGBA PNG');
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bpp = 4, stride = w * bpp;
    const out = Buffer.alloc(h * stride);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const cur = Buffer.alloc(stride);
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? cur[x - bpp] : 0;
            const b = prev[x];
            const c = x >= bpp ? prev[x - bpp] : 0;
            let v = line[x];
            if (f === 1) v = (v + a) & 255;
            else if (f === 2) v = (v + b) & 255;
            else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
            else if (f === 4) v = (v + paeth(a, b, c)) & 255;
            cur[x] = v;
        }
        cur.copy(out, y * stride);
        prev = cur;
    }
    return { w, h, rgba: out };
}
function encodeRgb(w, h, rgba) {
    const stride = w * 3;
    const raw = Buffer.alloc(h * (stride + 1));
    for (let y = 0; y < h; y++) {
        raw[y * (stride + 1)] = 0;
        for (let x = 0; x < w; x++) {
            const s = (y * w + x) * 4, d = y * (stride + 1) + 1 + x * 3;
            raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}
module.exports = function stripAlpha(file) {
    const { w, h, rgba } = decode(fs.readFileSync(file));
    fs.writeFileSync(file, encodeRgb(w, h, rgba));
    return { w, h };
};
