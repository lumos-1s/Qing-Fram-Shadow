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

// 纯映射:和 exifSummary 的字段口径保持一致。抽出来是为了能直接单测,不必造 HEIC 文件。
function mapHeicExif(raw) {
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
    // FocalLengthIn35mmFormat = EXIF 0xA405;不同 exifr 版本/文件可能用 Film 命名,两种都收。
    const f35Raw = raw.FocalLengthIn35mmFormat != null ? raw.FocalLengthIn35mmFormat : raw.FocalLengthIn35mmFilm;
    const f35 = Number(f35Raw);
    if (Number.isFinite(f35) && f35 > 0) out.focal35 = f35;
    const isoRaw = Array.isArray(raw.ISO) ? raw.ISO[0] : raw.ISO;
    const iso = Number(isoRaw);
    if (Number.isFinite(iso) && iso > 0) out.iso = 'ISO' + iso;
    return out;
}

async function readHeicExif(filePath) {
    if (!exifr) return {};
    let raw;
    try {
        raw = await exifr.parse(filePath, OPTS);
    } catch (e) {
        return {};
    }
    return mapHeicExif(raw);
}

module.exports = { readHeicExif, mapHeicExif };
