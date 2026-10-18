// EXIF 写回(exif-write.js)回归测试 —— 纯 node,不需要 Electron
//   node tools/test-exif-write.js
//
// 覆盖:APP1 整段移植、Orientation 强制置 1(小端/大端/无标签)、IFD1 缩略图指针清零、
// GPS 剥离(默认,含外置 rational 值区)/保留(显式勾选)、已有 APP1 被替换而非叠加、
// 以及所有失败路径必须原样返回(导出绝不因 EXIF 受损)。
// 交叉验证:用渲染层同一份 exif.js 解析输出字节,确认字段可读、取向正确、GPS 按开关消失。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const exifUtil = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'exif.js'));
const { applyExifToJpeg } = require(path.join(__dirname, '..', 'src', 'main', 'exif-write.js'));

let fails = 0;
function ok(cond, label, extra) {
    if (cond) { console.log('  OK   ' + label); return; }
    fails++;
    console.log('  FAIL ' + label + (extra ? '   ' + extra : ''));
}

// ── 合成最小 TIFF:IFD0[Make, (Orientation), (GPSInfo)] + GPS IFD ──
// GPS IFD 两个条目:LatitudeRef(ASCII 2B,内联 —— 真机写法) + Latitude(RATIONAL×3,外置 24B)
// 返回 { buf, gpsIfdOff, gpsValOff, gpsValLen }(偏移相对 TIFF 起点;无 GPS 时 -1/0)
function buildTiff(opts) {
    const o = opts || {};
    const be = !!o.be;
    const gps = o.gps !== false;
    const orientation = (o.orientation === undefined) ? 6 : o.orientation;   // null = 不带标签
    const make = o.make || 'Canon';
    const nextIfd = (o.nextIfd === undefined) ? 0xFFFF : o.nextIfd;          // 非 0,验证会被清零

    const nEnt = 1 + (orientation == null ? 0 : 1) + (gps ? 1 : 0);
    const ifd0Len = 2 + nEnt * 12 + 4;
    const makeOff = 8 + ifd0Len;
    const gpsIfdOff = makeOff + 6;
    const gpsIfdLen = 2 + 2 * 12 + 4;
    const gpsValOff = gpsIfdOff + gpsIfdLen;
    const gpsValLen = 24;                                                    // RATIONAL × 3
    const size = gps ? gpsValOff + gpsValLen : makeOff + 6;

    const b = Buffer.alloc(size);
    const w16 = (off, v) => be ? b.writeUInt16BE(v, off) : b.writeUInt16LE(v, off);
    const w32 = (off, v) => be ? b.writeUInt32BE(v, off) : b.writeUInt32LE(v, off);
    if (be) { b[0] = 0x4D; b[1] = 0x4D; } else { b[0] = 0x49; b[1] = 0x49; }
    w16(2, 42);
    w32(4, 8);

    w16(8, nEnt);
    let e = 10;
    w16(e, 0x010F); w16(e + 2, 2); w32(e + 4, 6); w32(e + 8, makeOff); e += 12;  // Make
    if (orientation != null) { w16(e, 0x0112); w16(e + 2, 3); w32(e + 4, 1); w16(e + 8, orientation); e += 12; }
    if (gps) { w16(e, 0x8825); w16(e + 2, 4); w32(e + 4, 1); w32(e + 8, gpsIfdOff); e += 12; }
    w32(e, nextIfd);

    const mk = (make + '\0').slice(0, 6);
    b.write(mk, makeOff, 'latin1');
    if (gps) {
        w16(gpsIfdOff, 2);
        //  ref:ASCII count2 内联 'N\0'
        w16(gpsIfdOff + 2, 0x0001); w16(gpsIfdOff + 4, 2); w32(gpsIfdOff + 6, 2);
        b.write('N\0', gpsIfdOff + 10, 'latin1');
        //  lat:RATIONAL count3 → 外置值区
        w16(gpsIfdOff + 14, 0x0002); w16(gpsIfdOff + 16, 5); w32(gpsIfdOff + 18, 3); w32(gpsIfdOff + 22, gpsValOff);
        w32(gpsIfdOff + 26, 0);
        b.fill(0x11, gpsValOff, gpsValOff + gpsValLen);   // 非零图案:剥离时须清零,保留时须原样
    }
    return {
        buf: b,
        gpsIfdOff: gps ? gpsIfdOff : -1,
        gpsValOff: gps ? gpsValOff : -1,
        gpsValLen: gps ? gpsValLen : 0
    };
}

// ── 合成 JPEG:SOI + APP0(JFIF) + [APP1(Exif)] + SOS 头 + 熵数据 + EOI ──
function buildJpeg(tiff) {
    const parts = [Buffer.from([0xFF, 0xD8])];
    const app0 = Buffer.alloc(2 + 16);
    app0[0] = 0xFF; app0[1] = 0xE0; app0.writeUInt16BE(16, 2); app0.write('JFIF\0', 4, 'latin1');
    parts.push(app0);
    if (tiff) {
        const h = Buffer.alloc(4);
        h[0] = 0xFF; h[1] = 0xE1; h.writeUInt16BE(2 + 6 + tiff.length, 2);
        parts.push(h, Buffer.from('Exif\0\0', 'latin1'), tiff);
    }
    parts.push(Buffer.from([0xFF, 0xDA, 0x00, 0x08, 1, 2, 3, 4, 5, 6, 0xFF, 0xD9]));
    return Buffer.concat(parts);
}

function parseOut(buf) {
    return exifUtil.parseExif(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function countApp1(buf) {
    let n = 0, off = 2;
    while (off + 4 <= buf.length) {
        if (buf[off] !== 0xFF) { off++; continue; }
        const m = buf[off + 1];
        if (m === 0xD8 || m === 0xD9 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { off += 2; continue; }
        if (m === 0xDA) break;
        const len = buf.readUInt16BE(off + 2);
        if (m === 0xE1 && len >= 10 && buf.toString('latin1', off + 4, off + 10) === 'Exif\0\0') n++;
        off += 2 + len;
    }
    return n;
}

(async () => {
    console.log('EXIF 写回回归(纯 node)');
    console.log('─'.repeat(64));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-exif-'));
    try {
        const t1 = buildTiff({ orientation: 6, gps: true });
        const origPath = path.join(dir, 'orig.jpg');
        fs.writeFileSync(origPath, buildJpeg(t1.buf));

        // 模拟 canvas 导出:无 APP1
        const exported = buildJpeg(null);
        const tb = 2 + 4 + 6;   // 输出里 TIFF 起点(SOI2 + 段头4 + 'Exif\0\0'6)

        // ① 默认:剥 GPS(IFD 本体 + 外置 rational 值区)
        const out = await applyExifToJpeg(exported, origPath, false);
        const raw = parseOut(out);
        ok(out[0] === 0xFF && out[1] === 0xD8, '输出仍是 JPEG(FFD8 开头)');
        ok(countApp1(out) === 1, '恰好一段 APP1/Exif', 'got ' + countApp1(out));
        ok(raw[0x010F] === 'Canon', 'Make 随 EXIF 带过来');
        ok(raw[0x0112] === 1, 'Orientation 强制置 1(原图 6)', 'got ' + raw[0x0112]);
        ok(raw[0x8825] === undefined && raw[1] === undefined, 'GPS 指针与 GPS IFD 均被剥离');
        ok(out.readUInt16LE(tb + 8) === 2, 'IFD0 条目数减 1(3→2)', 'got ' + out.readUInt16LE(tb + 8));
        ok(out.readUInt32LE(tb + 8 + 2 + 2 * 12) === 0, 'IFD1(缩略图)指针清零');
        ok(out.subarray(tb + t1.gpsIfdOff, tb + t1.gpsValOff).every(v => v === 0), 'GPS IFD 本体清零');
        ok(out.subarray(tb + t1.gpsValOff, tb + t1.gpsValOff + t1.gpsValLen).every(v => v === 0), 'GPS 外置坐标值区清零');
        ok(out.subarray(out.length - (exported.length - 2)).equals(exported.subarray(2)), '导出流其余字节逐字节不变');

        // ② 显式保留 GPS:位置在,外置值区原样,缩略图指针仍清零
        const outGps = await applyExifToJpeg(exported, origPath, true);
        const rawG = parseOut(outGps);
        ok(rawG[1] === 'N' && rawG[0x8825] !== undefined, '勾选保留 GPS 时位置信息在');
        ok(outGps.subarray(tb + t1.gpsValOff, tb + t1.gpsValOff + t1.gpsValLen).every(v => v === 0x11), '保留时外置值区原样');
        ok(rawG[0x0112] === 1, '有 GPS 时 Orientation 仍为 1');
        ok(outGps.readUInt16LE(tb + 8) === 3, '保留时 IFD0 条目数不变(3)');
        ok(outGps.readUInt32LE(tb + 8 + 2 + 3 * 12) === 0, '缩略图指针同样清零');

        // ③ 大端(Motorola)TIFF
        const bePath = path.join(dir, 'be.jpg');
        fs.writeFileSync(bePath, buildJpeg(buildTiff({ be: true, orientation: 8, gps: true }).buf));
        const rawBe = parseOut(await applyExifToJpeg(exported, bePath, false));
        ok(rawBe[0x0112] === 1 && rawBe[0x010F] === 'Canon', '大端 TIFF 同样可移植且置 1');

        // ④ 原图没有 Orientation 标签:只移植,不报错
        const noOriPath = path.join(dir, 'noori.jpg');
        fs.writeFileSync(noOriPath, buildJpeg(buildTiff({ orientation: null, gps: true }).buf));
        const outNo = await applyExifToJpeg(exported, noOriPath, false);
        ok(countApp1(outNo) === 1 && parseOut(outNo)[0x010F] === 'Canon', '无 Orientation 标签也能移植');

        // ⑤ 失败路径:一律原样返回(同一份字节)
        const plainPath = path.join(dir, 'plain.jpg');
        fs.writeFileSync(plainPath, buildJpeg(null));
        ok((await applyExifToJpeg(exported, plainPath, false)).equals(exported), '原图无 EXIF → 原样返回');
        ok((await applyExifToJpeg(exported, path.join(dir, 'nope.jpg'), false)).equals(exported), '原图不存在 → 原样返回');
        const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]);
        ok((await applyExifToJpeg(png, origPath, false)).equals(png), '导出流不是 JPEG(PNG)→ 原样返回');

        // ⑥ 导出流里已有旧 APP1(防御):先移除再插,不出现双份
        const stale = buildJpeg(buildTiff({ make: 'OLD', orientation: 3, gps: false }).buf);
        const outDup = await applyExifToJpeg(stale, origPath, false);
        ok(countApp1(outDup) === 1 && parseOut(outDup)[0x010F] === 'Canon', '已有 APP1 会被替换而不是叠加');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('─'.repeat(64));
    console.log(fails ? `✖ ${fails} 项未通过` : '✓ 全部通过');
    process.exit(fails ? 1 : 0);
})().catch((e) => {
    console.error('测试自身异常:', e && e.stack || e);
    process.exit(1);
});
