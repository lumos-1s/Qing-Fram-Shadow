// 端到端拖动回归:加 logo 后真实鼠标拖动,验证 logo 能跟手移到画布右下半区。
//
// 背景:选中/缩放已验证(见 test-logo-hit-on-presets.js),但「移动」另有一处坐标隐患
// —— rel 比例(rx/ry)以「基准画布 _logW」为分母,而引擎在未缩放上下文里把 rx*_logW 当
// 画布像素画(engine.js:1076-1081)。dpr=2 时 canvas.width = _logW×2,于是 rx∈[0,1] 只
// 覆盖画布左上半,而 setLogoPixelPos 又把 cx/base.w 夹到 [0,1]——拖动到中心线就顶住。
// 本测试把 logo 从当前位置拖到画布 78%/62% 处,若它到不了右下半,按拖动失败统计。
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
// 主进程 stdout/stderr 在管道调用方(CI/npm/PowerShell)关闭后,残留日志会触发 EPIPE 弹窗;吞掉它。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([{ scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
ipcMain.handle('list-presets', () => fs.readdirSync(path.join(ROOT, 'shared', 'presets')).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'presets', n + '.json'), 'utf8')));
for (const c of ['list-logos', 'list-textures', 'list-templates']) ipcMain.handle(c, () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}

// 目标落点:画布宽度 78%、高度 62%(避开 1/2、2/3 吸附线)
const TX = 0.78, TY = 0.62;

// 状态 A:应用预设 + 加 logo,用 app 自有坐标(logoPos(基准),已被像素扫描验证等于绘制位)求起点
const PREP = `
(async () => {
    const A = window.App;
    const idx = ${'${IDX}'};
    const preset = A.presets[idx];
    if (!preset) return { error: 'no preset ' + idx };
    const c = document.createElement('canvas'); c.width = 900; c.height = 676;
    const g = c.getContext('2d'); g.fillStyle = '#808080'; g.fillRect(0, 0, 900, 676);
    const im = new Image();
    await new Promise(r => { im.onload = r; im.src = c.toDataURL('image/jpeg', 0.95); });
    A.image = { el: im, name: 'p.jpg', w: 900, h: 676, exif: {} };
    A.images = [A.image]; A.imageTemplates = new Map();
    A.selectedIdx = [0]; A.currentIdx = 0; A.selectedEls = [];
    A.template = A.defaultTemplate(); A.normalizeTemplate(); A.invalidateStyleCaches();
    delete A.uiDprOverride; delete A.exportScale; A.displayMax = 1100;
    A.applyPreset(preset);
    await new Promise(r => setTimeout(r, 600));
    A.scheduleRender(true); await new Promise(r => setTimeout(r, 600));
    const lc = document.createElement('canvas'); lc.width = 100; lc.height = 100;
    const lg = lc.getContext('2d'); lg.fillStyle = 'rgb(255,0,255)'; lg.fillRect(0, 0, 100, 100);
    await A.addLogoElement({ name: 'PROBE', dataUrl: lc.toDataURL('image/png') });
    A.selectedEls = []; A._skipUserEl = null; A.invalidateStyleCaches();
    A.scheduleRender(true); await new Promise(r => setTimeout(r, 600));
    const el = (A.template.logoElements || [])[0];
    if (!el) return { error: '没有 logo 元素', name: preset.templateName || '(无名)' };
    const cv = A.dom.canvas;
    const w0 = cv.width, h0 = cv.height;
    const base = A.logoBaseForOverlay();
    const pos = A.logoPos(el, base.w, base.h, el.size || 60);
    const rect = A.dom.canvas.getBoundingClientRect();
    const pcx = pos ? pos.cx : w0 / 2, pcy = pos ? pos.cy : h0 / 2;
    return {
        name: preset.templateName || '(无名)',
        w0, h0, ratio: Math.round(w0 / (A.dom.canvas._logW || 1) * 1000) / 1000,
        startX: rect.left + (pcx / w0) * rect.width,
        startY: rect.top + (pcy / h0) * rect.height,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        pos0: { cx: Math.round(pcx), cy: Math.round(pcy) },
    };
})()
`;

// 状态 B:拖完松手后,先等模型位置收敛再判定(重预设连拖时渲染/输入管线繁忙,
// 松手后坐标可能仍在半路;固定 700ms 单次读取会把正常拖动误判成"卡在半途"),
// 然后用 app 坐标(基准口径)求新位置,像素扫描仅作旁证
const AFTER = `
(async () => {
    const A = window.App;
    const rd = () => {
        const el = (A.template.logoElements || [])[0];
        if (!el) return null;
        const b = A.logoBaseForOverlay();
        const pos = A.logoPos(el, b.w, b.h, el.size || 60);
        return { cx: Math.round(pos.cx), cy: Math.round(pos.cy) };
    };
    let prev = null, stable = 0, rounds = 0, cur = null;
    for (; rounds < 20 && stable < 2; rounds++) {
        await new Promise(r => setTimeout(r, 200));
        cur = rd();
        stable = cur && prev && cur.cx === prev.cx && cur.cy === prev.cy ? stable + 1 : 0;
        prev = cur;
    }
    A.scheduleRender(true);
    await new Promise(r => setTimeout(r, 350));
    const el = (A.template.logoElements || [])[0];
    const cv = A.dom.canvas;
    const w0 = cv.width, h0 = cv.height;
    const base = A.logoBaseForOverlay();
    const pos = A.logoPos(el, base.w, base.h, el.size || 60);
    const isMag = (d, i) => d[i] > 190 && d[i + 2] > 190 && d[i + 1] < 90;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
    try {
        const d = cv.getContext('2d').getImageData(0, 0, w0, h0).data;
        for (let y = 0, q = 0; y < h0; y++) for (let x = 0; x < w0; x++, q++) {
            const p = q * 4;
            if (isMag(d, p)) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
    } catch (e) {}
    return {
        painted: n >= 50 ? { cx: Math.round((x0 + x1) / 2), cy: Math.round((y0 + y1) / 2), n } : null,
        stored: pos ? { cx: Math.round(pos.cx), cy: Math.round(pos.cy) } : null,
        rx: el ? el.rx : null, ry: el ? el.ry : null, x: el ? el.x : null, y: el ? el.y : null, rel: el ? el.rel : null,
        w0, h0,
    };
})()
`;

async function mouseEvent(dbg, type, x, y, extra) {
    const cmd = Object.assign({ type, x, y, button: 'left', buttons: type.indexOf('Released') >= 0 ? 0 : 1, clickCount: 1 }, extra || {});
    // 单次输入命令 5s 未回(Chromium 输入管线在超长跑下偶发停滞,渲染器本身正常)
    // 则跳过该事件继续,避免测试被无限挂起;最终结果不会因此虚快
    await Promise.race([
        dbg.sendCommand('Input.dispatchMouseEvent', cmd).then(() => {}),
        new Promise(r => setTimeout(r, 5000)),
    ]);
}

async function dragTo(dbg, x0, y0, x1, y1, steps) {
    await mouseEvent(dbg, 'mousePressed', x0, y0);
    for (let i = 1; i <= steps; i++) {
        await mouseEvent(dbg, 'mouseMoved', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
        await new Promise(r => setTimeout(r, 16));
    }
    await mouseEvent(dbg, 'mouseReleased', x1, y1);
    await new Promise(r => setTimeout(r, 300));
}

// 退出码收尾:Electron 主进程完全忽略 process.exitCode(app.quit() 之后设 1 实测仍得 0),
// 只有 app.exit(code) 能带出非 0。此前本文件设了 process.exitCode,断言失败仍返回 0。
function finish(code) { app.exit(code || 0); }

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try {
            const p = new URL(req.url).searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (e) { return new Response('NF', { status: 404 }); }
    });
    const win = new BrowserWindow({ width: 1500, height: 950, show: false, webPreferences: { preload: path.join(__dirname, 'preload-measure.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 120; i++) { if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas)')) break; await new Promise(r => setTimeout(r, 250)); }
    for (let i = 0; i < 80; i++) { if ((await win.webContents.executeJavaScript('(window.App.presets || []).length')) > 0) break; await new Promise(r => setTimeout(r, 250)); }
    const count = await win.webContents.executeJavaScript('(window.App.presets || []).length');
    // 启动期「新手引导」弹窗(requestIdleCallback,最迟 4s)会盖住整窗:此后真实鼠标
    // 事件都落在弹窗上,表现为「全部拖不动」。禁用弹出并隐藏,保证输入直达画布。
    // 不调 closeIntro():它写 localStorage 标记,而测试与真实应用共用用户数据目录。
    await win.webContents.executeJavaScript(`(() => {
        window.App.showIntroIfNeeded = () => {};
        const m = document.getElementById('introModal');
        if (m) m.style.display = 'none';
        return 1;
    })()`);
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
let done = false;
    // 预设数量会增长(当前 87 个),按 20 秒/个留足余量;看门狗只防「真死锁/无限挂起」,不提前打断慢速正常进程
    const watchdogMs = Math.max(1300000, count * 20000);
    (async () => {
        await new Promise(r => setTimeout(r, watchdogMs));
        if (done) return;
        let crash = 'unknown'; try { crash = win.webContents.isCrashed(); } catch (e) { crash = 'ERR'; }
        let ping = 'timeout'; try {
            ping = await Promise.race([
                win.webContents.executeJavaScript('"PONG:" + Date.now()'),
                new Promise(r => setTimeout(r, 3000)),
            ]);
        } catch (e) { ping = 'ERR:' + String(e).slice(0, 80); }
        console.log('!!WATCHDOG 超时未完成 isCrashed=' + crash + ' ping=' + ping);
        console.log('   提示:全量跑完约需 ' + Math.ceil(count * 15 / 60) + ' 分钟;若本机慢于预期,请调大本超时继续等待而非判定失败');
        app.exit(3);
    })();

    let ok = 0, blocked = 0, skipped = 0;
    const bad = [];
    console.log('logo 真实拖动(目标落到画布 ' + Math.round(TX * 100) + '%/' + Math.round(TY * 100) + '% 处)');
    console.log('─'.repeat(104));

    for (let i = 0; i < count; i++) {
        const prep = await win.webContents.executeJavaScript(PREP.replace('${IDX}', String(i)));
        if (prep.error) { skipped++; if (skipped <= 12) console.log('  SKIP  ' + String(prep.name).padEnd(20) + prep.error); continue; }
        process.stdout.write('\r  ' + (i + 1) + '/' + count + ' ' + String(prep.name).padEnd(14));
        // 拖动坐标必须在**拖动前即时重读**画布矩形再换算:PREP 里的 rect/startX 是 600ms 前的,
        // 期间布局或适配缩放变动几像素,按下点就会偏出 logo → 全部变成画布平移(模型纹丝不动)。
        // 实测同一份代码单跑 85/85、进全链却 85 个全"拖不动",差别就在这个旧矩形。
        const g = await win.webContents.executeJavaScript('(() => { const r = window.App.dom.canvas.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()');
        const startX = g.l + (prep.pos0.cx / prep.w0) * g.w, startY = g.t + (prep.pos0.cy / prep.h0) * g.h;
        const tx = g.l + TX * g.w, ty = g.t + TY * g.h;
        await dragTo(dbg, startX, startY, tx, ty, 12);
        const after = await win.webContents.executeJavaScript(AFTER);
        // 判定:以 app 坐标(基准口径,已被像素扫描验证 = 绘制位)为主,像素扫描仅旁证
        const sx = after.stored ? after.stored.cx / after.w0 : null, sy = after.stored ? after.stored.cy / after.h0 : null;
        const px = after.painted ? after.painted.cx / after.w0 : null, py = after.painted ? after.painted.cy / after.h0 : null;
        const fx = sx != null ? sx : (px != null ? px : 0);
        const fy = sy != null ? sy : (py != null ? py : 0);
        const dxv = fx - TX, dyv = fy - TY;
        const reached = Math.abs(dxv) <= 0.045 && Math.abs(dyv) <= 0.045 && fx > 0.60 && fy > 0.50;
        const paintTorn = px != null && sx != null && (Math.abs(px - sx) > 0.035 || Math.abs(py - sy) > 0.035);
        if (reached) ok++;
        else {
            blocked++;
            // 失败现场:留几何对比 + 顶层元素 + 弹窗 + 截图(只取前 2 个,避免刷屏/占空间)
            if (blocked <= 2) {
                try {
                    const diag = await win.webContents.executeJavaScript(`(() => {
                        const A = window.App, cv = A.dom.canvas, r = cv.getBoundingClientRect();
                        const el = document.elementFromPoint(${startX}, ${startY});
                        const ov = [...document.querySelectorAll('.modal-overlay')].map(m => ({ id: m.id, display: getComputedStyle(m).display }));
                        return { rectNow: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
                                 topEl: el ? (el.id || el.className || el.tagName) : null,
                                 visibleOverlays: ov.filter(o => o.display !== 'none'),
                                 focus: document.hasFocus(), transform: getComputedStyle(cv).transform,
                                 pan: [A.panX, A.panY], dragEl: !!A._dragEl };
                    })()`);
                    console.log('\n  [现场] ' + prep.name + ' rectPREP=' + JSON.stringify(prep.rect) + ' ' + JSON.stringify(diag));
                    const png = (await win.webContents.capturePage()).toPNG();
                    const dir = path.join(app.getPath('temp'), 'qfs-logodrag-fail');
                    fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(path.join(dir, 'fail-' + i + '.png'), png);
                } catch (e) { console.log('\n  [现场诊断失败] ' + String(e && e.message)); }
            }
            if (bad.length < 30) {
                bad.push({ name: prep.name, ratio: prep.ratio,
                    fx: fx.toFixed(3), fy: fy.toFixed(3),
                    painted: after.painted, stored: after.stored,
                    rx: after.rx, x: after.x, rel: after.rel, cv: after.w0 + 'x' + after.h0, s0: prep.w0 + 'x' + prep.h0, tear: paintTorn });
            }
        }
    }

    console.log('─'.repeat(104));
    console.log('  拖动到位(≈78%/62%)     : ' + ok);
    console.log('  拖不到(卡在半途)       : ' + blocked);
    console.log('  跳过的预设            : ' + skipped);
    for (const b of bad) {
        console.log('    ' + String(b.name).padEnd(16) + ' ratio=' + b.ratio + ' 到 ' + b.fx + ',' + b.fy + '  rx=' + b.rx + ' rel=' + b.rel + ' cv ' + b.s0 + '→' + b.cv + ' 画在 ' + (b.painted ? b.painted.cx + ',' + b.painted.cy : '-') + ' 存 ' + (b.stored ? b.stored.cx + ',' + b.stored.cy : '-'));
    }
    console.log('─'.repeat(104));
    done = true;
    dbg.detach();
    finish(blocked ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });