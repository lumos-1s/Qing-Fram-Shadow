// 参数字号标签回归:锁定「档位值 → 标签文本」的映射。
// 用法:
//   node tools/test-param-font-label.js     # 断言全部通过则退出码 0
//
// 为什么需要它:字号档位会按照片宽度缩放(autoExifSize = 档位 × clamp(iw/1200, 0.5, 8)),
// 同一档位在 1200px 与 4000px 宽的照片上能差 3 倍以上。这带来一个必须钉死的语义:
// 标签只报「档位」,不报像素,且**与照片宽度无关**。
//
// 历史 bug:标签曾经报折算后的真实像素(4000px 照片上档位 100 显示 333px)。数字会
// 随所选照片跳变,用户拖到 100 却在不同照片上看到 100/213/333,观感就是"字号不跟随"。
// 781 个视觉用例只覆盖画布像素、碰不到这层 UI 文本,所以这类问题只能靠专门的测试拦。
//
// 这层测试的价值不在"数字对不对",而在**照片宽度不变性**:同一档位换任何图宽,标签必须
// 逐字相同。曾经把 px 折算进来的改法就是在这里被挡住的。
//
// 另一件事:滑块双击的终点。必须是 defaultTemplate() 的默认档(= 刚加完边框那一刻的字号),
// **不是档位 0**。0 走的是 autoPf = clamp(round(min(iw,ih)/45), 20, 64)(engine-styles.js
// buildState),与默认档是两条不同公式:小图上偏小约 1.7 倍,大图撞 64 上限后偏大约 1.9 倍。
// 把"回默认"错做成"回 0 档"时,只有这条断言能拦住。
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
// 主进程 stdout/stderr 在管道调用方(CI/npm/PowerShell)关闭后,残留日志会触发 EPIPE 弹窗;吞掉它。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'src', 'renderer', 'index.html');

// 退出码收尾。Electron 主进程**完全忽略 process.exitCode** —— 实测:app.quit() 之后设 42
// 得到 0;连 app.quit() 都不调、只 win.destroy() 也得到 0。只有 app.exit(code) 能带出非 0。
// 必须在所有 console 输出之后再调用(app.exit 是立即终止;实测 200 行输出不会丢)。
function finish(code) { app.exit(code || 0); }

const NOTE_MANUAL = '按图宽自适应';

// 覆盖到极端图宽:clamp(iw/1200, 0.5, 8) 的两端都要踩到,确保任何缩放系数都影响不到标签
const WIDTHS = [400, 1200, 4000, 9600];
// 手动档位:0 是自适应(见下),其余覆盖默认值、常用值与滑块上限
const MANUAL = [1, 33, 100, 160];

