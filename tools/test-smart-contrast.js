// 智能反差(EXIF 参数条)回归测试 —— 需要 Electron(canvas + createElement)
// 用法:
//   npm run test:contrast      # 断言全部通过则退出码 0
//
// ── 为什么需要这条测试 ──
// engine.js 的「智能反差」按参数条背后实际像素的亮度选黑字/白字:
//   · 亮底(相对亮度 > 0.18)→ 黑字(与原实现完全一致,白底像素不可漂移);
//   · 暗底 → 白字(原实现固定黑字,深色/纹理填充时参数条直接消失);
//   · 花底(编码亮度平均偏差 > 30)→ 再描一圈反色边线(靠换色保证不了可读性)。
// 纯 node 的 test:engine 只钉决策函数的翻转点;这条测试走真实 canvas,
// 验证「渲染出来的参数条真的换色了」,而不是只在纸面上成立。
//
// 取样口径:参数条画在照片下方的留白条(底部 marginBottom = 140px)里,
// 统计该带内暗块(编码亮度<80)与亮块(>200)像素数 —— 白底看得到黑字、深底看得到白字。
// 页面底色用一层负边距填充铺满整张画布(与预设「暗夜星空」等同一手法:负边距让图层
// 延伸到 baseMargin 之外),否则画布留白由引擎写死的白底负责,换色无从验证。
'use strict';

const path = require('path');
const { app, BrowserWindow } = require('electron');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'design', 'regress.html');

// 退出码收尾:Electron 主进程忽略 process.exitCode,只有 app.exit(code) 能带出非 0
function finish(code) { app.exit(code || 0); }

