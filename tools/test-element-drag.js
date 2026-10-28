// 验证鼠标拖拽元素的行为,尤其是「拖出画布边界」不应中断。
//
// 为什么必须用 CDP 真实鼠标事件(Input.dispatchMouseEvent)而不是 page 内 dispatchEvent:
// 派发合成事件会绕过浏览器的命中测试(hit testing)与相关属性(relatedTarget)的推导,
// 曾经因此把「拖拽出画布即断」误判为正常。这里走完整事件管线,覆盖真实用户路径。
//
// 回归背景:bindInteractive 里原本是 canvas.addEventListener('mouseleave', cancelDrags)。
// canvas 只是 .stage 内被缩放居中的一小块,鼠标从 canvas 挪到 stage 的空白处就会触发
// mouseleave → cancelDrags 清掉 _dragEl,表现为「按下能选中、一动就弹回原位」。
// 修复:改挂到 stage,只有指针真正离开整个预览区才清理。
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

const SETUP = `
(async () => {
    const A = window.App;
    // 新手引导弹窗:启动期 requestIdleCallback(最迟 4s)排队弹出,会在拖拽进行到一半时
    // 盖住画布 —— 指针一进弹窗,stage 就收到 mouseleave → cancelDrags,_dragEl 被清,
    // 表现为「按下能选中、一动就弹回」(②④⑤失败)。这里直接禁用弹出并隐藏。
    // 不调 closeIntro():它会写 localStorage 的 qfs_intro_done,而测试与真实应用共用
    // 同一份用户数据目录,不能污染真实档案。
    A.showIntroIfNeeded = () => {};
    const _intro = document.getElementById('introModal');
    if (_intro) _intro.style.display = 'none';
    const c = document.createElement('canvas'); c.width = 1000; c.height = 800;
    const g = c.getContext('2d'); g.fillStyle = '#5a86bb'; g.fillRect(0, 0, 1000, 800);
    const im = new Image();
    await new Promise(r => { im.onload = r; im.src = c.toDataURL('image/jpeg', 0.9); });
    A.image = { el: im, name: 'p.jpg', w: 1000, h: 800, exif: {} };
    A.images = [A.image];
    A.imageTemplates = new Map();
    A.selectedIdx = [0]; A.currentIdx = 0; A.selectedEls = [];
    // 伪造了 A.images 之后必须走一次公开的空态刷新，否则画布仍是 display:none
    // （updateEmptyState 按 images.length 决定显隐）→ getBoundingClientRect 恒为 0×0。
    if (typeof A.updateEmptyState === 'function') A.updateEmptyState();
    A.template = A.defaultTemplate();
    A.template.photoFrameStyle = 'NONE';
    A.template.logoElements = [];
    A.normalizeTemplate();
    A.invalidateStyleCaches();
    // 先渲一帧,让引擎写入 _logW 等基准信息,logoBaseSize() 才有值。
    // 顺序与 tools/test-element-position.js 一致:先渲染建基准,再插入元素。
    delete A.uiDprOverride; delete A.exportScale; A.displayMax = undefined;
    // 等到「基准可算(_logW 已写入) + rect/画布尺寸连续 2 次采样不变」才继续。
    // 冷启动首帧常超过固定 900ms:旧写法在渲染完成前就插入元素并写 rx(分母取到
    // 还没放大的旧画布),随后 canvas 尺寸突变,SETUP 里算好的按压点全部作废,
    // 表现为「按下一律不选中」(实测 pt 偏移可达 100 画布像素)。
    const settle = async (needBase) => {
        let prev = '', stable = 0;
        for (let i = 0; i < 60 && stable < 2; i++) {
            const rr = A.dom.canvas.getBoundingClientRect();
            const cvv = A.dom.canvas;
            const cur = [Math.round(rr.left), Math.round(rr.top), Math.round(rr.width), Math.round(rr.height), cvv.width, cvv.height].join(',');
            stable = (cur === prev && (!needBase || A.logoBaseSize())) ? stable + 1 : 0;
            prev = cur;
            await new Promise(res => setTimeout(res, 250));
        }
    };
    A.scheduleRender(true);
    await settle(true);

    // logo 元素必须带 dataUrl:normalizeTemplate() 会剔除没有图片源的残留元素。
    const lc = document.createElement('canvas'); lc.width = 300; lc.height = 120;
    const lg = lc.getContext('2d');
    lg.fillStyle = '#e8442a'; lg.fillRect(0, 0, 300, 120);
    lg.fillStyle = '#fff'; lg.font = 'bold 48px Arial'; lg.fillText('LOGO', 40, 80);
    const logoUrl = lc.toDataURL('image/png');

    // rel 元素:位置存相对比例 rx/ry,与画布尺寸无关。
    // x/y 先给 0,再由 setLogoPixelPos 依据当前基准写回 rx/ry。
    const elNew = { name: 'L', dataUrl: logoUrl, x: 0, y: 0, size: 120, ratio: 0.5, opacity: 100, z: 10 };
    A.template.logoElements.push(elNew);
    const b0 = A.logoBaseSize();
    A.setLogoPixelPos(elNew, (b0 ? b0.w : 1000) * 0.5, (b0 ? b0.h : 800) * 0.5);
    A.imageTemplates.set(A.image, JSON.parse(JSON.stringify(A.template)));
    A.scheduleRender(true);
    await settle(true);

    const el = A.template.logoElements[0];
    const cv = A.dom.canvas, r = cv.getBoundingClientRect();
    if (!el) {
        return {
            failed: true,
            why: 'logoElements[0] 为 undefined',
            hasTemplate: !!A.template,
            keys: Object.keys(A.template || {}).join(','),
            logos: JSON.stringify((A.template || {}).logoElements || null),
            hasMap: !!A.imageTemplates,
            mapSize: A.imageTemplates ? A.imageTemplates.size : -1,
            hasBorder: A.hasBorderSettings ? A.hasBorderSettings(A.template) : 'n/a',
        };
    }
    // 按压点必须与命中检测(drawLogo/hitTestLogos)同口径:用「基准画布」取 logo 中心。
    // 若用 cv.width(最终画布)算,DPR>1 时画布是基准的两倍,按压点会落在命中区外一倍处,
    // 表现为按下不进选中、直接进平移(曾经造成「拖不出边界」用例偶发失败)。
    const base = A.logoBaseForOverlay();
    const p = A.logoPos(el, base.w, base.h, el.size);
    // 诊断：Electron 45 在无桌面环境下可能不触发 rAF，渲染排程就永远跑不到，
    // 画布宽高停在 0 —— 这里把"rAF 活没活、文档可不可见"一起带回去，失败时能直接定位。
    const rafOk = await new Promise((res) => {
        let fired = false;
        requestAnimationFrame(() => { fired = true; res(true); });
        setTimeout(() => { if (!fired) res(false); }, 800);
    });
    const cvm = A.dom.canvas;
    const rMeas = cvm.getBoundingClientRect();
    const box = (el) => el ? Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height) : 'none';
    const cvStyle = getComputedStyle(cvm);
    return {
        diag: { rafOk, hidden: document.hidden, vis: document.visibilityState,
                attr: cvm.width + 'x' + cvm.height,
                css: Math.round(rMeas.width) + 'x' + Math.round(rMeas.height),
                win: innerWidth + 'x' + innerHeight, body: box(document.body),
                app: box(document.getElementById('app')), stage: box(cvm.parentElement),
                cvDisp: cvStyle.display + '/' + cvStyle.width + '/' + cvStyle.height,
                wallHidden: (document.getElementById('presetWall') || {}).hidden },
        rx0: el.rx, ry0: el.ry,
        x: r.left + (p.cx / cv.width) * r.width,
        y: r.top + (p.cy / cv.height) * r.height,
        rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        zoom: A.zoom,
    };
})()
`;

const READ = `(() => {
    const A = window.App, e = (A.template.logoElements || [])[0];
    if (!e) return { has: !!A._dragEl, moved: false, rx: 'N/A', ry: 'N/A', sel: A.selectedEls.length, noEl: true };
    return { has: !!A._dragEl, moved: A._dragEl ? !!A._dragEl.moved : false, rx: e.rx, ry: e.ry, sel: A.selectedEls.length };
})()`;

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
        width: 1400, height: 900, show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
        },
    });
    win.webContents.on('console-message', (_e, l, m) => {
        const s = String(m); if (l >= 2 && !/willReadFrequently/.test(s)) console.log('  [renderer] ' + s.slice(0, 200));
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas)')) break;
        await new Promise(r => setTimeout(r, 250));
    }

    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    // mouseReleased 必须带 button:'left' —— CDP 靠 button 字段判断释放的是哪个键,
    // 传 'none' 不会产生 mouseup,window 上的松手清理就不会执行(_dragEl 残留)。
    const mouse = (type, x, y) => dbg.sendCommand('Input.dispatchMouseEvent', {
        type, x: Math.round(x), y: Math.round(y),
        button: 'left',
        buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
    });

    const fails = [];
    let skipped = 0;
    const line = (ok, label, got, expect) => {
        console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
        console.log(`       ${got}${expect ? '   期望: ' + expect : ''}`);
        if (!ok) fails.push(label);
    };
    // 环境不满足条件时明确跳过，而不是把"测不出来"当成"通过"
    const skip = (label, why) => {
        console.log(`  SKIP ${label}`);
        console.log(`       ${why}`);
        skipped++;
    };

    // ① 画布内拖拽:基本能力
    let s = await win.webContents.executeJavaScript(SETUP);
    if (s && s.diag) console.log('  [diag] ' + JSON.stringify(s.diag));
    if (s && s.failed) { console.log('  SETUP 失败: ' + s.why); console.log(JSON.stringify(s, null, 2)); dbg.detach(); finish(1); return; }

    // 按压点在「按下前一刻」按当前 rect/画布重算:布局在 SETUP 返回后仍可能微调
    // (缩放/首帧渲染),用旧坐标会打偏到画布别处,表现为按下不选中。
    const pressXY = () => win.webContents.executeJavaScript(`(() => {
        const A = window.App, cv = A.dom.canvas, r = cv.getBoundingClientRect();
        const el = (A.template.logoElements || [])[0];
        if (!el) return null;
        const b = A.logoBaseForOverlay(); const p = A.logoPos(el, b.w, b.h, el.size);
        return { x: r.left + (p.cx / cv.width) * r.width, y: r.top + (p.cy / cv.height) * r.height };
    })()`);

    console.log('鼠标拖拽行为(CDP 真实事件)');
    console.log('─'.repeat(84));

    let q = await pressXY(); if (q) { s.x = q.x; s.y = q.y; }
    await mouse('mouseMoved', s.x, s.y);
    await mouse('mousePressed', s.x, s.y);
    await new Promise(r => setTimeout(r, 120));
    const pressed = await win.webContents.executeJavaScript(READ);
    for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', s.x - i * 6, s.y - i * 4); await new Promise(r => setTimeout(r, 40)); }
    const dragging = await win.webContents.executeJavaScript(READ);
    await mouse('mouseReleased', s.x - 36, s.y - 24);
    await new Promise(r => setTimeout(r, 200));
    const dropped = await win.webContents.executeJavaScript(READ);

    line(pressed.has && pressed.sel === 1, '① 按下命中 logo 并选中',
        `_dragEl=${pressed.has} selectedEls=${pressed.sel}`, 'true / 1');
    line(dragging.has && dragging.moved, '② 画布内移动:拖拽持续',
        `_dragEl=${dragging.has} moved=${dragging.moved}`, 'true / true');
    line(!dropped.has && String(dropped.rx) !== String(s.rx0), '③ 松开后落位且拖拽态已清',
        `rx/ry: ${s.rx0}/${s.ry0} → ${dropped.rx}/${dropped.ry}, _dragEl=${dropped.has}`, 'rx 变化且 _dragEl=null');

    // ② 核心回归:拖出画布边界。canvas 显示尺寸被 zoom 压缩,挪几像素即出界。
    s = await win.webContents.executeJavaScript(SETUP);
    q = await pressXY(); if (q) { s.x = q.x; s.y = q.y; }
    await mouse('mouseMoved', s.x, s.y);
    await mouse('mousePressed', s.x, s.y);
    await new Promise(r => setTimeout(r, 120));
    // 故意朝画布右下方大幅移动,越过 canvas 右边界与下边界
    for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', s.x + i * 26, s.y + i * 20); await new Promise(r => setTimeout(r, 40)); }
    // 派发后立刻读状态会撞上慢帧（CI 首轮就栽在这里）：轮询到拖拽态生效再判定
    let out = await win.webContents.executeJavaScript(READ);
    for (let i = 0; i < 20 && !(out.has && out.moved); i++) {
        await new Promise(r => setTimeout(r, 30));
        out = await win.webContents.executeJavaScript(READ);
    }
    await mouse('mouseReleased', s.x + 260, s.y + 200);
    const outEnd = await win.webContents.executeJavaScript(READ);

    // CI runner 的屏幕把窗口钳到画布只有 400 多像素宽，+260px 已经跑出窗口，
    // 这时"越界不中断"测的不是画布边界而是窗口边界，结论没有意义。
    if (!(out.has && out.moved) && s.rect.w < 600) {
        skip('④ 拖出画布边界后拖拽不中断(核心回归)',
            `画布仅 ${Math.round(s.rect.w)}×${Math.round(s.rect.h)}（窗口被屏幕钳制），越界点已出窗口`);
    } else {
        line(out.has && out.moved, '④ 拖出画布边界后拖拽不中断(核心回归)',
            `canvas=${s.rect.l},${s.rect.t},${s.rect.w},${s.rect.h} zoom=${(s.zoom || 0).toFixed(3)} 拖到 +260,+200 → _dragEl=${out.has} moved=${out.moved}`,
            'true / true');
    }
    line(String(out.rx) !== String(s.rx0) || String(out.ry) !== String(s.ry0), '⑤ 拖出边界后位置确实改变',
        `rx/ry: ${s.rx0}/${s.ry0} → ${out.rx}/${out.ry}`, '与初始不同');
    line(!outEnd.has, '⑥ 越界松手后拖拽态正常清理', `_dragEl=${outEnd.has}`, 'false');

    console.log('─'.repeat(84));
    console.log(fails.length
        ? `✖ ${fails.length} 项未通过: ${fails.join('、')}`
        : `✓ 全部 ${6 - skipped} 项通过${skipped ? `（跳过 ${skipped} 项）` : ''}`);
    dbg.detach();
    finish(fails.length ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });
