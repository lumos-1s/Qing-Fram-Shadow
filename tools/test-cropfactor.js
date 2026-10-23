// 等效焦距换算回归测试(纯 node,不需要 Electron)
//   node tools/test-cropfactor.js
//
// 覆盖 src/renderer/js/cropfactor.js 的三件事:
//   ① parseFocalMm  — "50mm"/"50 mm"/"50" 都能解析,垃圾输入返回 null
//   ② guessCropFactor — 常见机型画幅判定:全幅/APS-C(含 Canon 1.6)/M4/3/中画幅/小底,
//     重点防子串误伤(Nikon Z50≠Z5、D7000≠D700、Canon EOS R5≠R50)
//   ③ formatFocalWithEq — 换算拼接格式;认不出画幅或全幅(1.0)时必须原样返回
//
// 手机传感器规格五花八门,规则表明确返回 null(不显示等效值),这里也测掉。
'use strict';

const path = require('path');
const CF = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'cropfactor.js'));

let fails = 0;
function ok(cond, label, extra) {
    if (cond) { console.log('  OK   ' + label); return; }
    fails++;
    console.log('  FAIL ' + label + (extra ? '   ' + extra : ''));
}

/* ── ① 焦距解析 ── */
ok(CF.parseFocalMm('50mm') === 50, 'parse 50mm');
ok(CF.parseFocalMm('24 mm') === 24, 'parse "24 mm"');
ok(CF.parseFocalMm('50') === 50, 'parse bare number');
ok(CF.parseFocalMm('7.3mm') === 7.3, 'parse decimal');
ok(CF.parseFocalMm('f/2.8') == null, 'aperture string rejected');
ok(CF.parseFocalMm('') == null && CF.parseFocalMm(null) == null, 'empty/null rejected');

/* ── ② 画幅判定(裁切系数) ── */
const F = (make, model) => CF.guessCropFactor(make, model);
ok(F('SONY', 'ILCE-7M4') === 1.0, 'Sony A7M4 全幅');
ok(F('SONY', 'ILCE-6400') === 1.5, 'Sony A6400 APS-C');
ok(F('SONY', 'ZV-E10') === 1.5, 'Sony ZV-E10 APS-C');
ok(F('SONY', 'DSC-RX100M7') === 2.7, 'Sony RX100 1 英寸');
ok(F('Canon', 'Canon EOS R5') === 1.0, 'Canon R5 全幅');
ok(F('Canon', 'Canon EOS R50') === 1.6, 'Canon R50 APS-C 1.6');
ok(F('Canon', 'Canon EOS 90D') === 1.6, 'Canon 90D APS-C 1.6');
ok(F('Canon', 'Canon EOS 5D Mark IV') === 1.0, 'Canon 5D 全幅');
ok(F('Nikon Corporation', 'NIKON Z 6_2') === 1.0, 'Nikon Z 6_2 全幅');
ok(F('NIKON CORPORATION', 'NIKON Z 50') === 1.5, 'Nikon Z50 APS-C(不能误判成 Z5)');
ok(F('NIKON CORPORATION', 'NIKON D700') === 1.0, 'Nikon D700 全幅');
ok(F('NIKON CORPORATION', 'NIKON D7000') === 1.5, 'Nikon D7000 APS-C(不能误判成 D700)');
ok(F('NIKON CORPORATION', 'NIKON D3') === 1.0, 'Nikon D3 全幅');
ok(F('FUJIFILM', 'X-T5') === 1.5, 'Fuji X-T5 APS-C');
ok(F('FUJIFILM', 'GFX100S II') === 0.79, 'Fuji GFX 中画幅');
ok(F('Panasonic', 'DC-S5M2') === 1.0, 'Panasonic S5M2 全幅');
ok(F('Panasonic', 'DMC-GX85') === 2.0, 'Panasonic GX85 M4/3');
ok(F('OLYMPUS CORPORATION', 'E-M1MarkIII') === 2.0, 'Olympus M4/3');
ok(F('OM Digital Solutions', 'OM-1') === 2.0, 'OM-1 M4/3');
ok(F('PENTAX', 'PENTAX K-1 Mark II') === 1.0, 'Pentax K-1 全幅');
ok(F('PENTAX', 'PENTAX K-3 III') === 1.5, 'Pentax K-3 APS-C');
ok(F('Ricoh', 'GR III') === 1.5, 'Ricoh GR III APS-C');
ok(F('Leica Camera AG', 'M11') === 1.0, 'Leica M11 全幅');
ok(F('Hasselblad', 'X2D 100C') === 0.79, 'Hasselblad X2D 中画幅');
ok(F('Apple', 'iPhone 15 Pro') == null, 'iPhone 明确不换算');
ok(F('Xiaomi', '14 Ultra') == null, '小米手机明确不换算');
ok(F('', '') == null, '空品牌型号不换算');
ok(F('Unknown Corp', 'Mystery X') == null, '陌生机型不瞎猜');

/* ── ③ 换算与格式化 ── */
ok(CF.formatFocalWithEq('50mm', 'SONY', 'ILCE-7M4') === '50mm', '全幅原样返回');
ok(CF.formatFocalWithEq('35mm', 'FUJIFILM', 'X-T5') === '35mm (53mm 等效)', 'APS-C 换算 35→53');
ok(CF.formatFocalWithEq('50mm', 'Canon', 'Canon EOS R50') === '50mm (80mm 等效)', 'Canon 1.6 换算 50→80');
ok(CF.formatFocalWithEq('25mm', 'Panasonic', 'DMC-GX85') === '25mm (50mm 等效)', 'M4/3 换算 25→50');
ok(CF.formatFocalWithEq('', 'FUJIFILM', 'X-T5') === '', '空焦距原样返回');
ok(CF.formatFocalWithEq('f/2.8', 'FUJIFILM', 'X-T5') === 'f/2.8', '非焦距输入原样返回');

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