const CHECK = `
(async () => {
  // 合成照片:渐变 + 噪点,保证画面有内容(与参数条的采样无关)
  const iw = 1600, ih = 1200;
  const ph = document.createElement('canvas'); ph.width = iw; ph.height = ih;
  const pg = ph.getContext('2d');
  const grd = pg.createLinearGradient(0, 0, iw, ih);
  grd.addColorStop(0, '#2b4a6f'); grd.addColorStop(1, '#c9a26b');
  pg.fillStyle = grd; pg.fillRect(0, 0, iw, ih);
  const im = new Image();
  await new Promise(r => { im.onload = r; im.src = ph.toDataURL('image/png'); });

  const cEl = document.getElementById('c');

  function renderStrip(fill) {
    const template = {
      baseMargin: { marginTop: 60, marginBottom: 140, marginLeft: 60, marginRight: 60,
                    imgScale: 1, imgOffsetX: 0, imgOffsetY: 0, globalMargin: 1 },
      // 负边距正好抵消 baseMargin → 图层矩形 = 整张画布(页面底色);
      // 与预设「暗夜星空」等同一手法(负边距让图层延伸到 baseMargin 之外)。
      layerList: [{ visible: true, marginTop: -60, marginBottom: -140, marginLeft: -60, marginRight: -60,
                    fillConfig: fill }],
      cornerConfig: {},
      decorConfig: { exifAutoText: 1, textLines: [], stickers: [] },
      manualExif: { brand: 'CANON', model: 'EOS R5', focal: '50mm', aperture: 'f/2.8', iso: '400', shutter: '1/125' }
    };
    const app = {
      template, displayMax: 3000, selectedEls: [], uiDprOverride: 1,
      image: { el: im, exif: {} }, dom: { canvas: cEl },
      logos: [], logoImgCache: {}, scheduleRender() {}, applyZoomStyle() {}
    };
    window.EngineStyles.clearCaches();
    window.__render(app, false);
    return { w: cEl.width, h: cEl.height };
  }

  function countBand(y0, h) {
    const g = cEl.getContext('2d');
    const d = g.getImageData(0, y0, cEl.width, h).data;
    let dark = 0, light = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 100) continue;
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      if (l < 80) dark++; else if (l > 200) light++;
    }
    return { dark, light };
  }

  function band(fill) {
    // 计数 strokeText:反向证明「花底才描边」——普通底必须 0 次,花底至少 1 次
    const proto = window.CanvasRenderingContext2D.prototype;
    const orig = proto.strokeText;
    let strokes = 0;
    proto.strokeText = function (...a) { strokes++; return orig.apply(this, a); };
    let r;
    try { r = renderStrip(fill); } finally { proto.strokeText = orig; }
    // 参数条 = 照片下缘到画布底的留白条(marginBottom=140)
    const c = countBand(Math.max(0, r.h - 140), Math.min(140, r.h));
    c.strokes = strokes;
    return c;
  }

  const solid = (hex) => ({ fillType: 'solid', fillHex: hex, fillOpacity: 100 });
  // 花底:黑/白交替多段渐变(对角线),保证参数条带内明暗多次反转 → dev 必然超阈值
  const zigs = [];
  for (let i = 0; i <= 10; i++) zigs.push({ position: i / 10, color: i % 2 ? '#ffffff' : '#000000' });
  return {
    white: band(solid('#ffffff')),
    dark: band(solid('#1c1c1c')),
    gray: band(solid('#808080')),
    busy: band({ fillType: 'gradient', gradientType: 'linear', gradientAngle: 0, gradientOpacity: 100, gradientStops: zigs })
  };
})()
`;

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: { backgroundThrottling: false, sandbox: false } });
    await win.loadFile(PAGE);

    await new Promise(r => setTimeout(r, 1200));
    const r = await win.webContents.executeJavaScript(CHECK).catch(e => ({ err: String((e && e.message) || e) }));

    const fails = [];
    console.log('EXIF 参数条 · 智能反差(黑/白字与反色边线)');
    console.log('-'.repeat(72));
    if (r.err) {
        console.log('  ✖ 渲染脚本失败: ' + r.err);
        finish(1);
        return;
    }
    const show = (k, v) => console.log('  ' + k.padEnd(4) + ' 暗块 ' + String(v.dark).padStart(9) + '   亮块 ' + String(v.light).padStart(9) + '   描边 ' + v.strokes);
    show('白底', r.white);
    show('深底', r.dark);
    show('灰底', r.gray);
    show('花底', r.busy);

    // ① 白底:必须仍是黑字(画面与原实现逐像素一致 —— 视觉基线另有一道);干净底不应描边
    if (!(r.white.dark > 30)) fails.push('白底参数条看不到黑字(dark=' + r.white.dark + ')');
    if (r.white.strokes !== 0) fails.push('白底参数条不应描边(strokes=' + r.white.strokes + ')');
    // ② 深底:亮块只能来自文字 → 必须已换成白字;纯色底不花,也不描边
    if (!(r.dark.light > 30)) fails.push('深底参数条没换成白字(light=' + r.dark.light + ')');
    if (r.dark.strokes !== 0) fails.push('纯色深底参数条不应描边(strokes=' + r.dark.strokes + ')');
    // ③ 灰底:WCAG 交叉点附近黑字对比更高 → 仍是黑字,不应出现白字(亮块≈0)
    if (!(r.gray.dark > 30)) fails.push('灰底参数条看不到黑字(dark=' + r.gray.dark + ')');
    if (r.gray.light > 5) fails.push('灰底参数条出现了白字(light=' + r.gray.light + ')');
    // ④ 花底(黑白交替):文字可见 + 确实走描边分支(换色保证不了可读性时才描)
    if (!(r.busy.dark + r.busy.light > 60)) fails.push('花底参数条字迹不可见');
    if (!(r.busy.strokes >= 1)) fails.push('花底参数条没有描边(strokes=' + r.busy.strokes + ')');

    console.log('-'.repeat(72));
    if (fails.length) {
        console.log('✖ ' + fails.length + ' 项不符:');
        for (const f of fails) console.log('  ' + f);
        finish(1);
        return;
    }
    console.log('✓ 亮底黑字保持 / 暗底自动白字 / 灰底仍黑字 / 花底换色+描边,干净底不描边');
    finish(0);
}).catch(e => { console.error(e); process.exit(1); });
