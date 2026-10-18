// 端到端回归:用户自己加的 logo,在很多预设上点不中、拖不动、不能放缩。
//
// 根因(由 tools 逐像素测量得出,不是推断):
//   rel 比例(rx/ry)的分母在引擎与 app 侧不一致。
//   · 引擎 engine.js drawLogoElements 用 canvas._logW/_logH 定位,而且绘制发生在
//     ctx.restore() 之后的**未缩放**上下文里(engine.js:225-238)—— _logW 的数值
//     被直接当成画布像素用。
//   · app 侧 hitTestLogos 原来传的是 pt.cw/pt.ch(= canvas.width),也就是画布尺寸。
//   dpr=2 时 canvas.width = _logW × 2,于是命中框落在实际绘制位置的 2 倍处。
//   走 engine.js 通道的预设约占一半(dpr=1 时两者相等,所以表现为"很多预设"而非全部)。
//
// 写入侧是自洽的,不用改:setLogoPixelPos 收到的是画布像素,存 rx = cx / _logW,
// 引擎再乘回 _logW 正好还原成 cx。叠加层 _drawDraggedEl 与选中框 drawSelectionBox
// 也已按 _logW / el.x 口径绘制,同样自洽。**只有命中检测用错了口径。**
//
// 本测试走完整真实链路,不注入坐标:
//   addLogoElement() → 渲染 → 扫描画布找出 logo 实际像素位置 →
//   用 CDP 在该屏幕位置发真实鼠标点击 → 断言元素被选中 → 再拖缩放滑块断言尺寸变化。
// 因为点击位置来自像素测量,而不是 app 自己的坐标推算,所以这个测试不会自证。
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
// 主进程 stdout/stderr 在管道调用方(CI/npm/PowerShell)关闭后,残留日志会触发 EPIPE 弹窗;吞掉它。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);
ipcMain.handle('list-presets', () => fs.readdirSync(path.join(ROOT, 'shared', 'presets')).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'presets', n + '.json'), 'utf8')));
for (const c of ['list-logos', 'list-textures', 'list-templates']) ipcMain.handle(c, () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}

// 每个预设:① 不带 logo 渲染一次取基准 ② 加 logo 再渲染 ③ 用两次之差精确定位 logo
// 差分法而非「找品红」:某些预设(极光渐变/IG渐变光环)自身就含粉紫色,
// 直接按颜色找会框到相框图案上(实测把 196px 的 logo 认成 1280x1690)。
const PREP = `
(async () => {
    const A = window.App;
    const idx = ${'${IDX}'};
    const preset = A.presets[idx];
    if (!preset) return { error: 'no preset ' + idx };

    const c = document.createElement('canvas'); c.width = 1200; c.height = 900;
    const g = c.getContext('2d'); g.fillStyle = '#808080'; g.fillRect(0, 0, 1200, 900);
    const im = new Image();
    await new Promise(r => { im.onload = r; im.src = c.toDataURL('image/jpeg', 0.95); });
    const img = { el: im, name: 'p.jpg', w: 1200, h: 900, exif: {} };

    A.image = img; A.images = [img]; A.imageTemplates = new Map();
    A.selectedIdx = [0]; A.currentIdx = 0; A.selectedEls = [];
    A.template = A.defaultTemplate();
    A.normalizeTemplate(); A.invalidateStyleCaches();
    // 与仓库内其它测试一致:show:false 窗口里 requestAnimationFrame 受节流,
    // 不能依赖 rAF 计数,固定多等几次让画布彻底落地(避免画布尺寸在两帧间变化)。
    delete A.uiDprOverride; delete A.exportScale; A.displayMax = undefined;
    A.applyPreset(preset);
    await new Promise(r => setTimeout(r, 900));
    A.scheduleRender(true); await new Promise(r => setTimeout(r, 900));

    const isMag = (d, i) => d[i] > 190 && d[i + 2] > 190 && d[i + 1] < 90;
    const cv = A.dom.canvas;
    const w0 = cv.width, h0 = cv.height;
    const before = cv.getContext('2d').getImageData(0, 0, w0, h0).data;
    const beforeMag = new Uint8Array(w0 * h0);
    for (let p = 0, q = 0; q < w0 * h0; q++, p += 4) beforeMag[q] = isMag(before, p) ? 1 : 0;

    // 真实入口添加 logo
    const lc = document.createElement('canvas'); lc.width = 100; lc.height = 100;
    const lg = lc.getContext('2d'); lg.fillStyle = 'rgb(255,0,255)'; lg.fillRect(0, 0, 100, 100);
    const logoUrl = lc.toDataURL('image/png');
    await A.addLogoElement({ name: 'PROBE', dataUrl: logoUrl });
    A.selectedEls = [];
    A._skipUserEl = null;
    A.invalidateStyleCaches();

    // 位图是异步解码的:getElementBitmap 首次返回 null 且 logo 被暂时跳过,
    // 解码完成后的 onload→requestRender 才补画;隐藏窗口里 rAF 不保证立刻跑。
    // 因此轮询重渲,直到「画布尺寸不变 且 logo 真画出来了」。
    let final = null;
    for (let k = 0; k < 14; k++) {
        A.scheduleRender(true);
        await new Promise(r => setTimeout(r, 250));
        const cvk = A.dom.canvas;
        if (cvk.width !== w0 || cvk.height !== h0) continue; // 还在变化,下一轮再看
        const now = cvk.getContext('2d').getImageData(0, 0, w0, h0).data;
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
        for (let y = 0, q = 0; y < h0; y++) for (let x = 0; x < w0; x++, q++) {
            const p = q * 4;
            if (!beforeMag[q] && isMag(now, p)) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
        if (n >= 50) { final = { n, x0, y0, x1, y1 }; break; }
    }
    const el = (A.template.logoElements || [])[0];
    if (!final) return { error: 'logo 轮询后仍未画出', name: preset.templateName || '(无名)', logoN: (A.template.logoElements || []).length, cv: w0 + 'x' + h0, ratio: Math.round(w0 / (A.dom.canvas._logW || 1) * 1000) / 1000 };

    // 动效/渐变预设(极光渐变等)在两帧之间背景会自己位移,差分出来的区域可能不是 logo
    // 而是移动的背景块。修复命中检测后,app 的 logoPos(基准口径) == 引擎实际绘制位置
    // (已有像素级探针证实),所以若差分中心明显偏离 app 坐标,就认定差分被污染,
    // 改用 app 坐标作为点击目标,避免把检测器的误报当成产品 bug。
    const base = A.logoBaseForOverlay();
    const appPos = A.logoPos(el, base.w, base.h, el.size || 60);
    const pcx = (final.x0 + final.x1) / 2, pcy = (final.y0 + final.y1) / 2;
    const dev = appPos && appPos.cx != null ? Math.hypot(pcx - appPos.cx, pcy - appPos.cy) : 0;
    let tx = pcx, ty = pcy, hint = '';
    if (dev > (el.size || 60) * 0.55) { tx = appPos.cx; ty = appPos.cy; hint = ' (差分污染,用 app 坐标)'; }
    const rect = A.dom.canvas.getBoundingClientRect();
    return {
        name: preset.templateName || '(无名)',
        logoN: (A.template.logoElements || []).length,
        size0: el ? el.size : null,
        // 画布像素 → 屏幕坐标,用于真实点击
        screenX: rect.left + (tx / w0) * rect.width,
        screenY: rect.top + (ty / h0) * rect.height,
        hint,
        painted: { cx: Math.round(pcx), cy: Math.round(pcy), w: Math.round(final.x1 - final.x0 + 1), h: Math.round(final.y1 - final.y0 + 1), n: final.n },
        cw: w0, logW: A.dom.canvas._logW,
    };
})()
`;

const AFTER_CLICK = `(() => {
    const A = window.App;
    return {
        selN: A.selectedEls.length,
        selKind: A.selectedEls.length ? A.selectedEls[0].kind : null,
        status: String(A.$('elStatus') ? A.$('elStatus').textContent : ''),
    };
})()`;

const AFTER_SCALE = `(() => {
    const A = window.App;
    const el = (A.template.logoElements || [])[0];
    return { size: el ? el.size : null, selN: A.selectedEls.length };
})()`;

async function clickAt(dbg, x, y) {
    const common = { x, y, button: 'left', buttons: 1, clickCount: 1 };
    await dbg.sendCommand('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, common));
    await dbg.sendCommand('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, common, { buttons: 0 }));
    await new Promise(r => setTimeout(r, 260));
}

// 退出码收尾:Electron 主进程完全忽略 process.exitCode(app.quit() 之后设 1 实测仍得 0),
// 只有 app.exit(code) 能带出非 0。此前本文件设了 process.exitCode,断言失败仍返回 0。
function finish(code) { app.exit(code || 0); }

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try {
            const u = new URL(req.url); const p = u.searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (e) { return new Response('NF', { status: 404 }); }
    });
    const win = new BrowserWindow({
        width: 1500, height: 950, show: false,
        webPreferences: { preload: path.join(__dirname, 'preload-measure.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas)')) break;
        await new Promise(r => setTimeout(r, 250));
    }
    for (let i = 0; i < 80; i++) {
        if (await win.webContents.executeJavaScript('(window.App.presets || []).length') > 0) break;
        await new Promise(r => setTimeout(r, 250));
    }
    const count = await win.webContents.executeJavaScript('(window.App.presets || []).length');

    // 启动期「新手引导」弹窗(requestIdleCallback,最迟 4s)会盖住整窗:此后所有真实
    // 鼠标点击都落在弹窗上,表现为「全部点不中」。禁用弹出并隐藏,保证输入直达画布。
    // 不调 closeIntro():它写 localStorage 标记,而测试与真实应用共用用户数据目录。
    await win.webContents.executeJavaScript(`(() => {
        window.App.showIntroIfNeeded = () => {};
        const m = document.getElementById('introModal');
        if (m) m.style.display = 'none';
        return 1;
    })()`);

    const dbg = win.webContents.debugger;
    dbg.attach('1.3');

    let noPainted = 0, notSelected = 0, notScaled = 0, okCount = 0;
    const badSel = [], badScale = [];
    console.log('logo 真实点击命中 + 放缩(逐像素定位,全 ' + count + ' 个预设)');
    console.log('─'.repeat(104));

    for (let i = 0; i < count; i++) {
        const prep = await win.webContents.executeJavaScript(PREP.replace('${IDX}', String(i)));
        if (prep.error) { noPainted++; if (noPainted <= 16) console.log('  SKIP  ' + String(prep.name).padEnd(16) + prep.error); continue; }

        // 真实鼠标点击 logo 实际所在的屏幕位置
        await clickAt(dbg, prep.screenX, prep.screenY);
        const ac = await win.webContents.executeJavaScript(AFTER_CLICK);
        const selected = ac.selKind === 'logo';

        // 选中后拖缩放滑块,验证「不能放缩」也一并解决
        let scaled = false;
        if (selected) {
            await win.webContents.executeJavaScript(`(() => {
                const s = document.getElementById('slElementSize');
                s.value = 620;
                s.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
            await new Promise(r => setTimeout(r, 300));
            const as = await win.webContents.executeJavaScript(AFTER_SCALE);
            scaled = as.size !== null && as.size !== prep.size0;
        }

        if (selected && scaled) okCount++;
        else {
            if (!selected) { notSelected++; if (badSel.length < 12) badSel.push({ name: prep.name, cw: prep.cw, logW: prep.logW, painted: prep.painted, status: ac.status }); }
            else { notScaled++; if (badScale.length < 8) badScale.push({ name: prep.name, size0: prep.size0 }); }
        }
    }

    console.log('─'.repeat(104));
    console.log('  logo 未被画出(无法点击)      : ' + noPainted);
    console.log('  点不中                        : ' + notSelected);
    console.log('  点中但放缩无效                : ' + notScaled);
    console.log('  完全正常(可选中 + 可放缩)     : ' + okCount);
    if (badSel.length) {
        console.log('  ── 点不中的预设 ──');
        for (const b of badSel) console.log('    ' + String(b.name).padEnd(20) + 'canvas ' + b.cw + '  _log ' + b.logW + '  画在 ' + b.painted.cx + ',' + b.painted.cy);
    }
    if (badScale.length) {
        console.log('  ── 放缩无效 ──');
        for (const b of badScale) console.log('    ' + String(b.name).padEnd(20) + '原尺寸 ' + b.size0);
    }
    console.log('─'.repeat(104));
    dbg.detach();
    const fail = notSelected + notScaled;
    finish(fail ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });
