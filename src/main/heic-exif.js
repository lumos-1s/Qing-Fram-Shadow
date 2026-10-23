// HEIC/HEIF 的 EXIF:自定义 exif-read 只认 JPEG 段结构,这里用 exifr 直接按 HEIF box 解析。
// 输出保持和 exifSummary 同一套字段,渲染层的相机水印/参数条无需区分来源。
'use strict';

let exifr = null;
try {
    exifr = require('exifr');
} catch (e) {
    exifr = null;
}

// 只读 TIFF/EXIF 块;GPS 默认剥离,不进入参数条。
const OPTS = {
    tiff: true,
    gps: false,
    xmp: false,
    icc: false,
    iptc: false,
    jfif: false,
    ihdr: false,
    translateValues: false,
    reviveValues: false
};

async function readHeicExif(filePath) {
    if (!exifr) return {};
    let raw;
    try {
        raw = await exifr.parse(filePath, OPTS);
    } catch (e) {
        return {};
    }
    if (!raw) return {};
    const out = {};
    if (raw.Make) out.make = String(raw.Make).trim();
    if (raw.Model) out.model = String(raw.Model).trim();
    // libheif 解码时默认已应用 irot/imir 变换,照片已经是正的;这里不能再按 EXIF Orientation 转一次。
    out.orientation = 1;
    const t = Number(raw.ExposureTime);
    if (Number.isFinite(t) && t > 0) {
        out.shutter = t >= 1 ? `${t}s` : `1/${Math.round(1 / t)}s`;
    }
    const f = Number(raw.FNumber);
    if (Number.isFinite(f) && f > 0) out.aperture = 'f/' + f.toFixed(1).replace('.0', '');
    const fl = Number(raw.FocalLength);
    if (Number.isFinite(fl) && fl > 0) out.focal = Math.round(fl) + 'mm';
    const isoRaw = Array.isArray(raw.ISO) ? raw.ISO[0] : raw.ISO;
    const iso = Number(isoRaw);
    if (Number.isFinite(iso) && iso > 0) out.iso = 'ISO' + iso;
    return out;
}

module.exports = { readHeicExif };
