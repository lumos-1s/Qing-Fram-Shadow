// 验证引导提示:空池时显示,有图标时隐藏
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
// 默认返回空池(模拟发行版)
let LOGOS = [];
ipcMain.handle('list-logos', () => LOGOS);
ipcMain.handle('list-textures', () => []);
ipcMain.handle('list-templates', () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}

const PROBE = `
() => {
    const h = document.getElementById('logoPoolHint');
    const vis = (el) => {
        if (!el) return 'missing';
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return cs.display + '/' + Math.round(r.height) + 'px';
    };
    return {
        hint: vis(h),
        hintText: h ? h.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60) : '',
        poolCount: (window.App.logos || []).length,
        brandBox: vis(document.getElementById('brandIconBox')),
        addBtn: vis(document.getElementById('btnAddCustomIcon')),
    };
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
    win.webContents.on('console-message', (_e, l, m) => { const s = String(m); if (l >= 2 && !/willReadFrequently/.test(s)) console.log('  [renderer] ' + s.slice(0, 200)); });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas && window.App.presets)')) break;
        await new Promise(r => setTimeout(r, 250));
    }
    await win.webContents.executeJavaScript("window.App.switchTab('logo')");
    await new Promise(r => setTimeout(r, 300));

    let fail = 0;
    console.log('引导提示验证');
    console.log('─'.repeat(72));

    // ① 空池
    const a = await win.webContents.executeJavaScript(`(${PROBE})()`);
    console.log(`  ① 空池(模拟发行版)`);
    console.log(`     池内图标=${a.poolCount}  提示=${a.hint}  品牌池=${a.brandBox}  添加按钮=${a.addBtn}`);
    console.log(`     提示文字: ${a.hintText}...`);
    if (a.hint.startsWith('none')) { console.log('     FAIL 空池时提示应显示'); fail++; } else console.log('     OK   提示已显示');

    // ② 注入一个图标后刷新池 → 提示应隐藏
    const r = await win.webContents.executeJavaScript(`(() => {
        const c = document.createElement('canvas'); c.width = 100; c.height = 40;
        const g = c.getContext('2d'); g.fillStyle = '#e8442a'; g.fillRect(0,0,100,40);
        window.App.logos = [{ name: 'Canon.png', dataUrl: c.toDataURL('image/png'), custom: true }];
        window.App.renderLogoPools();
        const h = document.getElementById('logoPoolHint');
        const bx = document.getElementById('customIconBox');
        return {
            hint: getComputedStyle(h).display,
            customBox: getComputedStyle(bx).display,
            cells: bx.querySelectorAll('.icon-cell').length,
        };
    })()`);
    console.log(`  ② 导入 1 个图标后`);
    console.log(`     提示=${r.hint}  自定义池=${r.customBox}  格子数=${r.cells}`);
    if (r.hint !== 'none') { console.log('     FAIL 有图标时提示应隐藏'); fail++; } else console.log('     OK   提示已隐藏');
    if (r.cells !== 1) { console.log('     FAIL 图标未渲染进池'); fail++; } else console.log('     OK   图标已渲染');

    // ③ 再清空 → 提示应回来
    const r2 = await win.webContents.executeJavaScript(`(() => {
        window.App.logos = [];
        window.App.renderLogoPools();
        return getComputedStyle(document.getElementById('logoPoolHint')).display;
    })()`);
    console.log(`  ③ 清空图标后 提示=${r2}`);
    if (r2 === 'none') { console.log('     FAIL 清空后提示应回来'); fail++; } else console.log('     OK   提示已恢复');

    console.log('─'.repeat(72));
    console.log(fail ? `✖ ${fail} 项异常` : '✓ 全部通过');
    finish(fail ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });
