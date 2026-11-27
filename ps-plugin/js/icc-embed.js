'use strict';
/* 给 canvas 生成的 JPEG 嵌入 ICC_PROFILE APP2 段（与桌面 src/main/icc-write.js 同口径）。
   不嵌 ICC 的话 PS 会把 Adobe RGB 像素当成 sRGB 再转换一次，颜色会错。 */
(function () {
    function b64ToBytes(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    function bytesToB64(bytes) {
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(bin);
    }
    function u16(buf, off) { return (buf[off] << 8) | buf[off + 1]; }
    function setU16(buf, off, v) { buf[off] = (v >> 8) & 255; buf[off + 1] = v & 255; }

    function embed(jpegB64, profileB64) {
        const src = b64ToBytes(jpegB64);
        const profile = b64ToBytes(profileB64);
        if (src[0] !== 0xFF || src[1] !== 0xD8 || !profile.length) return jpegB64;

        // 已有 ICC 先剥掉（最多 8 段）
        let base = src;
        for (let guard = 0; guard < 8; guard++) {
            let off = 2, found = -1, size = 0;
            while (off + 4 <= base.length) {
                if (base[off] !== 0xFF) { off++; continue; }
                const marker = base[off + 1];
                if (marker === 0xD8 || marker === 0xD9 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
                    off += 2; continue;
                }
                if (marker === 0xDA) break;
                const len = u16(base, off + 2);
                if (len < 2) break;
                if (marker === 0xE2 && len >= 14) {
                    let sig = '';
                    for (let k = off + 4; k < off + 15; k++) sig += String.fromCharCode(base[k]);
                    if (sig === 'ICC_PROFILE\0') { found = off; size = 2 + len; break; }
                }
                off += 2 + len;
            }
            if (found < 0) break;
            const next = new Uint8Array(base.length - size);
            next.set(base.subarray(0, found), 0);
            next.set(base.subarray(found + size), found);
            base = next;
        }

        const name = 'ICC_PROFILE\0';
        const payload = new Uint8Array(name.length + 2 + profile.length);
        for (let i = 0; i < name.length; i++) payload[i] = name.charCodeAt(i);
        payload[name.length] = 1; payload[name.length + 1] = 1;
        payload.set(profile, name.length + 2);

        const seg = new Uint8Array(4 + payload.length);
        seg[0] = 0xFF; seg[1] = 0xE2;
        setU16(seg, 2, payload.length + 2);
        seg.set(payload, 4);

        const out = new Uint8Array(2 + seg.length + (base.length - 2));
        out.set(base.subarray(0, 2), 0);
        out.set(seg, 2);
        out.set(base.subarray(2), 2 + seg.length);
        return bytesToB64(out);
    }

    window.QF_IccEmbed = { embed };
})();
