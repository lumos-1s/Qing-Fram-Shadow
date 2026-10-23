// HEIC/HEIF 解码:Chromium 不支持 HEIC,这里用 libheif(WASM)在主进程转成 JPEG。
// 只在导入/预览时调用,不改变用户原文件;渲染进程通过 qflocal:// 拿到的仍是普通 JPEG。
'use strict';

const fs = require('fs');
const path = require('path');

let convert = null;
try {
    convert = require('heic-convert');
} catch (e) {
    convert = null;
}

const HEIC_EXTS = ['.heic', '.heif'];

function isHeic(filePath) {
    return HEIC_EXTS.includes(path.extname(String(filePath || '')).toLowerCase());
}

async function heicToJpeg(input, quality) {
    if (!convert) throw new Error('HEIC 解码组件未安装');
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const out = await convert({ buffer: buf, format: 'JPEG', quality: quality || 0.92 });
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

async function heicFileToJpeg(filePath, quality) {
    return heicToJpeg(await fs.promises.readFile(filePath), quality);
}

module.exports = { isHeic, heicToJpeg, heicFileToJpeg, HEIC_EXTS };