const CHECK = `
(async () => {
  const App = window.App;
  await App.loadPresets();
  // 面板在无图时是 no-image,参数组整块 display:none,滑块量出来是 0px;
  // 这里的精度断言只关心有图时的真实布局,先把空态撤掉。
  const inspector = document.getElementById('inspector');
  if (inspector) inspector.classList.remove('no-image');
  // 参数文字已从「画布」拆到「文字」页签:先切到该页,否则量到的是 display:none 的 0px 轨道。
  if (App.switchTab) App.switchTab('text');
  const val = document.getElementById('lblParamFontSize');
  const note = document.getElementById('lblParamFontNote');
  if (!val) throw new Error('找不到 lblParamFontSize');
  if (!note) throw new Error('找不到 lblParamFontNote');
  const out = [];
  for (const pf of ${JSON.stringify([0].concat(MANUAL))}) {
    for (const w of ${JSON.stringify(WIDTHS)}) {
      App.image = { w: w, h: Math.round(w * 0.75) };
      App.template = { paramFontSize: pf };
      App.updateParamFontLabel();
      out.push({ pf: pf, w: w, val: val.textContent, note: note.textContent });
    }
  }
  // 双击滑块回到默认档位(= 刚加完边框那一刻的字号):走真实 DOM 事件,验证绑定、模板落值、滑块位置、标签四者一致
  const sl = document.getElementById('slParamFontSize');
  if (!sl) throw new Error('找不到 slParamFontSize');
  const defPf = App.defaultTemplate().paramFontSize;
  const dbl = [];
  for (const start of [0, 1, 33, 100, 160]) {
    App.image = { w: 1200, h: 900 };
    App.template = { paramFontSize: start };
    sl.value = String(start);
    sl.dispatchEvent(new Event('input', { bubbles: true }));
    const before = { tpl: App.template.paramFontSize, val: val.textContent, note: note.textContent, sl: sl.value };
    sl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    dbl.push({ start: start, before: before, tpl: App.template.paramFontSize, val: val.textContent, note: note.textContent, sl: sl.value });
  }
  // 已在默认档时再双击:应保持不变且不产生额外渲染(用计数器观察)
  let renders = 0;
  const origRender = App.renderPreview;
  App.renderPreview = function () { renders++; return origRender.apply(this, arguments); };
  App.template = { paramFontSize: defPf };
  sl.value = String(defPf);
  sl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  App.renderPreview = origRender;
  // 调节精度:说明小字不得挤占滑块横向空间。
  // 面板行只有 ~255px 宽,若"按图宽自适应"(66px)与滑块同行参与 flex 分配,
  // 滑块会从 97px 被压到 18px —— 1 像素 = 80 个档位,滑块等于废掉(用户报"一下就是10")。
  // 这里量 note 空/非空两种状态下的滑块宽度,要求一致。
  const noteBox = document.getElementById('lblParamFontNote');
  const keep = noteBox.textContent;
  noteBox.textContent = '';
  const wEmpty = sl.getBoundingClientRect().width;
  noteBox.textContent = keep || ${JSON.stringify(NOTE_MANUAL)};
  const wNote = sl.getBoundingClientRect().width;
  const perPx = (sl.max - sl.min) / Math.max(1, wNote - 16);
  return { rows: out, dbl: dbl, idleRenders: renders, defPf: defPf,
           track: { wEmpty: wEmpty, wNote: wNote, perPx: perPx } };
})()
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: { backgroundThrottling: false, sandbox: false } });
  await win.loadFile(PAGE);
  // Electron 45 起隐藏窗口不做布局/绘制：几何与像素断言会拿到 0×0 / 空白。
  // 必须让窗口真正参与合成，否则整片用例静默失灵（曾把 test:drag 全判失败）。
  win.showInactive();

  await new Promise(r => setTimeout(r, 1200));
  const got = await win.webContents.executeJavaScript(CHECK);
  app.quit();

  const fails = [];
  const byPf = {};
  for (const r of got.rows) (byPf[r.pf] = byPf[r.pf] || []).push(r);

  for (const pf of Object.keys(byPf).map(Number).sort((a, b) => a - b)) {
    const rows = byPf[pf];
    const first = rows[0];
    // 1) 与照片宽度无关:同一档位下所有图宽的标签必须逐字相同
    for (const r of rows) {
      if (r.val !== first.val) fails.push(`档位 ${pf} 在图宽 ${r.w} 下标签变成 "${r.val}"(期望恒为 "${first.val}")`);
      if (r.note !== first.note) fails.push(`档位 ${pf} 在图宽 ${r.w} 下说明变成 "${r.note}"(期望恒为 "${first.note}")`);
    }
    // 2) 不得出现 px —— 档位不是像素,报 px 就是那个会跳的假数字
    if (/px/i.test(first.val)) fails.push(`档位 ${pf} 标签含 "px": "${first.val}"`);
    // 3) 具体取值
    if (pf === 0) {
      if (first.val !== '自适应') fails.push(`自适应模式标签应为 "自适应",实为 "${first.val}"`);
      if (first.note !== '') fails.push(`自适应模式不应有说明小字,实为 "${first.note}"`);
    } else {
      if (first.val !== String(pf)) fails.push(`档位 ${pf} 标签应为 "${pf}",实为 "${first.val}"`);
      if (first.note !== NOTE_MANUAL) fails.push(`档位 ${pf} 说明小字应为 "${NOTE_MANUAL}",实为 "${first.note}"`);
    }
  }

  console.log('== 参数字号标签回归 ==');
  for (const pf of Object.keys(byPf).map(Number).sort((a, b) => a - b)) {
    const r = byPf[pf][0];
    const tag = pf === 0 ? '自适应' : '手动';
    console.log(`  ${String(pf).padStart(3)} 档位  [${tag}]  标签="${r.val}"  说明="${r.note}"  (${WIDTHS.length} 种图宽下逐字相同)`);
  }

  console.log('─'.repeat(64));
  console.log('  双击滑块 → 回到默认档位(刚加完边框的字号):');
  const DEF = got.defPf;
  for (const d of got.dbl) {
    const ok = d.tpl === DEF && d.val === String(DEF) && d.note === NOTE_MANUAL && d.sl === String(DEF);
    if (!ok) fails.push(`档位 ${d.start} 双击后未回到默认 ${DEF}: 模板=${d.tpl} 标签="${d.val}" 说明="${d.note}" 滑块=${d.sl}`);
    console.log(`    ${String(d.start).padStart(3)} → ${ok ? 'OK' : '✖'}  模板=${d.tpl}  标签="${d.val}"  滑块=${d.sl}`);
  }
  // 双击终点必须等于"刚加完边框"的默认档,而不是档位 0。
  // 0 档走 autoPf = clamp(round(min(iw,ih)/45), 20, 64),与默认档是两条公式:
  // 小图偏小约 1.7 倍,大图撞 64 上限后偏大 1.9 倍。滑块两端都要覆盖到。
  if (DEF === 0) fails.push('defaultTemplate().paramFontSize 为 0,双击将退回 autoPf 档而非刚加完边框的字号');
  console.log(`    默认档位(取自 defaultTemplate()): ${DEF}`);
  if (got.idleRenders !== 0) fails.push(`已在默认档 ${DEF} 时双击仍产生了 ${got.idleRenders} 次重绘(应为 0)`);
  console.log(`    已在默认档再双击: ${got.idleRenders === 0 ? 'OK(无重绘)' : '✖ ' + got.idleRenders + ' 次重绘'}`);

  // 调节精度:说明小字显示时,滑块不能被挤窄
  const t = got.track;
  const shrink = t.wEmpty - t.wNote;
  if (shrink > 1) fails.push(`说明小字挤占滑块宽度:空 ${t.wEmpty.toFixed(1)}px → 有 ${t.wNote.toFixed(1)}px(窄了 ${shrink.toFixed(1)}px)`);
  if (t.perPx > 3) fails.push(`滑块调节过粗:1 像素 = ${t.perPx.toFixed(2)} 个档位(应 ≤ 3)`);
  console.log('─'.repeat(64));
  console.log(`  调节精度: 滑块 空${t.wEmpty.toFixed(0)}px / 有说明${t.wNote.toFixed(0)}px, 1 像素 = ${t.perPx.toFixed(2)} 档`);

  console.log('─'.repeat(64));
  if (fails.length) {
    console.log(`✖ ${fails.length} 项不符:`);
    for (const f of fails) console.log('  ' + f);
    finish(1);
    return;
  }
  console.log(`✓ 全部通过(${Object.keys(byPf).length} 个档位 × ${WIDTHS.length} 种图宽)`);
  finish(0);
}).catch(e => { console.error(e); finish(1); });
