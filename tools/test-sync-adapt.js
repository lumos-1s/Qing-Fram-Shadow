// 批量同步横竖自适应回归测试(纯 node,不需要 Electron)
//   node tools/test-sync-adapt.js
//
// 覆盖 src/renderer/js/app-sync.js 的 _adaptTplToSize:
//   ① 横→竖(kx·ky=1):边距按同轴比例换算,圆角几何均值恰好不变,globalMargin 不动
//   ② 同方向缩放:四边与圆角等比缩小
//   ③ 显式 paramFontSize 按几何均值缩放;0(自适应)保持 0
//   ④ 边界:零/负尺寸与缺 baseMargin 不炸、不改写
'use strict';

global.window = global;
require(path());
const App = window.App;

function path() { return require('path').join(__dirname, '..', 'src', 'renderer', 'js', 'app-sync.js'); }

let fails = 0;
function eq(actual, expect, label) {
    const a = JSON.stringify(actual), e = JSON.stringify(expect);
    if (a === e) { console.log('  OK   ' + label); return; }
    fails++;
    console.log('  FAIL ' + label + '   期望 ' + e + ' 实得 ' + a);
}

function tpl() {
    return {
        baseMargin: {
            marginTop: 90, marginBottom: 120, marginLeft: 80, marginRight: 80,
            refTop: 90, refBottom: 120, refLeft: 80, refRight: 80,
            globalMargin: 1.25, imgScale: 1, imgOffsetX: 0, imgOffsetY: 0,
        },
        cornerConfig: { cornerRadiusAll: 30, cornerRadiusTL: 20, cornerRadiusTR: 20, cornerRadiusBL: 20, cornerRadiusBR: 20 },
        paramFontSize: 40,
    };
}

/* ① 横 4000×3000 → 竖 3000×4000:kx=0.75,ky=4/3,kr=√(kx·ky)=1 */
const a = tpl();
App._adaptTplToSize(a, 4000, 3000, 3000, 4000);
eq([a.baseMargin.marginTop, a.baseMargin.marginBottom], [120, 160], '横→竖:竖直边距 ×4/3(90→120,120→160)');
eq([a.baseMargin.marginLeft, a.baseMargin.marginRight], [60, 60], '横→竖:水平边距 ×0.75(80→60)');
eq([a.baseMargin.refTop, a.baseMargin.refLeft], [120, 60], '横→竖:ref 基准值同比例换算');
eq(a.baseMargin.globalMargin, 1.25, '横→竖:globalMargin 保持不变');
eq(a.cornerConfig.cornerRadiusAll, 30, '横→竖:圆角几何均值恰好不变');
eq([a.baseMargin.imgScale, a.baseMargin.imgOffsetX], [1, 0], '横→竖:缩放/偏移不被误改');

/* ② 同方向缩小 4000×3000 → 2000×1500:kx=ky=0.5 */
const b = tpl();
App._adaptTplToSize(b, 4000, 3000, 2000, 1500);
eq([b.baseMargin.marginTop, b.baseMargin.marginLeft], [45, 40], '同向缩小:四边等比 ×0.5');
eq(b.cornerConfig.cornerRadiusAll, 15, '同向缩小:圆角 ×0.5');
eq(b.paramFontSize, 20, '同向缩小:显式字号 ×0.5');

/* ③ paramFontSize=0(自适应)保持 0 */
const c = tpl(); c.paramFontSize = 0;
App._adaptTplToSize(c, 4000, 3000, 2000, 1500);
eq(c.paramFontSize, 0, '自适应字号(0)不被改写');

/* ④ 边界输入 */
const d = tpl();
App._adaptTplToSize(d, 0, 3000, 2000, 1500);
eq(d.baseMargin.marginTop, 90, '非法源尺寸:原样不动');
const e = { cornerConfig: { cornerRadiusAll: 30 } };
App._adaptTplToSize(e, 4000, 3000, 2000, 1500);
eq(e.cornerConfig.cornerRadiusAll, 15, '缺 baseMargin:圆角仍正常换算');
App._adaptTplToSize(null, 4000, 3000, 2000, 1500);
console.log('  OK   null 模板不炸');

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
