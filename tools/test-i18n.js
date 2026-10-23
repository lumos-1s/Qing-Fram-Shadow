// i18n 运行时回归测试(纯 node,不需要 Electron)
//   node tools/test-i18n.js
//
// 覆盖 src/renderer/js/i18n.js 的纯逻辑部分:
//   ① 词典查表:t(中文原文)→ 英文;未收录原样返回;zh 模式恒等
//   ② 键值一致性:词典的英文值不能与中文键相同(否则等于没翻,还白查一次)
//   ③ 词典键去重:对象字面量重复键会被静默覆盖,这里用 Function 序列化粗查常见重复
// (文本节点扫描/属性替换依赖 DOM,由应用内 English 切换 + 目测覆盖)
'use strict';

global.document = { readyState: 'loading', addEventListener: function () {} };
global.window = global;
require(require('path').join(__dirname, '..', 'src', 'renderer', 'js', 'i18n.js'));
const I18N = window.QfsI18n;

let fails = 0;
function eq(actual, expect, label) {
    const a = JSON.stringify(actual), e = JSON.stringify(expect);
    if (a === e) { console.log('  OK   ' + label); return; }
    fails++;
    console.log('  FAIL ' + label + '   期望 ' + e + ' 实得 ' + a);
}

/* ① 查表行为 */
// 默认语言 zh(测试环境无 localStorage)→ 恒等
eq(I18N.current(), 'zh', '默认语言 zh');
eq(I18N.t('参数'), '参数', 'zh 模式恒等返回');

// 模拟切到 en:直接改 localStorage 桩
global.localStorage = { getItem: () => 'en', setItem: () => {} };
eq(I18N.current(), 'en', 'en 模式读取');
eq(I18N.t('参数'), 'Params', '页签翻译');
eq(I18N.t('同步到选中'), 'Sync to selected', '按钮翻译');
eq(I18N.t('等效焦距换算'), '35mm-equivalent focal', '本次新功能词条');
eq(I18N.t('胶片日期角标') /* v1 未收录也应有兜底 */, '胶片日期角标', '未收录词条兜底');
eq(I18N.t('  参数  ') === 'Params' || I18N.t('  参数  ') === '  参数  ', true, '带空白输入不炸');

/* ② 词典键值一致性:值与键相同的词条抓出来 */
// 通过重新解析 i18n.js 源码里的 DICT 字面量做静态检查(运行时拿不到原始键,用源码扫)
const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'renderer', 'js', 'i18n.js'), 'utf8');
const re = /'((?:[^'\\]|\\.)+)':\s*'((?:[^'\\]|\\.)+)'/g;
let m, dup = [];
const seen = {};
while ((m = re.exec(src))) {
    const k = m[1].replace(/\\'/g, "'"), v = m[2].replace(/\\'/g, "'");
    if (k === v) dup.push(k);
    if (seen[k] !== undefined && seen[k] !== v) dup.push(k + '(重复定义)');
    seen[k] = v;
}
eq(dup, [], '无"值=键"或重复定义词条');

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
