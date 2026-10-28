// POLAROID_HAND 底部手写日期:必须随照片缩放,且始终待在白条内。
// 用法:
//   npm run test:pol     # 断言全部通过则退出码 0
//
// 背景(真实缺陷):日期字号硬编码 'italic 18px',而同风格的 border/bottomPad 都跟着 iw 缩放。
// 结果是图越大字越小 —— 18px 在 800px 图上占白条 16%,到 4000px 图只剩 3.2%,基本看不见。
 // 现改为按白条实际高度取字号(max(18, bandH*0.25))。
//
// 为什么 781 用例拦不住:基线指纹是 32 格分块平均 RGB,容差 FP_TOL=2.0。
// 18px→22px 这种局部小字变化落在单个分块里,平均差远小于容差,基线前后**完全一致**
// (实测 npm run test:visual 退出 0、baseline.json 零 diff)。这类"局部小字"只能靠几何断言守。
//
// 断言的是不变量,不是把实现抄一遍:
//   ① 日期不压照片(顶边在照片下缘之下)
//   ② 日期不被画布下沿裁掉
//   ③ 随图宽增大,日期像素高度单调不减(锁住"不再退回死字号")
//   ④ 小爱心在日期右端外侧,不在文字里
const path = require('path');
const { app, BrowserWindow } = require('electron');
// 主进程 stdout/stderr 在管道调用方(CI/npm/PowerShell)关闭后,残留日志会触发 EPIPE 弹窗;吞掉它。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'design', 'regress.html');

// 退出码收尾:Electron 主进程忽略 process.exitCode,只有 app.exit(code) 能带出非 0。
function finish(code) { app.exit(code || 0); }

const WIDTHS = [800, 1200, 1800, 2400, 4000];

