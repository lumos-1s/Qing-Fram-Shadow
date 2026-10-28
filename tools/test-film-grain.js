// 胶片颗粒层:几何/光度不变量
// 用法:
//   npm run test:grain     # 断言全部通过则退出码 0
//
// ── 这个功能为什么需要测试 ──
// filmGrainEnable / filmGrainIntensity 这两个字段早就在**所有**预设的 lightEffect 里
// (默认模板见 app.js defaultTemplate),8 个复古预设还带着 filmGrainEnable:1 +
// intensity 6~18,但引擎从来没读过它们 —— engine.js applyGlobalLight 上方的注释
// 原本就写着"无胶片颗粒"。也就是说这些预设一直在**承诺**一个画面上并不存在的颗粒。
// 本测试把四条不变量钉死,防止重演"字段有、渲染无"的半吊子状态。
//
// 断言的是不变量,不是把实现抄一遍:
//   ① 强度递增 → 颗粒量单调递增(相邻像素差 = 高频能量,平滑图上约 0.25,加颗粒后数十)
//   ② enable=0 时**零差异**:绝大多数预设存的是 filmGrainEnable:0 + intensity:10,
//      那个 10 是没人读过的遗留值。若引擎只看 intensity,这批老预设会集体冒出颗粒。
//   ③ 亮度中性:平均亮度不随强度漂移。OVERLAY 的枢轴是 0.5,噪声砖均值必须居中 128,
//      否则颗粒顺带变成曝光补偿(实测砖均值 172 时,强度 100% 把 1200px 图的平均亮度
//      从 172 抬到 201 —— 那是"把照片调亮了",不是加颗粒)。
//   ④ 噪声重复周期 ≥ 画布短边的 15%。噪声是逐像素的,砖边长决定的是**重复周期**。
//      砖边长若写死 256px,4000px 画布上就是 6.4% 周期 —— 同一块噪声贴 15.6 遍,
//      肉眼看得出"这张图在重复"。砖边长跟着画布走(约短边/3.2)时,各分辨率下
//      周期占画布的比例恒定,预览与导出观感一致。
//
//      注意:这里**不能**用"相邻像素差"去测 ④。那个量是尺度不变的 —— 砖边长无论
//      256 还是 1250,逐像素噪声的局部对比度都一样,实测把砖写死后本检查依然全绿
//      (假阴性)。必须用自相关去找周期。
//   ⑤ 预设实际用到的档位必须**真的看得见**。这条是被真实 bug 逼出来的:曲线曾是
//      alpha = amt^2,而仓库里 10 个 filmGrainEnable:1 预设的 intensity 全在 6~18,
//      平方后 6 档 alpha 只有 0.0036,实测最大 RGB 差 0 —— 加载后画面一个像素不变。
//      6 个预设(强度 6/8/10/12)等于"字段有、渲染无"。现在曲线是 amt^1.5。
//      档位直接从 shared/presets/*.json 读,预设改了本测试自动跟着走。
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
// 主进程 stdout/stderr 在管道调用方(CI/npm/PowerShell)关闭后,残留日志会触发 EPIPE 弹窗;吞掉它。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'design', 'regress.html');
const PRESETS = path.join(ROOT, 'shared', 'presets');

// 退出码收尾:Electron 主进程忽略 process.exitCode,只有 app.exit(code) 能带出非 0
function finish(code) { app.exit(code || 0); }

const SIZES = [600, 1200, 2400, 4000];
const MIN_PERIOD_RATIO = 0.15;   // 重复周期至少要占画布短边的 15%
const MIN_VISIBLE_RATIO = 1.45;   // 预设档位的颗粒量至少要是无颗粒基线的 1.45 倍

// 从真实预设里收集"声明了胶片颗粒"的档位(去重、升序),顺带统计遗留值
const PRESET_LEVELS = [];
const PRESET_STATS = { on: 0, off: 0, offWithStale: 0 };
try {
    for (const f of fs.readdirSync(PRESETS).filter(x => x.endsWith('.json'))) {
        let t;
        try { t = JSON.parse(fs.readFileSync(path.join(PRESETS, f), 'utf8')); } catch (e) { continue; }
        const le = t.lightEffect || {};
        if (le.filmGrainEnable === 1) {
            PRESET_STATS.on++;
            const v = le.filmGrainIntensity || 0;
            if (v > 0 && !PRESET_LEVELS.includes(v)) PRESET_LEVELS.push(v);
        } else {
            PRESET_STATS.off++;
            if ((le.filmGrainIntensity || 0) > 0) PRESET_STATS.offWithStale++;
        }
    }
} catch (e) { /* 目录不存在则跳过 ⑤ */ }
PRESET_LEVELS.sort((a, b) => a - b);

const CHECK = `
(async () => {
  const cEl = document.getElementById('c');
  const g = cEl.getContext('2d');
  const out = [];

  function makeImg(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    const gr = x.createLinearGradient(0, 0, w, h);
    gr.addColorStop(0, '#e8dcc8'); gr.addColorStop(1, '#6a7f96');
    x.fillStyle = gr; x.fillRect(0, 0, w, h);
    return c.toDataURL('image/png');
  }

  // 自相关:找出噪声场的重复周期(第一个高相关的 lag)。返回 0 = 在搜索范围内没找到周期。
  function repeatPeriod(sig, maxLag) {
    const n = sig.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += sig[i];
    mean /= n;
    let varr = 0;
    for (let i = 0; i < n; i++) { const d = sig[i] - mean; varr += d * d; }
    if (varr <= 0) return 0;
    for (let lag = 1; lag <= maxLag; lag++) {
      let sxy = 0, sx = 0, sy = 0;
      const m = n - lag;
      for (let i = 0; i < m; i++) { const a = sig[i] - mean, b = sig[i + lag] - mean; sxy += a * b; sx += a * a; sy += b * b; }
      const den = Math.sqrt(sx * sy);
      if (den > 0 && Math.abs(sxy / den) >= 0.8) return lag;
    }
    return 0;
  }

  function render(iw, ih, enable, inten, wantPeriod) {
    const im = new Image();
    return new Promise(res => {
      im.onload = () => {
        const a = {
          template: { photoFrameStyle: 'NONE', brandLogo: 0, useExif: 0, paramFontSize: 33,
                      cornerConfig: { cornerRadiusAll: 0 },
                      lightEffect: { filmGrainEnable: enable, filmGrainIntensity: inten },
                      baseMargin: { imgScale: 1, imgOffsetX: 0, imgOffsetY: 0, globalMargin: 1 } },
          displayMax: iw, selectedEls: [], uiDprOverride: 1,
          image: { el: im, exif: {} }, dom: { canvas: cEl },
          logos: [], logoImgCache: {}, scheduleRender() {}, applyZoomStyle() {}
        };
        window.__render(a, false);
        const W = cEl.width, H = cEl.height;
        const sw = Math.min(200, W), sh = Math.min(200, H);
        const d = g.getImageData(((W - sw) / 2) | 0, ((H - sh) / 2) | 0, sw, sh).data;
        const lum = new Float64Array(sw * sh);
        let n = 0, sum = 0, sum2 = 0, hp = 0, hpN = 0;
        for (let i = 0, px = 0; i < d.length; i += 4, px++) {
          const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
          lum[px] = v; sum += v; sum2 += v * v; n++;
        }
        for (let y = 0; y < sh; y++) {
          const row = y * sw;
          for (let x = 1; x < sw; x++) { hp += Math.abs(lum[row + x] - lum[row + x - 1]); hpN++; }
        }
        const mean = sum / n;

        // 重复周期:取画布中间一行,一阶差分把平滑渐变压掉、只留颗粒,再做自相关
        let period = 0;
        if (wantPeriod) {
          const rowY = H >> 1;
          const rowD = g.getImageData(0, rowY, W, 1).data;
          const sig = new Float64Array(W - 1);
          for (let x = 0; x < W - 1; x++) {
            const l0 = rowD[x * 4] * 0.299 + rowD[x * 4 + 1] * 0.587 + rowD[x * 4 + 2] * 0.114;
            const l1 = rowD[(x + 1) * 4] * 0.299 + rowD[(x + 1) * 4 + 1] * 0.587 + rowD[(x + 1) * 4 + 2] * 0.114;
            sig[x] = l1 - l0;
          }
          period = repeatPeriod(sig, Math.min(1200, Math.floor(W / 3)));
        }

        out.push({ iw: iw, W: W, H: H, enable: enable, inten: inten, period: period,
          mean: mean, sd: Math.sqrt(Math.max(0, sum2 / n - mean * mean)),
          hp: hpN ? hp / hpN : 0 });
        res();
      };
      im.src = makeImg(iw, ih);
    });
  }

  // ① 强度阶梯(同尺寸,只改强度)
  for (const inten of [0, 10, 25, 50, 100]) await render(1200, 900, inten > 0 ? 1 : 0, inten, false);
  // ② enable=0 + intensity=50:老预设的组合,必须完全没有颗粒
  await render(1200, 900, 0, 50, false);
  // ③ 重复周期 vs 分辨率
  for (const iw of ${JSON.stringify(SIZES)}) await render(iw, Math.round(iw * 0.75), 1, 40, true);
  // ⑤ 预设真实档位(升序去重)
  for (const inten of ${JSON.stringify(PRESET_LEVELS)}) await render(1200, 900, 1, inten, false);
  return out;
})()
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: { backgroundThrottling: false, sandbox: false } });
  await win.loadFile(PAGE);

  await new Promise(r => setTimeout(r, 1500));
  const rows = await win.webContents.executeJavaScript(CHECK);
  const fails = [];
  const f = (n, d) => Number(n).toFixed(d);

  console.log('胶片颗粒 · 不变量');
  console.log('='.repeat(74));
  const ladder = rows.slice(0, 5);
  console.log('① 强度阶梯 (1200x900)          颗粒量 = 相邻像素差,平滑渐变上约 0.25');
  console.log('-'.repeat(74));
  console.log('   强度%   平均亮度   灰度标准差   颗粒量');
  for (const r of ladder) {
    console.log('   ' + String(r.inten).padStart(5) + '   ' + f(r.mean, 2).padStart(8) +
      '   ' + f(r.sd, 3).padStart(9) + '   ' + f(r.hp, 4).padStart(8));
  }
  for (let i = 1; i < ladder.length; i++) {
    if (ladder[i].hp <= ladder[i - 1].hp) {
      fails.push(`强度 ${ladder[i - 1].inten}%→${ladder[i].inten}% 颗粒量没有递增(${f(ladder[i - 1].hp, 4)} → ${f(ladder[i].hp, 4)})`);
    }
  }
  if (ladder[4].hp / ladder[0].hp < 3) {
    fails.push(`强度 100% 的颗粒量只有 0% 的 ${f(ladder[4].hp / ladder[0].hp, 2)}x,肉眼基本看不出颗粒`);
  }
  console.log('   → 100%/0% = ' + f(ladder[4].hp / ladder[0].hp, 1) + 'x');

  // ③ 亮度中性
  const means = ladder.map(r => r.mean);
  const drift = (Math.max(...means) - Math.min(...means)) / (means.reduce((a, b) => a + b, 0) / means.length);
  console.log('');
  console.log('③ 亮度中性(颗粒不得兼职曝光)');
  console.log('   平均亮度极差 ' + f(Math.max(...means) - Math.min(...means), 2) + ' / 均值 ' +
    f(means.reduce((a, b) => a + b, 0) / means.length, 2) + ' = ' + f(drift * 100, 2) + '%  ' +
    (drift < 0.02 ? 'OK' : '✖ 噪声砖均值偏离 128 枢轴'));
  if (drift >= 0.02) {
    fails.push(`平均亮度随强度漂移 ${f(drift * 100, 2)}%(应 <2%)—— 噪声砖均值没居中在 128,颗粒变成了曝光补偿`);
  }

  // ② enable=0 零差异
  const off = rows[5];
  const zero = ladder[0];
  console.log('');
  console.log('② enable=0 / intensity=50(老预设组合,必须零差异)');
  const offRatio = off.hp / zero.hp;
  console.log('   颗粒量 ' + f(off.hp, 4) + '  vs 0%档 ' + f(zero.hp, 4) + '  = ' + f(offRatio, 3) + 'x  ' +
    (Math.abs(offRatio - 1) < 0.05 ? 'OK' : '✖ 有残留'));
  if (Math.abs(offRatio - 1) >= 0.05) {
    fails.push(`enable=0 时仍出现颗粒(比值 ${f(offRatio, 3)}x)—— 引擎只看 intensity、没看 enable,老预设会集体冒颗粒`);
  }

  // ④ 重复周期(固定 SIZES.length 行,不能 slice 到末尾 —— 后面还跟着 ⑤ 的行)
  const res = rows.slice(6, 6 + SIZES.length);
  console.log('');
  console.log('④ 噪声重复周期 (intensity=40,自相关找周期;周期应 ≥ 画布短边 15%)');
  console.log('-'.repeat(74));
  console.log('   图宽   画布        重复周期   占短边比例');
  for (const r of res) {
    const short = Math.min(r.W, r.H);
    const ratio = r.period / short;
    const ok = r.period > 0 && ratio >= MIN_PERIOD_RATIO;
    console.log('   ' + String(r.iw).padStart(4) + '   ' + String(r.W).padStart(4) + 'x' + String(r.H).padStart(4) +
      '   ' + (r.period > 0 ? (r.period + 'px').padStart(8) : '   未找到').padStart(9) +
      '   ' + (r.period > 0 ? f(ratio * 100, 1) + '%' : '  —').padStart(9) + '  ' + (ok ? 'OK' : '✖ 周期过短,会看出重复贴图'));
    if (!ok) {
      fails.push(`图宽 ${r.iw}: 噪声重复周期 ${r.period > 0 ? r.period + 'px' : '未检出'} / 短边 ${short}px` +
        ` = ${r.period > 0 ? f(ratio * 100, 1) + '%' : '—'}(应 ≥ ${MIN_PERIOD_RATIO * 100}%)—— 噪声砖边长没跟着画布走`);
    }
  }

  // ⑤ 预设真实档位可见性
  const presetRows = rows.slice(6 + res.length);
  console.log('');
  console.log('⑤ 预设真实档位可见性(档位读自 shared/presets/*.json)');
  console.log('   预设统计: enable=1 有 ' + PRESET_STATS.on + ' 个;enable=0 有 ' + PRESET_STATS.off +
    ' 个(其中带非零遗留 intensity 的 ' + PRESET_STATS.offWithStale + ' 个,必须被 enable 门控挡住)');
  console.log('-'.repeat(74));
  console.log('   intensity   alpha(amt^1.5)   颗粒量    相对无颗粒   判定');
  for (const r of presetRows) {
    const ratio = r.hp / zero.hp;
    const ok = ratio >= MIN_VISIBLE_RATIO;
    console.log('   ' + String(r.inten).padStart(9) + '   ' + Math.pow(r.inten / 100, 1.5).toFixed(4).padStart(14) +
      '   ' + f(r.hp, 4).padStart(8) + '   ' + ratio.toFixed(2).padStart(8) + 'x   ' +
      (ok ? 'OK 看得见' : '✖ 几乎看不出'));
    if (!ok) {
      fails.push(`预设档位 intensity=${r.inten} 的颗粒量只有无颗粒的 ${f(ratio, 2)}x(应 ≥ ${MIN_VISIBLE_RATIO}x)` +
        `—— 强度曲线太陡(amt^2 会让 6 档 alpha 只有 0.0036,画面一个像素都不变)`);
    }
  }
  if (!presetRows.length) {
    console.log('   (shared/presets 下没读到 filmGrainEnable:1 的预设,跳过)');
  }

  console.log('='.repeat(74));
  if (fails.length) {
    console.log('✖ ' + fails.length + ' 项不符:');
    for (const x of fails) console.log('  ' + x);
    finish(1);
    return;
  }
  console.log('✓ 强度单调 / 亮度中性 / enable=0 零差异 / 重复周期足够长 / 预设档位全部可见');
  finish(0);
}).catch(e => { console.error(e); finish(1); });
