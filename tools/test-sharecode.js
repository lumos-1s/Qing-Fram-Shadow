// 模板分享码编解码回归测试(纯 node,不需要 Electron;Node 16+ 自带 btoa/atob/TextEncoder)
//   node tools/test-sharecode.js
//
// 覆盖 app-templates.js 的 _jsonToB64/_b64ToJson 往返:
//   中文/emoji/长 base64 图像数据(logo)往返必须逐字节一致;非法输入必须抛错(由调用方兜成状态文案)
'use strict';

global.window = global;
require(require('path').join(__dirname, '..', 'src', 'renderer', 'js', 'app-templates.js'));
const App = window.App;

let fails = 0;
function eq(actual, expect, label) {
    const a = JSON.stringify(actual), e = JSON.stringify(expect);
    if (a === e) { console.log('  OK   ' + label); return; }
    fails++;
    console.log('  FAIL ' + label + '   期望 ' + e + ' 实得 ' + a);
}

/* 往返一致 */
const samples = [
    '普通中文配置名称',
    "混排 emoji 🎞️ 与引号 \"'\\ 与换行\n第二行",
    JSON.stringify({ v: 1, kind: 'qfs-config', name: '青框影配置', template: { photoFrameStyle: 'FUJI_WHITE', manualExif: { brand: '富士' } } }),
    'x'.repeat(300000), // 模拟含 Logo dataUrl 的大包
    '',
];
samples.forEach((s, i) => {
    let ok = false, err = null;
    try { ok = App._b64ToJson(App._jsonToB64(s)) === s; } catch (e) { err = e; }
    eq(ok, true, '往返一致 #' + i + (s.length ? '(长度 ' + s.length + ')' : '空串') + (err ? ' ' + err.message : ''));
});

/* base64 输出必须是纯 ASCII(QFSCFG1: 前缀 + btoa 产物,聊天窗口不会出现乱码转义问题) */
const b64 = App._jsonToB64('中文内容');
eq(/^[A-Za-z0-9+/=]+$/.test(b64), true, 'base64 产物为纯 ASCII');

/* 非法输入抛错(调用方 catch 后落状态文案) */
let threw = false;
try { App._b64ToJson('!!!不是base64!!!'); } catch (e) { threw = true; }
eq(threw, true, '非法 base64 抛错');

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