const CHECK = `
(async () => {
  const cEl = document.getElementById('c');
  const g = cEl.getContext('2d');
  const out = [];
  for (const iw of ${JSON.stringify(WIDTHS)}) {
    const ih = Math.round(iw * 0.75);
    const ph = document.createElement('canvas'); ph.width = iw; ph.height = ih;
    const pg = ph.getContext('2d');
    pg.fillStyle = '#3a7bd5'; pg.fillRect(0, 0, iw, ih);          // 蓝照片,便于找下缘
    const im = new Image();
    await new Promise(r => { im.onload = r; im.src = ph.toDataURL('image/png'); });

    const a = {
      template: { photoFrameStyle: 'POLAROID_HAND', brandLogo: 0, useExif: 0, paramFontSize: 33,
                  cornerConfig: { cornerRadiusAll: 0 },
                  baseMargin: { imgScale: 1, imgOffsetX: 0, imgOffsetY: 0, globalMargin: 1 } },
      displayMax: 4000, selectedEls: [], uiDprOverride: 1,
      image: { el: im, exif: {} }, dom: { canvas: cEl },
      logos: [], logoImgCache: {}, scheduleRender() {}, applyZoomStyle() {}
    };
    window.EngineStyles.clearCaches();
    window.__render(a);

    const W = cEl.width, H = cEl.height;
    // 照片下缘 = 蓝色像素的最后一行(从上往下找最后一次命中)
    let photoBottom = -1;
    for (let y = 0; y < H; y++) {
      const px = g.getImageData(Math.floor(W / 2), y, 1, 1).data;
      if (px[0] < 120 && px[2] > 150) photoBottom = y;
    }
    const bandTop = photoBottom + 1;
    const d = g.getImageData(0, bandTop, W, H - bandTop).data;
    const bh = H - bandTop;
    let tTop = 1e9, tBot = -1, tL = 1e9, tR = -1, heartX = -1;
    for (let y = 0; y < bh; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, R = d[i], G = d[i+1], B = d[i+2];
      if (R < 120 && G < 120 && B < 120) {
        if (y < tTop) tTop = y; if (y > tBot) tBot = y;
        if (x < tL) tL = x; if (x > tR) tR = x;
      }
      if (R > 220 && G > 80 && G < 150 && B > 130 && B < 190) heartX = x;   // 粉色爱心
    }
    out.push({ iw: iw, W: W, H: H, bandTop: bandTop, bandH: bh,
      found: tBot >= 0, tTop: tTop, tBot: tBot, tL: tL, tR: tR,
      h: (tBot >= 0 ? tBot - tTop + 1 : 0), heartX: heartX, heartFound: heartX > 0 });
  }
  return out;
})()
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: { backgroundThrottling: false, sandbox: false } });
  await win.loadFile(PAGE);

  await new Promise(r => setTimeout(r, 1500));
  const rows = await win.webContents.executeJavaScript(CHECK);

  const fails = [];
  console.log('POLAROID_HAND · 手写日期(几何不变量)');
  console.log('─'.repeat(72));
  let prevH = 0, prevIw = 0;
  for (const r of rows) {
    if (!r.found) { fails.push(`iw=${r.iw}: 白条里没找到日期文字`); console.log(`  iw=${String(r.iw).padStart(4)}  ✖ 未找到日期`); continue; }
    // ① 不压照片
    if (r.tTop < 0) fails.push(`iw=${r.iw}: 日期压到照片上(顶边 ${r.tTop} < 白条起点 0)`);
    // ② 不被下沿裁掉
    if (r.tBot >= r.bandH - 1) fails.push(`iw=${r.iw}: 日期被画布下沿裁切(底边 ${r.tBot},白条高 ${r.bandH})`);
    // ③ 随图宽单调不减
    if (r.h < prevH) fails.push(`iw=${r.iw}: 日期高度 ${r.h}px 比 iw=${prevIw} 时的 ${prevH}px 更小 —— 又退回固定字号了`);
    // ④ 爱心在文字右侧
    if (!r.heartFound) fails.push(`iw=${r.iw}: 没找到粉色小爱心`);
    else if (r.heartX <= r.tR) fails.push(`iw=${r.iw}: 爱心 x=${r.heartX} 落在日期文字内(文字右缘 ${r.tR})`);
    prevH = r.h; prevIw = r.iw;
    console.log(`  iw=${String(r.iw).padStart(4)}  画布${String(r.W).padStart(4)}x${String(r.H).padStart(4)}  白条高${String(r.bandH).padStart(4)}  日期高${String(r.h).padStart(3)}px  爱心x=${r.heartFound ? r.heartX : '—'}  文字右缘${r.tR}`);
  }
  console.log('─'.repeat(72));
  // ③ 强判:最大图宽的日期必须显著大于最小图宽。
  // 单纯"单调不减"太弱 —— 硬编码 18px 时各档几乎相等,只有 displayMax 缩放那档会掉一点,
  // 靠那条侥幸兜住。要求首末比 ≥2.5x:修复后实测 29px→132px(4.5x);
  // 退回硬编码 18px 则是 15px→13px(0.87x),两者分得很开。
  const hs = rows.filter(r => r.found).map(r => r.h);
  if (hs.length >= 2) {
    const ratio = hs[hs.length - 1] / hs[0];
    if (ratio < 2.5) fails.push(`日期没有随图宽放大:最宽图 ${hs[hs.length - 1]}px / 最窄图 ${hs[0]}px = ${ratio.toFixed(2)}x(应 ≥ 2.5x)—— 疑似退回固定字号`);
    console.log(`  缩放比: 最宽图 ${hs[hs.length - 1]}px / 最窄图 ${hs[0]}px = ${ratio.toFixed(2)}x  ${ratio >= 2.5 ? 'OK' : '✖ 太小,像固定字号'}`);
  }
  if (fails.length) {
    console.log(`✖ ${fails.length} 项不符:`);
    for (const f of fails) console.log('  ' + f);
    finish(1);
    return;
  }
  console.log(`✓ 全部通过(${rows.length} 种图宽:不压照片 / 不裁切 / 随图放大 / 爱心在文字外)`);
  finish(0);
}).catch(e => { console.error(e); finish(1); });
