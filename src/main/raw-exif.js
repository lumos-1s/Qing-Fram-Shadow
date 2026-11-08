'use strict';

// RAW 的 EXIF：自定义 exif-read 只认 JPEG 段结构，这里用 exifr 按 TIFF 结构解析。
// 字段口径与 exifSummary 保持一致（相机水印/参数条不再区分来源），唯一区别是
// **保留 Orientation**：RAW 没有经过任何解码器旋转，方向要靠 EXIF 自己转。
let exifr = null;
try {
    exifr = require('exifr');
} catch (e) {
    exifr = null;
}

const OPTS = {
    tiff: true,
    gps: false,       // GPS 不进参数条，也不落草稿
    xmp: false,
    icc: false,
    iptc: false,
    jfif: false,
    ihdr: false,
    translateValues: false,
    reviveValues: false
};

function mapRawExif(raw) {
    if (!raw) return {};
    const out = {};
    if (raw.Make) out.make = String(raw.Make).trim();
    if (raw.Model) out.model = String(raw.Model).trim();
    // LibRaw 按 userFlip:-1 已经转过，这里恒为 1，避免渲染层再转一次（转两次=反的）。
    out.orientation = 1;
    const t = Number(raw.ExposureTime);
    if (Number.isFinite(t) && t > 0) out.shutter = t >= 1 ? `${t}s` : `1/${Math.round(1 / t)}s`;
    const f = Number(raw.FNumber);
    if (Number.isFinite(f) && f > 0) out.aperture = 'f/' + f.toFixed(1).replace('.0', '');
    const fl = Number(raw.FocalLength);
    if (Number.isFinite(fl) && fl > 0) out.focal = Math.round(fl) + 'mm';
    const f35Raw = raw.FocalLengthIn35mmFormat != null ? raw.FocalLengthIn35mmFormat : raw.FocalLengthIn35mmFilm;
    const f35 = Number(f35Raw);
    if (Number.isFinite(f35) && f35 > 0) out.focal35 = f35;
    const isoRaw = Array.isArray(raw.ISO) ? raw.ISO[0] : raw.ISO;
    const iso = Number(isoRaw);
    if (Number.isFinite(iso) && iso > 0) out.iso = 'ISO' + iso;
    if (raw.LensModel) out.lens = String(raw.LensModel).trim();
    return out;
}

async function readRawExif(filePath) {
    if (!exifr) return {};
    try {
        const raw = await exifr.parse(filePath, OPTS);
        return mapRawExif(raw);
    } catch (e) {
        return {};
    }
}

module.exports = { readRawExif, mapRawExif };
