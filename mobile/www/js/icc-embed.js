'use strict';
/* 浏览器版 ICC profile 生成 + JPEG APP2 嵌入。
 * 算法与 src/shared/icc-profile.js / src/main/icc-write.js 同源，
 * 只是把 Node Buffer 换成 Uint8Array/DataView，供手机端 WebView 使用。
 * 注意：只写 JPEG。PNG/WebP 不嵌入，UI 会限制宽色域仅 JPEG 生效。 */
(function () {
    const D65 = [0.3127, 0.3290];
    const D50 = [0.9642, 1.0, 0.8249];
    const DEFS = {
        p3: { name: 'Display P3', r: [0.680, 0.320], g: [0.265, 0.690], b: [0.150, 0.060], trc: 'srgb' },
        adobergb: { name: 'Adobe RGB (1998)', r: [0.640, 0.330], g: [0.210, 0.710],
            b: [0.150, 0.060], trc: 'gamma', gamma: 563 / 256 }
    };
    const BRADFORD = [
        [1.0478112, 0.0228866, -0.0501270],
        [0.0295424, 0.9904844, -0.0170491],
        [-0.0092345, 0.0150436, 0.7521316]
    ];

    function u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v); return b; }
    function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); return b; }
    function i32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v); return b; }
    function ascii(s) {
        const b = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
        return b;
    }
    function concat() {
        let n = 0;
        for (let i = 0; i < arguments.length; i++) n += arguments[i].length;
        const out = new Uint8Array(n);
        let p = 0;
        for (let i = 0; i < arguments.length; i++) { out.set(arguments[i], p); p += arguments[i].length; }
        return out;
    }
    function zero(n) { return new Uint8Array(n); }
    function xyYToXYZ(x, y, Y) {
        if (!y) return [0, 0, 0];
        return [x * Y / y, Y, (1 - x - y) * Y / y];
    }
    function matVec(m, v) {
        return [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
    }
    function inv3(m) {
        const a = m[0][0], b = m[0][1], c = m[0][2];
        const d = m[1][0], e = m[1][1], f = m[1][2];
        const g = m[2][0], h = m[2][1], i = m[2][2];
        const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
        const det = a * A + d * B + g * C;
        if (!det) return null;
        return [[A / det, B / det, C / det],
            [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
            [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det]];
    }
    function fixed(v) {
        return i32(Math.round(Math.max(-32768, Math.min(32767.9999, v)) * 65536));
    }
    function xyzTag(xyz) {
        return concat(ascii('XYZ '), zero(4), fixed(xyz[0]), fixed(xyz[1]), fixed(xyz[2]));
    }
    function curveTag(def) {
        if (def.trc === 'srgb') {
            const n = 256;
            const b = new Uint8Array(12 + n * 2);
            b.set(ascii('curv'), 0);
            b.set(u32(n), 8);
            for (let i = 0; i < n; i++) {
                const v = i / (n - 1);
                const lin = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
                b.set(u16(Math.round(lin * 65535)), 12 + i * 2);
            }
            return b;
        }
        const b = new Uint8Array(16);
        b.set(ascii('curv'), 0);
        b.set(u32(1), 8);
        b.set(u16(Math.round(def.gamma * 256)), 12);
        return b;
    }
    function descTag(text) {
        const body = ascii(text + '\0');
        const raw = concat(u32(body.length), body, zero(12));
        const pad = (4 - raw.length % 4) % 4;
        return concat(ascii('desc'), zero(4), raw, zero(pad));
    }

    const cache = {};
    function profileBytes(id) {
        if (cache[id]) return cache[id];
        const def = DEFS[id];
        if (!def) return null;
        const white = xyYToXYZ(D65[0], D65[1], 1);
        const raw = [def.r, def.g, def.b].map((p) => xyYToXYZ(p[0], p[1], 1));
        const M = [[raw[0][0], raw[1][0], raw[2][0]],
            [raw[0][1], raw[1][1], raw[2][1]],
            [raw[0][2], raw[1][2], raw[2][2]]];
        const mins = matVec(inv3(M), white);
        const adapted = raw.map((c, i) => matVec(BRADFORD, c.map((v) => v * mins[i])));
        const sum = [0, 1, 2].map((k) => adapted.reduce((s, c) => s + c[k], 0));
        adapted.forEach((c) => { for (let k = 0; k < 3; k++) c[k] *= D50[k] / sum[k]; });
        const tags = {
            desc: descTag(def.name), wtpt: xyzTag(D50),
            rXYZ: xyzTag(adapted[0]), gXYZ: xyzTag(adapted[1]), bXYZ: xyzTag(adapted[2]),
            rTRC: curveTag(def), gTRC: curveTag(def), bTRC: curveTag(def)
        };
        const names = Object.keys(tags).sort();
        let offset = 128 + 4 + 12 * names.length;
        const table = new Uint8Array(4 + 12 * names.length);
        table.set(u32(names.length), 0);
        const parts = [];
        names.forEach((name, i) => {
            table.set(ascii(name), 4 + i * 12);
            table.set(u32(offset), 8 + i * 12);
            table.set(u32(tags[name].length), 12 + i * 12);
            parts.push(tags[name]);
            const pad = (4 - tags[name].length % 4) % 4;
            if (pad) parts.push(zero(pad));
            offset += tags[name].length + pad;
        });
        const header = new Uint8Array(128);
        header.set(u32(offset), 0);
        header.set(u32(0x02100000), 8);
        header.set(ascii('mntr'), 12);
        header.set(ascii('RGB '), 16);
        header.set(ascii('XYZ '), 20);
        header.set(ascii('acsp'), 36);
        header.set(u32(0), 64);
        header.set(fixed(D50[0]), 68);
        header.set(fixed(D50[1]), 72);
        header.set(fixed(D50[2]), 76);
        cache[id] = concat.apply(null, [header, table].concat(parts));
        return cache[id];
    }

    function isJpeg(b) { return !!b && b.length > 3 && b[0] === 0xff && b[1] === 0xd8; }
    const ICC_NAME = ascii('ICC_PROFILE\0');
    function sameAt(buf, off, pat) {
        if (off + pat.length > buf.length) return false;
        for (let i = 0; i < pat.length; i++) if (buf[off + i] !== pat[i]) return false;
        return true;
    }
    function stripIcc(buf) {
        let out = buf;
        for (let guard = 0; guard < 8; guard++) {
            let off = 2, found = -1, total = 0;
            const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
            while (off + 4 <= out.length) {
                if (out[off] !== 0xff) { off++; continue; }
                const marker = out[off + 1];
                if (marker === 0xd8 || marker === 0xd9 || marker === 0x01
                    || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
                if (marker === 0xda) break;
                const len = dv.getUint16(off + 2);
                if (len < 2) break;
                if (marker === 0xe2 && len >= 14 && sameAt(out, off + 4, ICC_NAME)) {
                    found = off; total = 2 + len; break;
                }
                off += 2 + len;
            }
            if (found < 0) return out;
            out = concat(out.subarray(0, found), out.subarray(found + total));
        }
        return out;
    }
    function applyIccToJpeg(bytes, cs) {
        const profile = profileBytes(cs);
        if (!isJpeg(bytes) || !profile) return bytes;
        try {
            const base = stripIcc(bytes);
            const payload = concat(ICC_NAME, new Uint8Array([1, 1]), profile);
            const seg = new Uint8Array(4 + payload.length);
            seg[0] = 0xff; seg[1] = 0xe2;
            seg.set(u16(payload.length + 2), 2);
            seg.set(payload, 4);
            return concat(base.subarray(0, 2), seg, base.subarray(2));
        } catch (_) { return bytes; }
    }

    window.QfsIcc = { DEFS, profileBytes, applyIccToJpeg };
})();
