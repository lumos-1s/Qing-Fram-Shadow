// 视觉回归测试:渲染所有风格 × 关键参数组合,与基线(颜色指纹+布局指标)比对。
// 用法(本文件 require('electron'),必须经 run-electron 包装,裸 node 跑会挂在 app.whenReady):
//   node tools/run-electron.js tools/visual-regression.js            # 比对并退出码 0/1
//   node tools/run-electron.js tools/visual-regression.js --update   # 重建基线(tests/visual/baseline.json)
//   node tools/run-electron.js tools/visual-regression.js --presets  # 预设冒烟:70 预设走 __render 真实渲染路径 ---- 并入 run
//   node tools/run-electron.js tools/visual-regression.js --dev      # 开发模式:渲染到 tests/visual/out/ 不比对
// 设计:
//   - 复用 design/regress.html(轻量,只加载 engine.js+engine-styles.js,无整套 app)
//   - 指纹:画布 32 格分块平均 RGB —— 抓布局/颜色错位
//   - 指标:品牌左缘/参数框左缘/红色 logo 框 —— 抓左留白类像素锚点回归
//   - CYBER_GLITCH 有 Math.random:页面内已注入确定性 PRNG,可复现
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'design', 'regress.html');
const BASELINE = path.join(ROOT, 'tests', 'visual', 'baseline.json');
const OUT_DIR = path.join(ROOT, 'tests', 'visual', 'out');
const PRESETS_DIR = path.join(ROOT, 'shared', 'presets');

// 比对容差
const FP_TOL = 2.0;        // 指纹平均通道差(0-255)
const POS_TOL = 2;         // 指标 px 容差
const WARN_TOL = 3;        // 预设冒烟:量有偏差但很小

// 退出码收尾。Electron 主进程**完全忽略 process.exitCode** —— 实测:app.quit() 之后设 42
// 得到 0;连 app.quit() 都不调、只 win.destroy() 也得到 0。只有 app.exit(code) 能带出非 0。
// 必须在所有 console 输出之后再调用(app.exit 是立即终止;实测 200 行输出不会丢)。
function finish(code) { app.exit(code || 0); }

// ── 测试矩阵 ──
// 风格清单直接取自 engine-styles.js 的 `const draw = {...}` 映射表 ——
// 引擎新增风格时本矩阵自动跟上,不会再出现"引擎画了但回归没测"的盲区。
// (原先这里是手抄的 63 个名字,和引擎、与 validate-presets.js 各存一份,必然漂移。)
// 提取方式与 tools/validate-presets.js 相同:括号配平截取,不能按子串切。
function engineDrawKeys() {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'engine-styles.js'), 'utf8');
    const at = src.indexOf('const draw = {');
    if (at < 0) throw new Error('engine-styles.js 里找不到 const draw = {');
    const from = src.indexOf('{', at);
    let depth = 0;
    for (let i = from; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) {
            return [...src.slice(from, i).matchAll(/(?:^|[\s,{])([A-Z][A-Z0-9_]*)\s*:/g)].map(m => m[1]);
        }
    }
    throw new Error('engine-styles.js: const draw = { 括号未配平');
}
const STYLE_NAMES = engineDrawKeys();
if (!STYLE_NAMES.length) throw new Error('从引擎 draw 表里没提取到任何风格名');

// 能力维度(全风格覆盖)与品牌 logo 名单都取自 style-caps.js —— 单一事实来源,不要在本文件另抄一份。
// 五个滑块(paramFontSize / 圆角 / 边距大小 / 图片缩放 / 背景模糊程度)在面板上对所有风格可见,
// 所以每个风格 × 每个维度都取两个极值:指纹与该风格 __base 相同 = 该风格不读这个参数。
// 这份数据同时是 gen-style-caps.js 生成能力表的输入。
const StyleCaps = require('../src/renderer/js/style-caps.js');
const ALL_DIMS = StyleCaps.DIMS.map(d => [d.key, d.probe]);
const BRAND_STYLES = StyleCaps.BRAND_LOGO_STYLES;

// 注:原先的 PARAM_STYLES 子集(17 个风格 × paramFontSize 极值)已被下面的
// 「全风格 × ALL_DIMS」完全覆盖,故删除 —— 留着会产生重复 case id。

function buildCases() {
  const cases = [];
  for (const st of STYLE_NAMES) {
    cases.push({ id: st + '__base', st, bl: 1, pf: 33, bs: 1 });
  }
  for (const st of BRAND_STYLES) {
    const combos = [
      ['__bl0', 0, 1], ['__bl2', 2, 1], ['__bl1bs3', 1, 3], ['__bl2bs3', 2, 3]
    ];
    for (const [tag, bl, bs] of combos) {
      cases.push({ id: st + tag, st, bl, pf: 33, bs });
    }
  }
  // 全风格 × 全维度:能力表(style-caps)的数据源。
  // 指纹与 __base 相同即"该风格不吃这个参数",gen-style-caps.js 据此反推能力表,
  // 避免手维护的表和真实行为腐烂。用例 id 的数值写法由 style-caps.caseSuffix 统一,
  // 改它等于作废整个基线。
  for (const st of STYLE_NAMES) {
    for (const [dim, vals] of ALL_DIMS) {
      for (const v of vals) {
        cases.push({ id: StyleCaps.dimCaseId(st, dim, v), st, bl: 1, pf: 33, bs: 1, [dim]: v });
      }
    }
  }
  return cases;
}

function presetCases() {
  if (!fs.existsSync(PRESETS_DIR)) return [];
  const files = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')).sort();
  const cases = [];
  for (const f of files) {
    const name = f.replace(/\.json$/, '');
    let t = null;
    try { t = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf-8')); } catch (e) { continue; }
    cases.push({ id: 'preset_' + name, st: String(t.photoFrameStyle || 'LEGACY').toUpperCase(), bl: 0, pf: 33, bs: 1, extra: t, noStyle: !t.photoFrameStyle });
  }
  return cases;
}

// 工具:加载现有基线
function loadBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE, 'utf-8')); } catch (e) { return {}; }
}

function saveBaseline(map) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(map, null, 1), 'utf-8');
}

// 平均通道差
function fpDiff(a, b) {
  if (!a || !b) return Infinity;
  if (a.CW !== b.CW || a.CH !== b.CH) return Infinity;
  const n = Math.min(a.data.length, b.data.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a.data[i] - b.data[i]);
  return sum / n;
}

// 布局指标比对:返回最大偏差像素
function metricDiff(a, b) {
  let max = 0;
  for (const k of ['ml', 'boxLeftDark', 'brandLeftDark']) {
    const va = a && a[k], vb = b && b[k];
    if (va == null || vb == null) continue;
    if (va === -1 || vb === -1) continue;
    max = Math.max(max, Math.abs(va - vb));
  }
  if (a && b && a.logoRedBox && b.logoRedBox) {
    for (const k of ['x0', 'y0', 'w', 'h']) {
      max = Math.max(max, Math.abs(a.logoRedBox[k] - b.logoRedBox[k]));
    }
    for (const k of ['x1', 'y1']) {
      max = Math.max(max, Math.abs(a.logoRedBox[k] - b.logoRedBox[k]));
    }
  }
  return max;
}

// ── 渲染批次:一次 executeJavaScript 传全部用例 ──
async function renderBatch(win, cases, chunk = 180) {
  const results = [];
  for (let i = 0; i < cases.length; i += chunk) {
    const slice = cases.slice(i, i + chunk);
    const r = await win.webContents.executeJavaScript(`window.__QR.run(${JSON.stringify(slice)})`);
    results.push(...r);
  }
  return results;
}

function main() {
  const argv = process.argv.slice(2);
  const isUpdate = argv.includes('--update');
  const isPresets = argv.includes('--presets');
  const isDev = argv.includes('--dev');
  const mode = isUpdate ? 'update' : isPresets ? 'presets' : isDev ? 'dev' : 'compare';

  const runCases = isPresets ? presetCases() : (isDev ? buildCases().slice(0, 8) : buildCases());
  const baseline = isUpdate ? {} : loadBaseline();

  app.whenReady().then(async () => {
    const win = new BrowserWindow({
      width: 1000, height: 800, show: false,
      webPreferences: { backgroundThrottling: false, sandbox: false }
    });
    await win.loadFile(PAGE);
    await new Promise(r => setTimeout(r, 200));
    const results = await renderBatch(win, runCases);
    app.quit();

    if (isDev) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      for (const r of results) {
        fs.writeFileSync(path.join(OUT_DIR, r.id + '.json'), JSON.stringify({ st: r.st, W: r.W, H: r.H, error: r.error, m: r.m }, null, 1), 'utf-8');
      }
      const ok = results.filter(r => !r.error);
      const bad = results.filter(r => r.error);
      console.log(`[visual:dev] ${ok.length}/${results.length} rendered OK`);
      if (bad.length) {
        console.log('--- render errors ---');
        for (const r of bad) console.log('  ' + r.id + ': ' + r.error.slice(0, 120));
      }
      finish(bad.length ? 1 : 0);
      return;
    }

    if (isPresets) {
      let ok = 0, fail = 0;
      const byPath = {};
      console.log('== 预设冒烟(走 __render 真实渲染路径)==');
      for (const r of results) {
        byPath[r.path] = (byPath[r.path] || 0) + 1;
        if (r.error) {
          fail++; console.log('  FAIL ' + r.id + ' [' + r.path + ']: ' + r.error.slice(0, 120));
        } else if (r.m && r.m.W > 0 && r.m.H > 0) {
          ok++;
        } else { fail++; console.log('  FAIL ' + r.id + ' [' + r.path + ']: 渲染尺寸异常 (' + (r.W || 0) + 'x' + (r.H || 0) + ')'); }
      }
      console.log('  路径分布: ' + Object.keys(byPath).map(k => k + ':' + byPath[k]).join('  '));
      console.log(`  通过 ${ok} / 失败 ${fail}`);
      finish(fail ? 1 : 0);
      return;
    }

    // update / compare
    const updated = {};
    let diffList = [];
    let newList = [];
    let renderErrors = 0;

    for (const r of results) {
      if (r.error) { renderErrors++; continue; }
      const mine = { fp: r.fp, m: r.m, W: r.W, H: r.H };
      updated[r.id] = mine;
      const ref = baseline[r.id];
      if (isUpdate) continue;
      if (!ref) { newList.push(r.id); continue; } // 新增用例:update 时自动收录,compare 不算通过
      let over = false, why = '';
      if (ref.W !== r.W || ref.H !== r.H) { over = true; why = `尺寸 ${ref.W}x${ref.H} -> ${r.W}x${r.H}`; }
      const fd = fpDiff(ref.fp, r.fp);
      if (fd > FP_TOL) { over = true; if (!why) why = `指纹差 ${fd.toFixed(1)}`; else why += `, 指纹差 ${fd.toFixed(1)}`; }
      const md = metricDiff(ref.m, r.m);
      if (md > POS_TOL) { over = true; if (!why) why = `指标差 ${md}px`; else why += `, 指标差 ${md}px`; }
      if (over) diffList.push({ id: r.id, why });
    }

    if (isUpdate) {
      saveBaseline(updated);
      console.log(`[visual:update] 基线已重建:${Object.keys(updated).length} 用例 (renderErrors=${renderErrors})`);
      finish(renderErrors ? 1 : 0);
      return;
    }

    const total = Object.keys(updated).length;
    const matched = total - diffList.length - newList.length;
    console.log(`== 视觉回归 (${mode}) ==`);
    console.log(`  渲染 ${runCases.length} 用例 / 无错 ${total} / 渲染失败 ${renderErrors}`);
    console.log(`  与基线比对:一致 ${matched} / 差异 ${diffList.length} / 无基线 ${newList.length}`);
    if (newList.length) {
      console.log('--- 无基线(需 --update 收录) ---');
      for (const id of newList) console.log('  ' + id);
    }
    if (diffList.length) {
      console.log('--- 差异明细 ---');
      for (const d of diffList) console.log('  ' + d.id + ': ' + d.why);
    }
    const stale = Object.keys(baseline).filter(k => !updated[k]);
    if (stale.length) {
      console.log(`  (基线含 ${stale.length} 个已不存在的用例,可用 --update 清理)`);
    }
    finish(renderErrors || diffList.length || newList.length ? 1 : 0);
  });
}

main();