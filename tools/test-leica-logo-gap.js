// CARD_LEICA 底部条:红点与品牌 logo 不得重叠。
// 用法:
//   npm run test:leica      # 断言全部通过则退出码 0
//
// 背景(真实缺陷):换 logo 后,logo 走 logoCenterX 居中到「品牌文字原来的宽度」上。
// Leica 是宽字标,logo 一旦比 "Leica" 这几个字宽,居中就会把 logo 左边缘反向推过去,
// 盖住左边那颗红点;更宽时 logo 还会越出画布左缘。
//   实测(修复前,800×900 照片,pad=24,dotD=9,文字起点 x0=41):
//     logo  40×40  红点 24..32  logo 64..81    正常
//     logo 120×40  红点 24..32  logo 46..99    正常
//     logo 240×40  红点被完全遮盖 logo 19..126  重叠
//     logo 400×40  红点被完全遮盖 logo 0..162   重叠 + 溢出画布
//
// 为什么 781 用例的视觉回归拦不住:regress.html 的 fixture logo 比 "Leica" 窄,
// 居中结果本就落在 x0 右侧,夹取不生效 —— 基线前后完全一致。这条只能靠专门断言守。
//
// 走 design/regress.html + __render 真实渲染路径,不复刻布局公式。
const path = require('path');
const { app, BrowserWindow } = require('electron');
// 主进程 stdout/stderr 在管道调用方(CI/npm/PowerShell)关闭后,残留日志会触发 EPIPE 弹窗;吞掉它。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'design', 'regress.html');

// 退出码收尾:Electron 主进程忽略 process.exitCode,只有 app.exit(code) 能带出非 0。
function finish(code) { app.exit(code || 0); }

// logo 宽高比从小到大。6:1 起进入重叠区(见文件头实测)。
const LOGO_SHAPES = [[40, 40], [120, 40], [240, 40], [400, 40], [600, 40]];

const CHECK = `
(async () => {
  const cEl = document.getElementById('c');
  const g = cEl.getContext('2d');

  const photo = document.createElement('canvas'); photo.width = 800; photo.height = 900;
  const pg = photo.getContext('2d'); pg.fillStyle = '#4488cc'; pg.fillRect(0, 0, 800, 900);
  const photoImg = new Image();
  await new Promise(r => { photoImg.onload = r; photoImg.src = photo.toDataURL('image/png'); });

  const mkLogo = async (w, h) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.fillStyle = '#111'; x.fillRect(0, 0, w, h);
    const im = new Image();
    await new Promise(r => { im.onload = r; im.src = c.toDataURL('image/png'); });
    return { im: im, data: c.toDataURL('image/png') };
  };

  // 渲染 CARD_LEICA(仅 logo 模式),返回红点与 logo 的水平范围
  const probe = async (lw, lh, bl) => {
    const L = await mkLogo(lw, lh);
    const a = {
      template: { photoFrameStyle: 'CARD_LEICA', brandLogo: bl, useExif: 0, paramFontSize: 33,
                  brandLogoPref: 'LIGHT', cornerConfig: { cornerRadiusAll: 0 },
                  baseMargin: { imgScale: 1, imgOffsetX: 0, imgOffsetY: 0, globalMargin: 1 } },
      displayMax: 4000, selectedEls: [], uiDprOverride: 1,
      image: { el: photoImg, exif: {} }, dom: { canvas: cEl },
      logos: [{ name: 'LEICA', dataUrl: L.data, custom: true }],
      logoImgCache: {}, scheduleRender() {}, applyZoomStyle() {}
    };
    a.logoImgCache[L.data] = L.im;
    window.EngineStyles.clearCaches();
    window.__render(a);

    const W = cEl.width, H = cEl.height;
    // 底部白条:照片高度 + pad 之后。取靠下的一段纯白区域,避开照片像素。
    const y0 = Math.round(H * 0.95), hh = H - y0;
    const d = g.getImageData(0, y0, W, hh).data;
    let redL = 1e9, redR = -1, darkL = 1e9, darkR = -1;
    for (let x = 0; x < W; x++) for (let y = 0; y < hh; y++) {
      const i = (y * W + x) * 4, R = d[i], G = d[i+1], B = d[i+2];
      if (R > 190 && G < 70 && B < 80) { if (x < redL) redL = x; if (x > redR) redR = x; }
      else if (R < 90 && G < 90 && B < 90) { if (x < darkL) darkL = x; if (x > darkR) darkR = x; }
    }
    return {
      lw: lw, lh: lh, bl: bl, W: W,
      dotFound: redL <= redR, dotL: redL, dotR: redR,
      logoFound: darkL <= darkR, logoL: darkL, logoR: darkR
    };
  };

  const out = [];
  for (const [w, h] of ${JSON.stringify(LOGO_SHAPES)}) out.push(await probe(w, h, 2));
  return out;
})()
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: { backgroundThrottling: false, sandbox: false } });
  await win.loadFile(PAGE);
  // Electron 45 起隐藏窗口不做布局/绘制：几何与像素断言会拿到 0×0 / 空白。
  // 必须让窗口真正参与合成，否则整片用例静默失灵（曾把 test:drag 全判失败）。
  win.showInactive();

  await new Promise(r => setTimeout(r, 1500));
  const rows = await win.webContents.executeJavaScript(CHECK);

  const fails = [];
  console.log('CARD_LEICA · 红点与 logo 间距(仅 logo 模式)');
  console.log('─'.repeat(70));
  for (const r of rows) {
    const ratio = (r.lw / r.lh).toFixed(1);
    if (!r.dotFound) {
      fails.push(`logo ${r.lw}×${r.lh} (${ratio}:1): 红点找不到了 —— 被 logo 完全盖住`);
      console.log(`  ${String(r.lw + '×' + r.lh).padEnd(9)} ${String(ratio + ':1').padStart(6)}  ✖ 红点被完全遮盖`);
      continue;
    }
    if (!r.logoFound) {
      fails.push(`logo ${r.lw}×${r.lh}: 没找到 logo 暗部,渲染可能失败`);
      console.log(`  ${String(r.lw + '×' + r.lh).padEnd(9)} ${String(ratio + ':1').padStart(6)}  ✖ 未渲染出 logo`);
      continue;
    }
    const gap = r.logoL - r.dotR - 1;
    const ok = gap >= 0;
    if (!ok) fails.push(`logo ${r.lw}×${r.lh} (${ratio}:1): logo 左缘 ${r.logoL} 压在红点右缘 ${r.dotR} 上,重叠 ${-gap}px`);
    console.log(`  ${String(r.lw + '×' + r.lh).padEnd(9)} ${String(ratio + ':1').padStart(6)}  ${ok ? 'OK' : '✖'}  红点 ${r.dotL}..${r.dotR}  logo ${r.logoL}..${r.logoR}  间隙 ${gap}px`);
  }
  console.log('─'.repeat(70));
  if (fails.length) {
    console.log(`✖ ${fails.length} 项不符:`);
    for (const f of fails) console.log('  ' + f);
    finish(1);
    return;
  }
  console.log(`✓ 全部通过(${rows.length} 种 logo 宽高比,红点均未被遮挡且无重叠)`);
  finish(0);
}).catch(e => { console.error(e); finish(1); });
