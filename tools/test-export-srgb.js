// 导出颜色空间不变量:出口必须永远是 sRGB。
// 用法:
//   npm run test:srgb     # 断言全部通过则退出码 0
//
// ── 为什么需要这条测试 ──
// 应用目前"恰好"是正确的,但正确性是**偶然**的,没有任何东西守着它:
//   · 全部 30+ 处 getContext('2d') 用默认参数 → 画布按规范就是 sRGB,
//     故 Display P3 / AdobeRGB 源图在 drawImage 时已被浏览器转成 sRGB。
//   · Electron 45 的 toDataURL('image/png') → IHDR + IDAT,**不再自带 sRGB**,由
//     src/shared/png-srgb.js 在写盘前补齐;**没有 iCCP**
//     实测 toDataURL('image/jpeg') → 只有 JFIF APP0,**没有 ICC_PROFILE**
//   · 8 处 toDataURL、5 处 writeFileSync 全是「canvas 编码 → base64 → 写盘」,
//     没有任何路径把源文件原始字节当图片写出,故源图 ICC 不会透传到成品。
//
// 风险在于这些都是"没人写下来的约定"。哪天有人为 Retina/广色域加一行
//   getContext('2d', { colorSpace: 'display-p3' })
// 画布色彩空间在**首次 getContext 时定死**,之后无法改回 —— 出口会静默变成 P3,
// 用户发到微信/网页上就真的发灰,而 781 用例的 32 格分块指纹对全局色偏同样不敏感。
// 所以把这条不变量钉死,并加一道源码级 grep 兜住 P3 的引入。
//
// 注意:这条测试**不**断言"像素数值等于 sRGB"(那需要外部色彩管理参考实现,
// 无法在 canvas 内自证)。它断言的是"输出被正确标注、且画布是 sRGB"——
// 这正是决定第三方软件如何解释这些像素的那两件事。
//
// 哪条断言真正吃重(实测出来的,别想当然):
//   ⑤ 源码 grep 才是主力。实测把 engine-styles.js:2580(所有 63 个风格必经的
//      `canvas.getContext('2d')`)改成 display-p3 后,①~④ 全绿 —— 因为 #c 的色彩
//      空间在**页面初始化**时就已被 app.js 首次 getContext 定死成 sRGB,晚到的
//      getContext 拿不到改写权。所以 ①(运行时 colorSpace)只是"今天确实是这样"的
//      快照,不是护栏;真正能拦住回归的是 ⑤ 静态 grep。
//   ①②③④ 仍值得留着:它们锁住**成品文件**的标注(sRGB chunk 在、无 iCCP、
//      JPEG 无 ICC),任何编码层改动(换 toBlob、换 encoder、动 mime)都会立刻反映出来。
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
// 主进程 stdout/stderr 在管道调用方(CI/npm/PowerShell)关闭后,残留日志会触发 EPIPE 弹窗;吞掉它。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'design', 'regress.html');
const RENDERER = path.join(ROOT, 'src', 'renderer');

// 退出码收尾:Electron 主进程忽略 process.exitCode,只有 app.exit(code) 能带出非 0
function finish(code) { app.exit(code || 0); }

const CHECK = `
(async () => {
  const cEl = document.getElementById('c');

  // PNG:走 chunk 清单
  function pngChunks(b64) {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const dv = new DataView(u.buffer);
    let off = 8; const out = [];
    while (off + 8 <= u.length) {
      const len = dv.getUint32(off);
      const type = String.fromCharCode(u[off+4],u[off+5],u[off+6],u[off+7]);
      out.push(type);
      if (type === 'IEND') break;
      off += 12 + len;
    }
    return out;
  }
  // JPEG:只认 payload 以 ICC_PROFILE\\0 开头的 APP2 段(别的 APP2 不算)
  function jpegIccLen(b64) {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const dv = new DataView(u.buffer);
    let off = 2, icc = 0;
    while (off + 4 <= u.length) {
      if (u[off] !== 0xFF) break;
      const m = u[off+1];
      if (m === 0xD8 || m === 0xD9) { off += 2; continue; }
      const len = dv.getUint16(off + 2);
      if (m >= 0xE0 && m <= 0xEF && len >= 18) {
        const sig = String.fromCharCode(u[off+4],u[off+5],u[off+6],u[off+7],u[off+8],u[off+9],u[off+10],u[off+11]);
        if (sig === 'ICC_PROFILE') icc += len - 16;
      }
      if (m === 0xDA) break;
      off += 2 + len;
    }
    return icc;
  }

  // 用真实渲染路径画一帧(与 test:leica / test:pol 同一条路),确保测的是导出画布本身
  const iw = 1600, ih = 1200;
  const ph = document.createElement('canvas'); ph.width = iw; ph.height = ih;
  const pg = ph.getContext('2d');
  pg.fillStyle = '#c86464'; pg.fillRect(0, 0, iw, ih);
  const im = new Image();
  await new Promise(r => { im.onload = r; im.src = ph.toDataURL('image/png'); });

  const a = {
    template: { photoFrameStyle: 'POLAROID_HAND', brandLogo: 0, useExif: 0, paramFontSize: 33,
                cornerConfig: { cornerRadiusAll: 0 },
                baseMargin: { imgScale: 1, imgOffsetX: 0, imgOffsetY: 0, globalMargin: 1 } },
    displayMax: 1600, selectedEls: [], uiDprOverride: 1,
    image: { el: im, exif: {} }, dom: { canvas: cEl },
    logos: [], logoImgCache: {}, scheduleRender() {}, applyZoomStyle() {}
  };
  window.EngineStyles.clearCaches();
  window.__render(a, false);

  // 必须在 __render **之后**才取上下文:同一 canvas 元素重复 getContext 返回同一个
  // 对象,而色彩空间由**首次** getContext 的参数定死。若在渲染前先取一次,
  // 这条测试自己就把画布锁成 sRGB 了,注入 display-p3 也测不出来(假阴性)。
  const g = cEl.getContext('2d');
  const attrs = g.getContextAttributes ? g.getContextAttributes() : {};
  const rawPng = cEl.toDataURL('image/png');
  // Electron 45 的 canvas 编码器不再自动写 sRGB chunk;成品写盘统一走
  // src/shared/png-srgb.js(主进程 ensurePngSrgb)。这里验证"经过写盘前处理后"的字节。
  const outPng = window.QFpng.ensureDataUrl(rawPng);
  return {
    colorSpace: attrs.colorSpace === undefined ? '(未声明→sRGB)' : attrs.colorSpace,
    hasSrgbChunk: pngChunks(outPng.split(',')[1]).indexOf('sRGB') >= 0,
    pngChunks: pngChunks(outPng.split(',')[1]).join(' '),
    hasIccp: pngChunks(outPng.split(',')[1]).indexOf('iCCP') >= 0,
    jpegIcc: jpegIccLen(cEl.toDataURL('image/jpeg', 0.92).split(',')[1])
  };
})()
`;

// 源码级兜底:渲染层不得引入 display-p3 画布
function grepP3() {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|html)$/.test(e.name)) continue;
      const txt = fs.readFileSync(p, 'utf8');
      txt.split(/\r?\n/).forEach((line, i) => {
        if (/colorSpace\s*:\s*['"]display-p3['"]/.test(line)) {
          hits.push(path.relative(ROOT, p).replace(/\\/g, '/') + ':' + (i + 1) + '  ' + line.trim());
        }
      });
    }
  };
  walk(RENDERER);
  return hits;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: { backgroundThrottling: false, sandbox: false } });
  await win.loadFile(PAGE);

  await new Promise(r => setTimeout(r, 1500));
  const r = await win.webContents.executeJavaScript(CHECK);
  const p3 = grepP3();

  const fails = [];
  console.log('导出颜色空间 · sRGB 不变量');
  console.log('-'.repeat(72));
  console.log('  导出画布 colorSpace   : ' + r.colorSpace);
  console.log('  PNG chunk 清单        : ' + r.pngChunks);
  console.log('  JPEG 内 ICC_PROFILE   : ' + r.jpegIcc + ' 字节');

  // ① 画布必须是 sRGB(未声明即 sRGB)
  if (r.colorSpace !== '(未声明→sRGB)' && r.colorSpace !== 'srgb') {
    fails.push(`导出画布 colorSpace = ${r.colorSpace},应为 sRGB`);
  }
  // ② PNG 必须显式标注 sRGB(写盘前由 shared/png-srgb.js 补齐)
  if (!r.hasSrgbChunk) fails.push('PNG 出口没有 sRGB chunk —— 第三方软件只能靠猜');
  // ③ PNG 不得携带 iCCP(那正是 libpng "known incorrect sRGB profile" 警告的来源)
  if (r.hasIccp) fails.push('PNG 出口带 iCCP chunk —— 会触发 libpng iCCP 警告,且 profile 可能不可信');
  // ④ JPEG 不得携带 ICC profile
  if (r.jpegIcc > 0) fails.push(`JPEG 出口带 ${r.jpegIcc} 字节 ICC_PROFILE —— 应统一按 sRGB 无标记输出`);

  // ⑤ 源码级:不得引入 display-p3 画布(色彩空间首次 getContext 即定死,无法回退)
  if (p3.length) {
    fails.push('渲染层出现 display-p3 画布(画布色彩空间首次 getContext 即定死,无法改回 sRGB):');
    for (const h of p3) fails.push('    ' + h);
  }

  console.log('-'.repeat(72));
  if (fails.length) {
    console.log('✖ ' + fails.length + ' 项不符:');
    for (const f of fails) console.log('  ' + f);
    finish(1);
    return;
  }
  console.log('✓ 画布 sRGB / PNG 带 sRGB chunk 且无 iCCP / JPEG 无 ICC / 源码无 display-p3');
  finish(0);
}).catch(e => { console.error(e); finish(1); });
