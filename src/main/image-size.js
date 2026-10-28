// 轻量图片尺寸读取:只读文件头部,避免为了判断"是不是 300MP 巨图"先把整张图解码进内存。
// 支持 JPEG / PNG / GIF / BMP / WebP / HEIC(ispe);读不出时返回 null,由调用方决定是否放行。
const fs = require('fs');

function fromJpeg(buf) {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let off = 2;
    while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        if (marker === 0xff) { off++; continue; }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
        if (marker === 0xda || marker === 0xd9) break;
        const size = buf.readUInt16BE(off + 2);
        if (size < 2 || off + 2 + size > buf.length) break;
        const isSof = (marker >= 0xc0 && marker <= 0xc3) ||
            (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) ||
            (marker >= 0xcd && marker <= 0xcf);
        if (isSof) {
            const height = buf.readUInt16BE(off + 5);
            const width = buf.readUInt16BE(off + 7);
            return width && height ? { width, height } : null;
        }
        off += 2 + size;
    }
    return null;
}

function fromPng(buf) {
    if (buf.length < 24 || buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width && height ? { width, height } : null;
}

function fromGif(buf) {
    if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'GIF') return null;
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function fromBmp(buf) {
    if (buf.length < 26 || buf.toString('ascii', 0, 2) !== 'BM') return null;
    const width = buf.readInt32LE(18);
    const height = Math.abs(buf.readInt32LE(22));
    return width && height ? { width: Math.abs(width), height } : null;
}

function fromWebp(buf) {
    if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
        const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return { width, height };
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
        const b1 = buf[21], b2 = buf[22], b3 = buf[23], b4 = buf[24];
        return {
            width: 1 + (((b2 & 0x3f) << 8) | b1),
            height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))
        };
    }
    return null;
}

function fromHeic(buf) {
    // HEIC 的 ispe box: size(4) + 'ispe'(4) + version/flags(4) + width(4) + height(4)
    // 一张图里可能有缩略图和主图两个 ispe,取最大的一组。
    let best = null;
    let from = 0;
    for (;;) {
        const at = buf.indexOf('ispe', from, 'ascii');
        if (at < 0) break;
        from = at + 4;
        if (at + 16 > buf.length) continue;
        const width = buf.readUInt32BE(at + 8);
        const height = buf.readUInt32BE(at + 12);
        if (!width || !height) continue;
        if (!best || width * height > best.width * best.height) best = { width, height };
    }
    return best;
}

const parse = (head) => fromPng(head) || fromJpeg(head) || fromGif(head) || fromBmp(head) || fromWebp(head) || fromHeic(head);

// 返回 { width, height } 或 null。两段式读取:先 64KB(绝大多数 JPEG/PNG 足够),
// 读不出再补到 1MB,避免为了判断尺寸把整批照片的头部都读成大缓冲。
function imageSize(filePath) {
    let fd = null;
    try {
        fd = fs.openSync(filePath, 'r');
        const st = fs.fstatSync(fd);
        const firstLen = Math.min(st.size, 64 * 1024);
        if (!firstLen) return null;
        const first = Buffer.alloc(firstLen);
        const n1 = fs.readSync(fd, first, 0, firstLen, 0);
        let dim = parse(first.subarray(0, n1));
        if (dim || st.size <= firstLen) return dim;
        const secondLen = Math.min(st.size, 1024 * 1024);
        const second = Buffer.alloc(secondLen);
        const n2 = fs.readSync(fd, second, 0, secondLen, 0);
        dim = parse(second.subarray(0, n2));
        return dim;
    } catch (e) {
        return null;
    } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
    }
}

module.exports = { imageSize };
