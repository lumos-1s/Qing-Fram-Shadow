// 验证元素「四边吸附」与「对齐/均分/统一尺寸」的几何结果
// 走真实 App 实例,断言具体数值——纯几何逻辑,不依赖像素比对
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

const CHECK = `
async () => {
    const App = window.App;
    await App.loadPresets();
    const out = { snap: [], align: [] };
    const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1 : tol);

    // 造一个 1000x800 的显示画布,并固定测量画布=显示画布(避免缩放换算干扰断言)
    const cv = App.dom.canvas;
    cv.width = 1000; cv.height = 800; cv._logW = 1000; cv._logH = 800;
    const cw = 1000, ch = 800;

    const mkLogo = (x, y, size, ratio) => ({ name: 'L', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', x, y, size, ratio: ratio || 0.4, opacity: 100, z: 10 });

    // ── ① 吸附 ──
    const el = mkLogo(0, 0, 200, 0.4);       // 半宽 100,半高 40
    const dim = App._logoDrawSize(el);
    const kx = Math.max(10, Math.min(cw * 0.05, dim.w / 2));   // min(50,100)=50
    const ky = Math.max(10, Math.min(ch * 0.05, dim.h / 2));   // min(40,40)=40
    const glx = Math.min(dim.w / 2 + kx, cw / 2);              // 150
    const gly = Math.min(dim.h / 2 + ky, ch / 2);              // 80
    const S = (x, y) => App.snapToGuides(x, y, cw, ch, el);

    const cases = [
        ['拖到左上角',        30, 30,   glx, gly,             'left', 'top'],
        ['拖到右下角',       970, 770,  cw - glx, ch - gly,    'right', 'bottom'],
        ['拖到右上角',       970, 30,   cw - glx, gly,         'right', 'top'],
        ['拖到左下角',        30, 770,  glx, ch - gly,         'left', 'bottom'],
        ['拖到左中',          30, 400,  glx, ch / 2,           'left', 'vcenter'],
        ['拖到上中',         500, 30,   cw / 2, gly,           'hcenter', 'top'],
    ];
    for (const [label, ix, iy, ex, ey, ev, eh] of cases) {
        const r = S(ix, iy);
        const ok = near(r.x, ex) && near(r.y, ey) && r.vEdge === ev && r.hEdge === eh;
        out.snap.push({ label, ok, got: r.x + ',' + r.y + ' [' + r.vEdge + ',' + r.hEdge + ']', expect: ex + ',' + ey + ' [' + ev + ',' + eh + ']' });
    }
    // 三分线吸附不能被边缘逻辑破坏
    {
        const r = S(cw / 3 + 4, ch / 3 - 4);
        const ok = near(r.x, cw / 3) && near(r.y, ch / 3) && r.v === 0 && r.h === 0;
        out.snap.push({ label: '三分线吸附仍生效', ok, got: r.x + ',' + r.y + ' v=' + r.v + ' h=' + r.h, expect: (cw/3) + ',' + (ch/3) + ' v=0 h=0' });
    }
    // 画布正中间:应吸附居中
    {
        const r = S(500, 400);
        const ok = near(r.x, cw / 2) && near(r.y, ch / 2);
        out.snap.push({ label: '正中间吸附居中', ok, got: r.x + ',' + r.y, expect: (cw/2) + ',' + (ch/2) });
    }
    // 大 Logo:贴边距离应随尺寸增大,保证完整可见(半宽 400 → glx 应显著大于小 Logo 的 150)
    {
        const big = mkLogo(0, 0, 800, 0.4);   // 半宽 400,半高 160
        const rb = App.snapToGuides(20, 20, cw, ch, big);
        const ok = rb.x >= 400 && rb.x <= cw / 2 && rb.y >= 160;
        out.snap.push({ label: '大Logo贴边仍完整可见', ok, got: 'x=' + rb.x + ' y=' + rb.y, expect: 'x>=400 且 x<=500, y>=160' });
    }

    // ── ② 对齐 ──
    const setup = () => {
        const A = mkLogo(200, 200, 100, 0.5);   // 50x25
        const B = mkLogo(600, 300, 200, 0.5);   // 100x50
        const C = mkLogo(800, 700, 300, 0.5);   // 150x75
        App.template = App.defaultTemplate();
        App.template.logoElements = [A, B, C];
        App.template.decorConfig = App.template.decorConfig || {};
        App.template.decorConfig.stickers = [];
        App.template.decorConfig.textLines = [];
        App.selectedEls = [{ kind: 'logo', obj: A }, { kind: 'logo', obj: B }, { kind: 'logo', obj: C }];
        return { A, B, C };
    };

    // 外接盒(按 _elBoxSize 实际值):A 100x50@(200,200) B 200x100@(600,300) C 300x150@(800,700)
    // 合并包围盒:x 150~900, y 175~775;中心 x 525, y 475
    {
        const { A, B, C } = setup();
        App.alignSelectedEls('left');
        // 左边缘都对齐到 x=150 → 中心 = 150 + 各自半宽
        const ok = near(A.x, 200) && near(B.x, 250) && near(C.x, 300) && A.y === 200 && C.y === 700;
        out.align.push({ label: '左对齐', ok, got: [A.x, B.x, C.x].join(','), expect: '200,250,300' });
    }
    {
        const { A, B, C } = setup();
        App.alignSelectedEls('hcenter');
        // 各元素中心都对齐到包围盒中心 x = (150+950)/2 = 550
        const ok = near(A.x, 550) && near(B.x, 550) && near(C.x, 550);
        out.align.push({ label: '水平居中', ok, got: [A.x, B.x, C.x].join(','), expect: '550,550,550' });
    }
    {
        const { A, B, C } = setup();
        App.alignSelectedEls('right');
        // 右边缘都对齐到 x = 950 → 中心 = 950 - 各自半宽(50/100/150)
        const ok = near(A.x, 900) && near(B.x, 850) && near(C.x, 800);
        out.align.push({ label: '右对齐', ok, got: [A.x, B.x, C.x].join(','), expect: '900,850,800' });
    }
    {
        const { A, B, C } = setup();
        App.alignSelectedEls('sameSize');
        const ok = A.size === 200 && B.size === 200 && C.size === 200;
        out.align.push({ label: '统一尺寸取平均(100/200/300→200)', ok, got: [A.size, B.size, C.size].join(','), expect: '200,200,200' });
    }
    {
        const { A, B, C } = setup();
        App.alignSelectedEls('distH');
        // cx: 200,600,800 → 首尾不动,中间=200+(800-200)/2=500
        const ok = near(A.x, 200) && near(B.x, 500) && near(C.x, 800);
        out.align.push({ label: '水平均分', ok, got: [A.x, B.x, C.x].join(','), expect: '200,500,800' });
    }
    {
        const { A, B, C } = setup();
        App.alignSelectedEls('top');
        // 各元素中心都对齐到包围盒顶边 y = 175 → 中心 = 175 + 各自半高(25/50/75)
        const ok = near(A.y, 200) && near(B.y, 225) && near(C.y, 250);
        out.align.push({ label: '顶对齐', ok, got: [A.y, B.y, C.y].join(','), expect: '200,225,250' });
    }    // 单元素应拒绝并提示
    {
        setup();
        App.selectedEls = [{ kind: 'logo', obj: App.template.logoElements[0] }];
        App.alignSelectedEls('left');
        const ok = String(App.statusMsg || '').includes('两个元素');
        out.align.push({ label: '不足两个元素时拒绝', ok, got: String(App.statusMsg || '').slice(0, 30), expect: '含"两个元素"' });
    }
    // 锚点定位元素:对齐后应保留锚点(不转成像素坐标)
    {
        const D = { name: 'D', dataUrl: 'x', x: 'right', y: 'bottom', size: 100, ratio: 0.5, offsetX: 20, offsetY: 20, opacity: 100, z: 10 };
        const E = mkLogo(300, 300, 100, 0.5);
        App.template = App.defaultTemplate();
        App.template.logoElements = [D, E];
        App.selectedEls = [{ kind: 'logo', obj: D }, { kind: 'logo', obj: E }];
        App.alignSelectedEls('left');
        const ok = D.x === 'right' && D.y === 'bottom' && typeof D.offsetX === 'number' && D.offsetX >= 0;
        out.align.push({ label: '锚点元素对齐后仍是锚点', ok, got: 'x=' + D.x + ' y=' + D.y + ' offsetX=' + D.offsetX, expect: "x='right' y='bottom' offsetX>=0" });
    }
    return out;
}
`;


// 退出码收尾:Electron 主进程完全忽略 process.exitCode(app.quit() 之后设 1 实测仍得 0),
// 只有 app.exit(code) 能带出非 0。此前本文件只调 app.quit(),断言失败也返回 0。
function finish(code) { app.exit(code || 0); }

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try { const u = new URL(req.url); const p = u.searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (e) { return new Response('NF', { status: 404 }); }
    });
    const win = new BrowserWindow({
        width: 1400, height: 900, show: false,
        webPreferences: { preload: path.join(__dirname, 'preload-measure.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.webContents.on('console-message', (_e, l, m) => { if (l >= 2) console.log('  [renderer] ' + String(m).slice(0, 250)); });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas && window.App.presets)')) break;
        await new Promise(r => setTimeout(r, 250));
    }
    const r = await win.webContents.executeJavaScript(`(${CHECK})()`);
    let fail = 0;
    console.log('元素吸附 · 几何验证');
    console.log('─'.repeat(92));
    for (const x of r.snap) {
        if (!x.ok) fail++;
        console.log(`  ${x.ok ? 'OK  ' : 'FAIL'} ${x.label.padEnd(22)} 实际=${String(x.got).padEnd(34)} 期望=${x.expect}`);
    }
    console.log('─'.repeat(92));
    console.log('元素对齐 / 均分 / 统一尺寸');
    console.log('─'.repeat(92));
    for (const x of r.align) {
        if (!x.ok) fail++;
        console.log(`  ${x.ok ? 'OK  ' : 'FAIL'} ${x.label.padEnd(28)} 实际=${String(x.got).padEnd(26)} 期望=${x.expect}`);
    }
    console.log('─'.repeat(92));
    const total = r.snap.length + r.align.length;
    console.log(fail ? `✖ ${fail}/${total} 项未通过` : `✓ 全部 ${total} 项通过`);
    finish(fail ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });
