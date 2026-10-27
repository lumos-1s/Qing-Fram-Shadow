// 滑块数值输入 / 单行复位 / 面板快捷键回归。
// 用法:
//   node tools/test-range-input.js     # 断言全部通过则退出码 0
//
// 这层 UI 不在视觉回归的覆盖范围里:画布像素完全正确,数字框仍可能显示 57 而
// 实际滑块已经被 step=5 吸附到 55。这里用真实 DOM 事件走完整通路,锁定:
//   · step 吸附后数字框回读控件真实值
//   · 清空/非法输入失焦后恢复成滑块值
//   · Esc 取消本次输入并丢弃手势快照(不留下空的撤销记录)
//   · 只聚焦再离开不产生撤销记录
//   · 聚焦中双击数字框/标签也能同步复位
//   · 已在默认值时复位不压栈
//   · Ctrl+[ / Ctrl+] 在输入框内让路,且不响应键盘自动重复
'use strict';

const path = require('path');
const { app, BrowserWindow } = require('electron');
// 主进程 stdout/stderr 在管道调用方(CI/npm/PowerShell)关闭后,残留日志会触发 EPIPE 弹窗;吞掉它。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'src', 'renderer', 'index.html');

function finish(code) { app.exit(code || 0); }

const CHECK = `
(async () => {
  const App = window.App;
  for (let i = 0; i < 120 && !(App && App.dom); i++) await new Promise(r => setTimeout(r, 50));
  if (!App || !App.dom) throw new Error('App 未初始化');
  App.switchTab('text');
  App.image = { w: 1200, h: 900 };
  App.imageTemplates = App.imageTemplates || new Map();
  App.scheduleRender = () => {};
  App.saveCurrentTemplate = () => {};
  App.updateExportSizeNote = () => {};
  App.setStatus = () => {};

  const rng = document.getElementById('slParamScale');
  const num = rng && rng.closest('.param-row') && rng.closest('.param-row').querySelector('.pval-num');
  const label = document.getElementById('lblParamScale');
  const ui = App._rangeUi && App._rangeUi.slParamScale;
  if (!rng || !num || !label || !ui || !ui.edit) throw new Error('滑块数值输入未初始化');

  // 测试窗口是 show:false，且当前预设可能把这一行/整个参数组藏起来。聚焦一个
  // display:none 的控件不会改变 activeElement，后面的“聚焦中不回写”断言就失真。
  // 这里只把测试用的这一行及其祖先临时显示出来（不改产品代码的显隐判断）。
  const inspector = document.getElementById('inspector');
  if (inspector) {
    inspector.classList.remove('no-image');
    inspector.style.display = 'block';
  }
  for (let p = rng.closest('.param-row'); p && p !== document.body; p = p.parentElement) {
    if (getComputedStyle(p).display === 'none') {
      p.style.display = p.classList.contains('param-row') ? 'flex' : 'block';
    }
  }

  const resetRow = (v) => {
    num.blur();
    if (App._gesture) App.endGesture();
    App.undoStack.length = 0;
    App.redoStack.length = 0;
    App.updateHistoryButtons();
    App.template = App.defaultTemplate();
    App.template.paramScale = v / 100;
    rng.value = String(v);
    App.updateLabel('lblParamScale', v + '%');
    ui.edit.dirty = false;
    ui.edit.gesturing = false;
    ui.edit.startVal = v;
    App._syncRangeNumber('slParamScale', true);
  };
  const focus = () => {
    num.focus();
    num.dispatchEvent(new FocusEvent('focus'));
  };
  const type = (v) => {
    num.value = String(v);
    num.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const commit = () => num.dispatchEvent(new Event('change', { bubbles: true }));
  const blur = () => {
    num.blur();
    num.dispatchEvent(new FocusEvent('blur'));
  };
  const snap = () => ({
    rng: rng.value,
    num: num.value,
    label: label.textContent,
    tpl: App.template.paramScale,
    undo: App.undoStack.length,
    gesture: !!App._gesture,
    active: document.activeElement === num,
    dirty: ui.edit.dirty,
    gesturing: ui.edit.gesturing
  });

  // 1) 只聚焦并离开:不压撤销栈。
  resetRow(100);
  const undoBeforeFocus = App.undoStack.length;
  focus();
  const afterFocus = snap();
  blur();
  const afterIdleBlur = snap();

  // 2) step=5:输入 57 后实际控件是 55,提交/失焦后数字框必须显示 55。
  resetRow(100);
  focus();
  type(57);
  const stepLive = snap();
  commit();
  const stepCommit = snap();
  blur();
  const stepBlur = snap();

  // 3) Esc:恢复输入前的 100,并丢掉第一条输入压入的手势快照。
  resetRow(100);
  App.redoStack = [{ probe: 'redo' }];
  App.updateHistoryButtons();
  const undoBeforeEsc = App.undoStack.length;
  focus();
  type(57);
  const escBefore = snap();
  num.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  num.dispatchEvent(new FocusEvent('blur'));
  const escAfter = snap();
  const redoAfterEsc = App.redoStack.length;

  // 4) 清空输入后失焦:恢复成滑块当前值,不能留空。
  resetRow(100);
  focus();
  type('');
  commit();
  blur();
  const emptyBlur = snap();

  // 5) 数字框仍聚焦时双击复位:数字框也要立即回到默认值。
  resetRow(100);
  focus();
  type(57);
  App._resetRangeRow(rng);
  const resetWhileFocused = snap();

  // 6) 已在默认值时复位:不产生额外撤销记录,数字框保持默认。
  resetRow(100);
  focus();
  const undoBeforeDefaultReset = App.undoStack.length;
  App._resetRangeRow(rng);
  const defaultReset = snap();

  // 7) 面板快捷键:输入框内不拦截;普通区域拦截一次;repeat 不触发。
  // 用临时探针输入框，避免当前预设把签名输入行隐藏后 focus() 落空。
  const input = document.createElement('input');
  input.type = 'text';
  input.id = '__rangeProbeInput';
  input.style.cssText = 'position:fixed;left:10px;top:10px;width:120px;height:24px;z-index:2147483647';
  document.body.appendChild(input);
  const body = document.body;
  const fire = (target, repeat) => {
    const ev = new KeyboardEvent('keydown', { key: '[', ctrlKey: true, bubbles: true, cancelable: true, repeat: !!repeat });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  const collapsed0 = body.classList.contains('sidebar-collapsed');
  input.focus();
  const activeInInput = document.activeElement && document.activeElement.id;
  const preventedInInput = fire(input, false);
  const collapsedInInput = body.classList.contains('sidebar-collapsed');
  input.blur();
  const activeAfterInput = document.activeElement && document.activeElement.id;
  const preventedOnBody = fire(document.body, false);
  const collapsedOnBody = body.classList.contains('sidebar-collapsed');
  const preventedRepeat = fire(document.body, true);
  const collapsedOnRepeat = body.classList.contains('sidebar-collapsed');
  if (body.classList.contains('sidebar-collapsed') !== collapsed0) fire(document.body, false);
  input.remove();

  return {
    idle: { undoBeforeFocus, afterFocus, afterIdleBlur },
    step: { live: stepLive, commit: stepCommit, blur: stepBlur },
    esc: { undoBeforeEsc, before: escBefore, after: escAfter, redoAfter: redoAfterEsc },
    emptyBlur,
    resetWhileFocused,
    defaultReset: { undoBeforeDefaultReset, ...defaultReset },
    shortcut: { collapsed0, activeInInput, activeAfterInput, preventedInInput, collapsedInInput, preventedOnBody, collapsedOnBody, preventedRepeat, collapsedOnRepeat }
  };
})()
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 1000, show: false,
    webPreferences: { backgroundThrottling: false, sandbox: false }
  });
  await win.loadFile(PAGE);
  await new Promise(r => setTimeout(r, 1200));
  const got = await win.webContents.executeJavaScript(CHECK);
  app.quit();

  const fails = [];
  const eq = (name, actual, expected) => {
    if (String(actual) !== String(expected)) fails.push(`${name}: 实际 ${JSON.stringify(actual)},期望 ${JSON.stringify(expected)}`);
  };

  const idle = got.idle;
  eq('仅聚焦不应压撤销栈', idle.afterFocus.undo, idle.undoBeforeFocus);
  eq('仅聚焦不应开启手势', idle.afterFocus.gesture, false);
  eq('聚焦后离开不应压撤销栈', idle.afterIdleBlur.undo, idle.undoBeforeFocus);
  eq('聚焦后离开不应残留手势', idle.afterIdleBlur.gesture, false);
  eq('聚焦后离开不应残留 dirty', idle.afterIdleBlur.dirty, false);

  const step = got.step;
  eq('输入 57 时滑块按 step=5 吸附到 55', step.live.rng, '55');
  eq('输入过程中数字框保留用户正在输入的 57', step.live.num, '57');
  eq('提交后数字框回读滑块真实值 55', step.commit.num, '55');
  eq('提交后标签为 55%', step.commit.label, '55%');
  eq('提交后模板为 0.55', step.commit.tpl, 0.55);
  eq('失焦后数字框仍为 55', step.blur.num, '55');
  eq('失焦后滑块仍为 55', step.blur.rng, '55');
  eq('提交只产生一条撤销记录', step.blur.undo, 1);
  eq('提交后手势已结束', step.blur.gesture, false);

  const esc = got.esc;
  eq('Esc 前滑块已实时变为 55', esc.before.rng, '55');
  eq('Esc 前手势已开启', esc.before.gesture, true);
  eq('Esc 后滑块恢复 100', esc.after.rng, '100');
  eq('Esc 后数字框恢复 100', esc.after.num, '100');
  eq('Esc 后标签恢复 100%', esc.after.label, '100%');
  eq('Esc 后模板恢复 1', esc.after.tpl, 1);
  eq('Esc 后撤销栈回到输入前', esc.after.undo, esc.undoBeforeEsc);
  eq('Esc 取消后重做栈应保留', esc.redoAfter, 1);
  eq('Esc 后手势已结束', esc.after.gesture, false);

  eq('清空输入失焦后数字框恢复 100', got.emptyBlur.num, '100');
  eq('清空输入失焦后标签仍为 100%', got.emptyBlur.label, '100%');
  eq('清空输入失焦后滑块仍为 100', got.emptyBlur.rng, '100');

  const rf = got.resetWhileFocused;
  eq('聚焦中复位后滑块为 100', rf.rng, '100');
  eq('聚焦中复位后数字框为 100', rf.num, '100');
  eq('聚焦中复位后标签为 100%', rf.label, '100%');
  eq('聚焦中复位后模板为 1', rf.tpl, 1);

  const dr = got.defaultReset;
  eq('默认值复位不应新增撤销记录', dr.undo, dr.undoBeforeDefaultReset);
  eq('默认值复位后滑块仍为 100', dr.rng, '100');
  eq('默认值复位后数字框仍为 100', dr.num, '100');
  eq('默认值复位后不应残留手势', dr.gesture, false);

  const sc = got.shortcut;
  eq('输入框内 Ctrl+[ 不拦截', sc.preventedInInput, false);
  eq('输入框内 Ctrl+[ 不收起侧栏', sc.collapsedInInput, sc.collapsed0);
  eq('普通区域 Ctrl+[ 应拦截', sc.preventedOnBody, true);
  eq('普通区域 Ctrl+[ 应切换侧栏', sc.collapsedOnBody, !sc.collapsed0);
  eq('键盘自动重复 Ctrl+[ 不拦截', sc.preventedRepeat, false);
  eq('键盘自动重复 Ctrl+[ 不切换侧栏', sc.collapsedOnRepeat, sc.collapsedOnBody);

  console.log('== 滑块数值输入 / 面板快捷键回归 ==');
  console.log(`  空闲聚焦: 撤销 ${idle.undoBeforeFocus} → ${idle.afterIdleBlur.undo}, 手势=${idle.afterIdleBlur.gesture}`);
  console.log(`  step 吸附: 输入 57 → 滑块 ${step.live.rng} / 数字框 ${step.live.num}（聚焦=${step.live.active}）→ 提交后数字框 ${step.commit.num}`);
  console.log(`  Esc 取消: ${esc.before.rng} → ${esc.after.rng}, 撤销栈 ${esc.before.undo} → ${esc.after.undo}`);
  console.log(`  清空失焦: 数字框 "${got.emptyBlur.num}", 标签 "${got.emptyBlur.label}"`);
  console.log(`  聚焦中复位: 滑块 ${rf.rng} / 数字框 ${rf.num}`);
  console.log(`  默认值复位: 撤销 ${dr.undoBeforeDefaultReset} → ${dr.undo}`);
  console.log(`  快捷键: 输入框焦点=${sc.activeInInput || '(无)'} 拦截=${sc.preventedInInput}, 普通区域拦截=${sc.preventedOnBody}, 自动重复拦截=${sc.preventedRepeat}`);

  if (fails.length) {
    console.log(`✖ ${fails.length} 项不符:`);
    for (const f of fails) console.log('  ' + f);
    finish(1);
    return;
  }
  console.log('✓ 全部通过');
  finish(0);
}).catch(e => { console.error(e); finish(1); });
