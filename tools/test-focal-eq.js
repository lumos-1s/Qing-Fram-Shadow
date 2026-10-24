// 35mm 等效焦距回归测试(纯 node,不需要 Electron)
//   node tools/test-focal-eq.js
//
// 覆盖三件事:
//   ① 格式化 / 手动改焦距后的比例换算
//   ② JPEG EXIF 的 0xA405(FocalLengthIn35mmFilm)提取
//   ③ HEIC/HEIF 经 exifr 的字段映射(FocalLengthIn35mmFormat)
//
// 重点:不再按机型猜画幅。没有 0xA405 时保持原样,不许瞎给数字。
'use strict';

const path = require('path');
const F = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'focal-eq.js'));
const Exif = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'exif.js'));
const { mapHeicExif } = require(path.join(__dirname, '..', 'src', 'main', 'heic-exif.js'));

let fails = 0;
function ok(cond, label, extra) {
    if (cond) { console.log('  OK   ' + label); return; }
    fails++;
    console.log('  FAIL ' + label + (extra ? '   ' + extra : ''));
}

/* ── ① 焦距解析与格式化 ── */
ok(F.parseMm('50mm') === 50, 'parse 50mm');
ok(F.parseMm('24 mm') === 24, 'parse "24 mm"');
ok(F.parseMm('50') === 50, 'parse bare number');
ok(F.parseMm('7.3mm') === 7.3, 'parse decimal');
ok(F.parseMm('f/2.8') == null, 'aperture string rejected');
ok(F.parseMm('') == null && F.parseMm(null) == null, 'empty/null rejected');

ok(F.format('35mm', 53) === '53mm', 'APS-C 35mm → 53mm');
ok(F.format('50', 75) === '75mm', '裸数字直接显示换算值');
ok(F.format('50mm', 50) === '50mm', '全幅保持实际焦距');
ok(F.format('50mm', 0) === '50mm', '没有等效值保持原样');
ok(F.format('', 75) === '', '没有实际焦距保持空');
ok(F.format('35mm≈53mm', 53) === '53mm', '旧并列格式也会替换成单个换算值');
ok(F.format('f/2.8', 75) === 'f/2.8', '非焦距输入原样返回');
ok(F.format('35mm', 53).indexOf('35') === -1, '勾选后不再并列实际焦距');
// FILM/TICKET 等风格会对 focal 做 replace(/mm$/,'') + 'mm' 的再拼接;
// 格式必须仍以 mm 结尾,否则会出现 "53mm)mm" 之类的脏值。
const appendMm = s => String(s).replace(/\s*mm$/i, '') + 'mm';
ok(appendMm(F.format('35mm', 53)) === '53mm', '再拼 mm 的风格不被二次破坏');

ok(F.equivalentFor('35mm', '35mm', 53) === 53, '未改焦距:直接用 EXIF 等效值');
ok(F.equivalentFor('50mm', '35mm', 53) === 76, '手动改焦距:按原图比例换算');
ok(F.equivalentFor('50mm', '', 53) === 0, '缺少原图焦距:不换算');
ok(F.equivalentFor('35mm', '35mm', 0) === 0, '缺少 0xA405:不换算');

/* ── ② JPEG EXIF ── */
const jpegRaw = { 0x010F: 'FUJIFILM', 0x0110: 'X-T5', 0x920A: { num: 35, den: 1 }, 0xA405: 53 };
const jpeg = Exif.exifSummary(jpegRaw);
ok(jpeg.focal === '35mm', 'JPEG:实际焦距 35mm');
ok(jpeg.focal35 === 53, 'JPEG:读取 0xA405 = 53');
ok(Exif.exifSummary({ 0xA405: [75] }).focal35 === 75, 'JPEG:数组形式 0xA405 也能读');
ok(Exif.exifSummary({ 0xA405: 0 }).focal35 === undefined, 'JPEG:0xA405=0 视为没有');
ok(Exif.exifSummary({ 0x010F: 'Canon' }).focal35 === undefined, 'JPEG:没有 0xA405 不编造');

/* ── ③ HEIC/HEIF ── */
const heic = mapHeicExif({
    Make: 'Canon', Model: 'EOS R5', ExposureTime: 0.008, FNumber: 2.8,
    FocalLength: 50, FocalLengthIn35mmFormat: 75, ISO: 400
});
ok(heic.focal === '50mm', 'HEIC:实际焦距 50mm');
ok(heic.focal35 === 75, 'HEIC:读取 FocalLengthIn35mmFormat = 75');
ok(mapHeicExif({ FocalLengthIn35mmFilm: 53 }).focal35 === 53, 'HEIC:Film 命名变体也能读');
ok(mapHeicExif({ Make: 'Sony', Model: 'A7' }).focal35 === undefined, 'HEIC:没有该字段不编造');
ok(mapHeicExif(null).focal === undefined, 'HEIC:空输入不炸');

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
