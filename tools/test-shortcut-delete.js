// 验证快捷键 Delete/Backspace 的删除优先级。
//
// 回归背景:setupShortcuts 里判断「优先删拼图字幕」的条件原本是
//     this.template.puzzle && $('cbPuzzleGapPick').value
// 当时 refreshPuzzleUI 在 _puzzleSlot 为空时会**自动把下拉选成 's0'**
// (app-puzzle.js,第一个选项是「不选中」value='' 但随后被覆盖;现在改成"未点选 = 不选中",
//  只有 setActivePuzzleSlot 显式选中才会写下拉,所以下面的 setup 会先模拟点选格子 0)。
// 于是任何带 puzzle 字段的模板(哪怕拼图根本没启用)都让该 value 恒为 's0',
// Delete 永远走 deleteCaption,画布上选中的元素一个都删不掉。
// 现象:按 Delete 没反应,状态栏却提示「已删除字幕 S0」。
//
// 正确行为:仅当「拼图已启用」且「该槽位确实有字幕」时才删字幕,否则删选中元素。
// 用 CDP 真实按键(Input.dispatchKeyEvent)走完整 keydown 链。
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

// 造一张图 + 一个 logo,并按参数设定 puzzle 状态
// opt 通过 JSON 内联注入(CDP 的 executeJavaScript 只接受单个 code 字符串)
const setup = (opt) => `(async () => {
    const opt = ${JSON.stringify(opt)};
    const A = window.App;
    const c = document.createElement('canvas'); c.width = 1000; c.height = 800;
    const g = c.getContext('2d'); g.fillStyle = '#5a86bb'; g.fillRect(0, 0, 1000, 800);
    const im = new Image();
    await new Promise(r => { im.onload = r; im.src = c.toDataURL('image/jpeg', 0.9); });
    A.image = { el: im, name: 'p.jpg', w: 1000, h: 800, exif: {} };
    A.images = [A.image]; A.imageTemplates = new Map();
    A.selectedIdx = [0]; A.currentIdx = 0; A.selectedEls = [];
    A.template = A.defaultTemplate();
    A.normalizeTemplate(); A.invalidateStyleCaches();
    A.scheduleRender(true); await new Promise(r => setTimeout(r, 800));

    const lc = document.createElement('canvas'); lc.width = 300; lc.height = 120;
    const lg = lc.getContext('2d'); lg.fillStyle = '#e8442a'; lg.fillRect(0, 0, 300, 120);
    lg.fillStyle = '#fff'; lg.font = 'bold 48px Arial'; lg.fillText('LOGO', 40, 80);
    const el = { name: 'L', dataUrl: lc.toDataURL('image/png'), x: 0, y: 0, size: 120, ratio: 0.5, opacity: 100, z: 10 };
    A.template.logoElements.push(el);
    const b0 = A.logoBaseSize();
    A.setLogoPixelPos(el, (b0 ? b0.w : 1000) * 0.5, (b0 ? b0.h : 800) * 0.5);

    // puzzle 状态:enabled 与 captions[0] 是否存在共同决定 Delete 走哪条分支
    A.template.puzzle = {
        enabled: opt.puzzleEnabled,
        layout: 'single',
        slots: [{}],
        captions: opt.hasCaption ? { 0: '字幕内容' } : {},
        gapCaptions: {},
    };
    A.imageTemplates.set(A.image, JSON.parse(JSON.stringify(A.template)));
    A.scheduleRender(true); await new Promise(r => setTimeout(r, 900));
    A.refreshPuzzleUI();
    // 模拟用户在画布上点选第一个格子:选中改为显式(未点选时下拉为空,Delete 不该删字幕)
    A.setActivePuzzleSlot(0);
    A.selectedEls = [{ kind: 'logo', obj: A.template.logoElements[0] }];

    const pick = A.$('cbPuzzleGapPick');
    return {
        logos: (A.template.logoElements || []).length,
        sel: A.selectedEls.length,
        pickValue: pick ? pick.value : '(无元素)',
        puzzleEnabled: !!A.template.puzzle.enabled,
        hasCaption: !!A.template.puzzle.captions[0],
    };
})()
`;

const READ = `(() => {
    const A = window.App, pk = A.template.puzzle || {};
    return {
        logos: (A.template.logoElements || []).length,
        sel: A.selectedEls.length,
        caption0: (pk.captions && pk.captions[0]) || null,
        status: String(A.statusMsg || ''),
    };
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
        webPreferences: { preload: path.join(__dirname, 'preload-measure.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.webContents.on('console-message', (_e, l, m) => { const s = String(m); if (l >= 2 && !/willReadFrequently/.test(s)) console.log('  [renderer] ' + s.slice(0, 180)); });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas)')) break;
        await new Promise(r => setTimeout(r, 250));
    }

    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    const press = async (key, code, vk) => {
        await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
        await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
        await new Promise(r => setTimeout(r, 500));
    };

    const fails = [];
    const line = (ok, label, got, expect) => {
        console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
        console.log(`       ${got}${expect ? '   期望: ' + expect : ''}`);
        if (!ok) fails.push(label);
    };

    console.log('快捷键 Delete 删除优先级(CDP 真实按键)');
    console.log('─'.repeat(90));

    // ① 无拼图 → 删元素(最常见场景)
    let s = await win.webContents.executeJavaScript(setup({ puzzleEnabled: false, hasCaption: false }));
    let a = await win.webContents.executeJavaScript(READ);
    await press('Delete', 'Delete', 46);
    a = await win.webContents.executeJavaScript(READ);
    line(s.logos === 1 && a.logos === 0 && a.sel === 0, '① 拼图未启用 → Delete 删元素',
        `logo ${s.logos}→${a.logos}  选中 ${s.sel}→${a.sel}  状态「${a.status}」`, 'logo=0 选中=0');

    // ② 拼图启用且该槽位无字幕 → 仍应删元素
    s = await win.webContents.executeJavaScript(setup({ puzzleEnabled: true, hasCaption: false }));
    await press('Delete', 'Delete', 46);
    a = await win.webContents.executeJavaScript(READ);
    line(s.logos === 1 && a.logos === 0, '② 拼图启用但该槽位无字幕 → 删元素',
        `logo ${s.logos}→${a.logos}  pick.value=${s.pickValue}  状态「${a.status}」`, 'logo=0');

    // ③ 拼图启用且该槽位有字幕 → 删字幕,元素保留
    s = await win.webContents.executeJavaScript(setup({ puzzleEnabled: true, hasCaption: true }));
    await press('Delete', 'Delete', 46);
    a = await win.webContents.executeJavaScript(READ);
    line(s.logos === 1 && a.logos === 1 && !a.caption0, '③ 拼图启用且槽位有字幕 → 删字幕',
        `logo ${s.logos}→${a.logos}  字幕 ${JSON.stringify(s.hasCaption)}→${JSON.stringify(a.caption0)}  状态「${a.status}」`,
        'logo=1 字幕=null');

    // ④ Backspace 同理
    s = await win.webContents.executeJavaScript(setup({ puzzleEnabled: false, hasCaption: false }));
    await press('Backspace', 'Backspace', 8);
    a = await win.webContents.executeJavaScript(READ);
    line(s.logos === 1 && a.logos === 0, '④ Backspace 同样删元素',
        `logo ${s.logos}→${a.logos}  状态「${a.status}」`, 'logo=0');

    // ⑤ 焦点在文本输入框时不应触发删除
    s = await win.webContents.executeJavaScript(setup({ puzzleEnabled: false, hasCaption: false }));
    await win.webContents.executeJavaScript(`(() => {
        const i = document.createElement('input'); i.type = 'text'; i.id = '__probeInput';
        i.style.position = 'fixed'; i.style.left = '10px'; i.style.top = '10px';
        document.body.appendChild(i); i.focus();
        return document.activeElement.id;
    })()`);
    await press('Delete', 'Delete', 46);
    a = await win.webContents.executeJavaScript(READ);
    line(a.logos === 1, '⑤ 输入框聚焦时 Delete 不删元素',
        `logo ${s.logos}→${a.logos}`, 'logo=1 保持不变');

    console.log('─'.repeat(90));
    console.log(fails.length ? `✖ ${fails.length} 项未通过: ${fails.join('、')}` : `✓ 全部 5 项通过`);
    dbg.detach();
    finish(fails.length ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });
