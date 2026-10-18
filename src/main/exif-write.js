'use strict';
// EXIF 写回:导出 JPEG 时把原图的 EXIF(APP1) 移植进成品 —— 机型/镜头/参数/拍摄时间随图走,
// 目标客群(摄影师)发图时保留拍摄信息;GPS 默认去除,显式勾选后才带出(隐私)。
//
// 工作方式(主进程,写盘前):
//   1. 从原图头部(≤256KB 窗口,与 exif-read.js 相同的读取策略)取出完整 APP1/Exif 段,
//      **整段字节拷贝** —— 不重新编码 TIFF,MakerNote 等厂商私有段原样保留,不会丢字段;
//   2. 只在拷贝副本上做三处手术:
//      a. Orientation(0x0112) 强制置 1:导出像素已按视觉方向烘进画布,不置 1 看图软件会再转一次;
//      b. IFD1(内嵌缩略图)指针清零:成品不该带一张「没加框的旧缩略图」;
//      c. keepGps=false 时:清空 GPS IFD 本体,并把 IFD0 的 GPS 指针(0x8825)整条删掉;
//   3. 插到导出 JPEG 的 SOI 之后(先移除导出流里可能已有的 APP1/Exif,防止双份)。
//
// 原则:任何一步失败都返回原字节 —— EXIF 是锦上添花,绝不能因此让导出失败。
//
// 只支持 JPEG(APP1 容器):PNG 的 eXIf chunk / WebP 的 EXIF chunk 位置不同,本模块跳过
// (applyExifToJpeg 认非 JPEG 输入直接原样返回)。

const fs = require('fs');
const { readHead, EXIF_HEAD_BYTES } = require('./exif-read');

function isJpeg(buf) {
    return !!buf && buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8;
}

// 扫 JPEG 段找 APP1/Exif。返回 { start, total, complete } 或 null。
// 走到 SOS(0xDA)就停 —— APP 段按规范都在首个 SOS 之前。
function findExifSegment(buf) {
    if (!isJpeg(buf)) return null;
    let off = 2;
    while (off + 4 <= buf.length) {
        if (buf[off] !== 0xFF) { off++; continue; }
        const marker = buf[off + 1];
        if (marker === 0xD8 || marker === 0xD9 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { off += 2; continue; }
        if (marker === 0xDA) break;
        const len = buf.readUInt16BE(off + 2);
        if (len < 2) break;
        if (marker === 0xE1 && len >= 10) {
            let isExif = true;
            for (let i = 0; i < 6; i++) if (buf[off + 4 + i] !== 'Exif\0\0'.charCodeAt(i)) { isExif = false; break; }
            if (isExif) {
                const total = 2 + len;
                return { start: off, total, complete: off + total <= buf.length };
            }
        }
        off += 2 + len;
    }
    return null;
}

// 从文件读完整 APP1/Exif 段(段不完整/没找到/读不了 → null)
async function readExifSegment(filePath) {
    try {
        if (!filePath) return null;
        const st = await fs.promises.stat(filePath).catch(() => null);
        if (!st || !st.isFile() || !st.size) return null;
        const head = await readHead(filePath, EXIF_HEAD_BYTES);
        const seg = findExifSegment(head);
        if (!seg || !seg.complete) return null;
        return Buffer.from(head.subarray(seg.start, seg.start + seg.total));
    } catch (e) { return null; }
}

// 三处手术,就地改 tiff(Buffer,从 'Exif\0\0' 之后开始)。返回 false = 结构看不懂,放弃移植。
// 注意:Orientation 的修补在删 GPS 条目之前做 —— 删条目会把后续条目整体前移,
// 先改值、再搬字节,补丁跟着字节一起走,不需要重定位。
function patchTiff(tiff, stripGps) {
    if (tiff.length < 8) return false;
    const be = tiff[0] === 0x4D && tiff[1] === 0x4D;
    const le = tiff[0] === 0x49 && tiff[1] === 0x49;
    if (!be && !le) return false;
    const u16 = (o) => be ? tiff.readUInt16BE(o) : tiff.readUInt16LE(o);
    const u32 = (o) => be ? tiff.readUInt32BE(o) : tiff.readUInt32LE(o);
    const w16 = (o, v) => be ? tiff.writeUInt16BE(v, o) : tiff.writeUInt16LE(v, o);
    const w32 = (o, v) => be ? tiff.writeUInt32BE(v, o) : tiff.writeUInt32LE(v, o);
    if (u16(2) !== 0x2A) return false;
    const ifd0 = u32(4);
    if (ifd0 + 2 > tiff.length) return false;
    const n = u16(ifd0);
    const entAt = ifd0 + 2;
    if (entAt + n * 12 + 4 > tiff.length) return false;

    let oriValAt = -1, gpsEnt = -1;
    for (let i = 0; i < n; i++) {
        const eo = entAt + i * 12;
        const tag = u16(eo);
        if (tag === 0x0112 && u16(eo + 2) === 3 && u32(eo + 4) >= 1) oriValAt = eo + 8;
        else if (tag === 0x8825 && gpsEnt < 0) gpsEnt = eo;
    }
    if (oriValAt >= 0) w16(oriValAt, 1);            // a. Orientation = 1

    const nextPtr = entAt + n * 12;
    w32(nextPtr, 0);                                 // b. IFD1(缩略图)不可达

    if (stripGps && gpsEnt >= 0) {
        // c1. 先把 GPS IFD 里外置的值区逐个清零(坐标就在这些 rational 里),再清 IFD 本体
        //     —— 不留"可被工具误扫"的明文位置数据
        const gpsOff = u32(gpsEnt + 8);
        if (gpsOff > 0 && gpsOff + 2 <= tiff.length) {
            const gm = u16(gpsOff);
            if (gpsOff + 2 + gm * 12 + 4 <= tiff.length) {
                const sizeMap = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
                for (let i = 0; i < gm; i++) {
                    const eo = gpsOff + 2 + i * 12;
                    const usize = sizeMap[u16(eo + 2)];
                    if (!usize) continue;
                    const dataLen = usize * u32(eo + 4);
                    if (dataLen > 4) {
                        const vo = u32(eo + 8);
                        if (vo > 0 && dataLen <= tiff.length - vo) tiff.fill(0, vo, vo + dataLen);
                    }
                }
                tiff.fill(0, gpsOff, gpsOff + 2 + gm * 12 + 4);
            }
        }
        // c2. 从 IFD0 删掉 GPS 指针条目:计数减 1,后续条目与 next 指针整体前移 12 字节
        w16(ifd0, n - 1);
        const from = gpsEnt + 12;
        const len = (entAt + n * 12 + 4) - from;
        if (len > 0) tiff.copyWithin(gpsEnt, from, from + len);
        tiff.fill(0, entAt + (n - 1) * 12 + 4, entAt + n * 12 + 4);  // 尾部 12 字节残迹清零
    }
    return true;
}

// 移除导出流里已有的 APP1/Exif(正常 canvas 导出没有,纯防御);返回可能新建的 Buffer
function stripExistingExif(buf) {
    let out = buf;
    for (let guard = 0; guard < 8; guard++) {
        const seg = findExifSegment(out);
        if (!seg || !seg.complete) return out;
        out = Buffer.concat([out.subarray(0, seg.start), out.subarray(seg.start + seg.total)]);
    }
    return out;
}

// 主入口:把 originalPath 的 EXIF 移植进 jpegBuf。keepGps=false(默认)时剥掉 GPS。
// 任何失败/非 JPEG/原图无 EXIF → 返回原 Buffer 本身。
async function applyExifToJpeg(jpegBuf, originalPath, keepGps) {
    try {
        if (!isJpeg(jpegBuf) || !originalPath) return jpegBuf;
        const seg = await readExifSegment(originalPath);
        if (!seg) return jpegBuf;
        const tiff = seg.subarray(10);               // 跳过 FF E1 + 长度(2) + 'Exif\0\0'(6)
        if (!patchTiff(tiff, !keepGps)) return jpegBuf;
        const base = stripExistingExif(jpegBuf);
        return Buffer.concat([base.subarray(0, 2), seg, base.subarray(2)]);
    } catch (e) {
        return jpegBuf;
    }
}

// 便捷入口:直接吃渲染层 exportImage/_gridFiles 组装的导出条目 { data(base64), originalPath, keepGps }。
// 主进程写盘 handler 与测试桩共用此函数,避免两处接线各自漂移。
async function applyExifToExportItem(f) {
    const buf = Buffer.from((f && f.data) || '', 'base64');
    if (!f || !f.originalPath) return buf;
    return applyExifToJpeg(buf, f.originalPath, !!f.keepGps);
}

module.exports = { applyExifToJpeg, applyExifToExportItem, findExifSegment };
