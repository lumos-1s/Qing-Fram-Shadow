// 设置弹窗回归：默认导出位置的回显 / 选择 / 清除，以及「关于」瘦身后设置项的搬迁。
// 用法: node tools/run-electron.js tools/test-settings-ui.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const failures = [];
const check = (ok, label, extra) => {
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (extra ? ' | ' + extra : ''));
    if (!ok) failures.push(label + (extra ? ': ' + extra : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

// 主进程侧可变的 prefs：设置页读到什么由这里决定，等价于用户改过设置
let prefsStub = {};
let savedPrefs = [];
let pickFail = false;
ipcMain.handle('get-prefs', () => prefsStub);
ipcMain.handle('save-prefs', (_e, p) => {
    savedPrefs.push(p);
    // 与主进程 saveState 一致：按字段合并，undefined 不覆盖
    if (p && typeof p === 'object') {
        const next = Object.assign({}, prefsStub);
        for (const [k, v] of Object.entries(p)) if (v !== undefined) next[k] = v;
        prefsStub = next;
    }
    return { ok: true };
});
ipcMain.handle('pick-default-export-dir', () => {
    // 模拟「主进程还是旧版」：Electron 会以 invoke 失败的形式抛回来
    if (pickFail) throw new Error("Error invoking remote method 'pick-default-export-dir': Error: No handler registered for 'pick-default-export-dir'");
    prefsStub = { defaultExportDir: 'E:\\导出' };
    return { ok: true, dir: 'E:\\导出' };
});
ipcMain.handle('list-presets', () => []);
ipcMain.handle('load-preset', () => null);
ipcMain.handle('list-logos', () => []);
ipcMain.handle('list-textures', () => []);
ipcMain.handle('list-templates', () => []);
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.23', electron: '31', chrome: '126', node: '20',
    platform: 'win32', arch: 'x64', packaged: true, portable: false,
    userData: process.env.TEMP, appPath: ROOT
}));
ipcMain.handle('open-external', () => ({ ok: true }));
ipcMain.handle('open-data-dir', () => ({ ok: true }));
ipcMain.handle('copy-text', () => ({ ok: true }));
ipcMain.handle('save-diagnostics', () => ({ ok: true, path: 'x' }));
ipcMain.handle('check-for-updates', () => ({ ok: true }));
ipcMain.handle('start-update-download', () => ({ ok: true }));
ipcMain.handle('quit-and-install', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template',
    'export-qfs', 'save-user', 'logout-user', 'read-exif', 'save-image-base64', 'save-images-batch',
    'pick-export-location', 'write-export-files']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try {
            const u = new URL(req.url);
            const p = u.searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (e) { return new Response('NF', { status: 404 }); }
    });

    const win = new BrowserWindow({
        width: 1400, height: 900, show: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload-about.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom)')) break;
        await sleep(250);
    }
    const exec = (expr) => win.webContents.executeJavaScript(expr);

    // ── A：结构 —— 设置项在设置弹窗里；关于已并入设置,不再有独立的关于弹窗 ──
    const sA = await exec(`(() => {
        const inSettings = !!document.querySelector('#settingsModal #tfUpdateMirror');
        const inAbout = !!document.querySelector('#aboutModal #tfUpdateMirror');
        const hasGear = !!document.getElementById('btnSettings');
        const hasAboutModal = !!document.getElementById('aboutModal');
        const aboutInSettings = !!document.querySelector('#settingsModal #aboutSec');
        return { inSettings, inAbout, hasGear, hasAboutModal, aboutInSettings };
    })()`);
    check(sA.hasGear, '工具栏有「设置」按钮', JSON.stringify(sA));
    check(sA.inSettings && !sA.inAbout,
        '更新下载源在「设置」里（同一 ID 只存在一份）', JSON.stringify(sA));
    check(!sA.hasAboutModal && sA.aboutInSettings,
        '关于已并入设置：无独立关于弹窗，设置里有「关于」区', JSON.stringify(sA));

    // ── A2：预览画质开关（标准 1800 / 原图 1:1）──
    const sA2 = await exec(`(() => {
        const b = document.getElementById('btnPreviewQualityToggle');
        return { has: !!b, label: b ? b.textContent : '' };
    })()`);
    check(sA2.has && sA2.label.includes('标准'),
        '设置里有「预览画质」开关且默认为标准', JSON.stringify(sA2));
    await exec(`window.App.applyPreviewQuality(true)`);
    const fullMax = await exec(`window.App.displayMax`);
    check(typeof fullMax === 'number' && fullMax > 1800,
        '开启「原图 1:1」后预览上限高于默认 1800', String(fullMax));
    await exec(`window.App.applyPreviewQuality(false)`);
    const stdMax = await exec(`window.App.displayMax`);
    check(stdMax === undefined || stdMax === null,
        '切回「标准」后回落默认（displayMax 未设置）', String(stdMax));

    // ── A3：更新下载源下拉（预设镜像 / 直连 / 自定义）──
    // 只测纯同步函数 _syncMirrorSelect，不碰 setUpdateMirror 的 IPC（那需要主进程桩）。
    const sA3 = await exec(`(() => {
        const sel = document.getElementById('selUpdateMirror');
        const tf = document.getElementById('tfUpdateMirror');
        if (!sel || !tf) return { has: false };
        const vals = [...sel.options].map(o => o.value);
        window.App._syncMirrorSelect('https://ghfast.top/{url}');
        const hitPreset = sel.value;
        window.App._syncMirrorSelect('https://my-proxy.example/{url}');
        const hitCustom = sel.value;
        window.App._syncMirrorSelect('');
        const hitDirect = sel.value;
        return { has: true, vals, hitPreset, hitCustom, hitDirect };
    })()`);
    check(sA3.has && sA3.vals.includes('') && sA3.vals.includes('__custom__')
        && sA3.vals.filter(v => v && v !== '__custom__').length >= 3,
        '更新下载源有下拉：含「直连」「自定义」与至少 3 个预设镜像', JSON.stringify(sA3.vals));
    check(sA3.hitPreset === 'https://ghfast.top/{url}',
        '已存地址命中预设时下拉选中该预设', sA3.hitPreset);
    check(sA3.hitCustom === '__custom__' && sA3.hitDirect === '',
        '未识别的地址落到「自定义」，空值回到「直连」',
        JSON.stringify({ c: sA3.hitCustom, d: sA3.hitDirect }));

    // ── A4：关于 →「更新内容」：按钮 / 弹窗 / 未读红点 / Esc 逐层关闭 ──
    await exec(`window.App.refreshAboutInfo()`);
    await sleep(80);
    const sA4a = await exec(`(() => {
        const btn = document.getElementById('btnAboutChangelog');
        const dot = document.getElementById('aboutChangelogDot');
        const modal = document.getElementById('changelogModal');
        return {
            hasBtn: !!btn && btn.textContent.indexOf('更新内容') >= 0,
            inSettings: !!document.querySelector('#settingsModal #btnAboutChangelog'),
            dotShown: !!dot && !dot.hidden,
            modalHidden: !!modal && modal.style.display === 'none',
            count: (window.QF_CHANGELOG || []).length
        };
    })()`);
    check(sA4a.hasBtn && sA4a.inSettings, '设置「关于」区有「更新内容」按钮', JSON.stringify(sA4a));
    check(sA4a.modalHidden, '更新内容弹窗默认关闭', JSON.stringify(sA4a));
    check(sA4a.count >= 1, '内置了至少一条版本更新说明', String(sA4a.count));
    check(sA4a.dotShown, '没读过的版本在按钮上亮未读红点', JSON.stringify(sA4a));

    const sA4b = await exec(`(() => {
        window.App.openChangelog();
        const modal = document.getElementById('changelogModal');
        const entries = [...document.querySelectorAll('#changelogList .changelog-entry')];
        const cur = entries.find(e => e.querySelector('.changelog-tag'));
        return {
            open: modal.style.display,
            head: document.getElementById('changelogHead').textContent,
            ver: (window.App._aboutInfo && window.App._aboutInfo.version) || '',
            count: entries.length,
            curOpen: !!cur && cur.open,
            curLen: cur ? cur.textContent.length : 0,
            groups: cur ? [...cur.querySelectorAll('.changelog-group-title')].map(n => n.textContent) : [],
            injected: document.getElementById('changelogList').querySelectorAll('script,img,iframe').length
        };
    })()`);
    await sleep(120);
    check(sA4b.open === 'flex', '点「更新内容」打开弹窗', JSON.stringify(sA4b));
    // 版本断言一律取「运行版本」，不写死号——否则每次发版都要改测试
    check(!!sA4b.ver && sA4b.head.indexOf('v' + sA4b.ver) >= 0,
        '弹窗标题带上当前版本号', sA4b.head);
    check(sA4b.curOpen && sA4b.curLen > 200 && sA4b.groups.length >= 2,
        '当前版本那一条默认展开且有内容', JSON.stringify({ o: sA4b.curOpen, n: sA4b.curLen, g: sA4b.groups }));
    check(sA4b.injected === 0, '更新说明是纯文本渲染（不注入 HTML）', String(sA4b.injected));
    check(savedPrefs.some((p) => p && p.changelogSeen === sA4b.ver),
        '看过即记住版本号（prefs.changelogSeen）', JSON.stringify(savedPrefs.slice(-2)));

    await exec(`window.App.openSettings()`);
    await sleep(80);
    await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    await sleep(120);
    const sA4c = await exec(`(() => ({
        cl: document.getElementById('changelogModal').style.display,
        sm: document.getElementById('settingsModal').style.display,
        dotHidden: document.getElementById('aboutChangelogDot').hidden
    }))()`);
    check(sA4c.cl === 'none' && sA4c.sm !== 'none',
        'Esc 逐层关闭：先收「更新内容」，设置弹窗仍开着', JSON.stringify(sA4c));
    check(sA4c.dotHidden === true, '读过后按钮上的红点消失', JSON.stringify(sA4c));

    // 运行版本早于内置最新说明时：说明是「未来版本」的，不该拿去打扰用户
    const sA4d = await exec(`(() => {
        const cur = (window.App._aboutInfo || {}).version || '';
        window.App._aboutInfo = { version: '0.1.21' };
        window.App._changelogSeen = '';
        window.App.syncChangelogDot();
        const oldHidden = document.getElementById('aboutChangelogDot').hidden;
        window.App._aboutInfo = { version: cur };
        window.App._changelogSeen = cur;
        window.App.syncChangelogDot();
        return { oldHidden };
    })()`);
    check(sA4d.oldHidden === true,
        '运行的是旧版本时不拿未来版本的说明打扰用户', JSON.stringify(sA4d));
    await exec(`window.App.closeSettings()`);
    await sleep(80);

    // ── A5：自动检查更新（每次启动 / 每天一次 / 从不）──
    const sA5a = await exec(`(() => {
        const sel = document.getElementById('selAutoCheck');
        return {
            has: !!sel,
            inUpdateSec: !!document.querySelector('.settings-sec #selAutoCheck'),
            vals: sel ? [...sel.options].map(o => o.value) : [],
            val: sel ? sel.value : ''
        };
    })()`);
    check(sA5a.has && sA5a.inUpdateSec, '设置「更新」区有自动检查更新下拉', JSON.stringify(sA5a));
    check(JSON.stringify(sA5a.vals) === JSON.stringify(['startup', 'daily', 'off']),
        '三档：每次启动 / 每天一次 / 从不', JSON.stringify(sA5a.vals));
    check(sA5a.val === 'startup', '默认是「每次启动」（老用户升级后行为不变）', sA5a.val);

    await exec(`(() => {
        const sel = document.getElementById('selAutoCheck');
        sel.value = 'off';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(120);
    const sA5b = await exec(`document.getElementById('selAutoCheck').value`);
    check(savedPrefs.some((p) => p && p.autoCheck === 'off'),
        '改了就保存（选中即生效，不用再点保存）', JSON.stringify(savedPrefs.slice(-2)));
    check(sA5b === 'off', '下拉保持所选档位', sA5b);
    // 已存的档位要能回显：prefs 现在已被主进程桩合并成 autoCheck='off',重新读一次应同步到下拉
    await exec(`window.App.loadPrefs()`);
    await sleep(120);
    const sA5c = await exec(`document.getElementById('selAutoCheck').value`);
    check(sA5c === 'off', '重读偏好后回显已存档位', sA5c);
    await exec(`(() => {
        const sel = document.getElementById('selAutoCheck');
        sel.value = 'startup';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);

    // ── B：未设置时显示「每次询问」，清除按钮禁用 ──
    await exec(`window.App.openSettings()`);
    await sleep(80);
    const sB = await exec(`(() => {
        const p = document.getElementById('setExportDirPath');
        return {
            open: document.getElementById('settingsModal').style.display,
            text: p.textContent,
            muted: p.classList.contains('muted'),
            clearDisabled: document.getElementById('btnClearExportDir').disabled
        };
    })()`);
    check(sB.open === 'flex', '设置弹窗可打开', JSON.stringify(sB));
    check(sB.text === '每次询问' && sB.muted, '未设置时显示「每次询问」', JSON.stringify(sB));
    check(sB.clearDisabled === true, '未设置时「改回每次询问」不可点', JSON.stringify(sB));

    // ── C：Esc 关闭并把焦点还给齿轮按钮 ──
    await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    await sleep(120);
    const sC = await exec(`({ display: document.getElementById('settingsModal').style.display, focus: document.activeElement && document.activeElement.id })`);
    check(sC.display === 'none' && sC.focus === 'btnSettings', 'Esc 关闭并恢复焦点到设置按钮', JSON.stringify(sC));

    // ── D：已设置时回显真实路径，清除按钮可用 ──
    prefsStub = { defaultExportDir: 'D:' + path.sep + 'Photos' };
    await exec(`window.App.openSettings()`);
    await sleep(80);
    const sD = await exec(`(() => {
        const p = document.getElementById('setExportDirPath');
        return { text: p.textContent, muted: p.classList.contains('muted'),
            clearDisabled: document.getElementById('btnClearExportDir').disabled };
    })()`);
    check(sD.text === prefsStub.defaultExportDir && !sD.muted,
        '已设置时回显默认导出路径', JSON.stringify(sD));
    check(sD.clearDisabled === false, '已设置时「改回每次询问」可点', JSON.stringify(sD));

    // ── E：选择文件夹后立即回显 ──
    await exec(`window.App.chooseDefaultExportDir()`);
    await sleep(120);
    const sE = await exec(`document.getElementById('setExportDirPath').textContent`);
    check(sE === 'E:' + path.sep + '导出', '选择文件夹后立即回显新路径', sE);

    // ── F：清除 → 写回空串，面板回到「每次询问」 ──
    savedPrefs = [];
    await exec(`window.App.clearDefaultExportDir()`);
    await sleep(120);
    const sF = await exec(`(() => {
        const p = document.getElementById('setExportDirPath');
        return { text: p.textContent, muted: p.classList.contains('muted'),
            clearDisabled: document.getElementById('btnClearExportDir').disabled };
    })()`);
    check(savedPrefs.some(p => p && p.defaultExportDir === ''),
        '清除时把默认导出位置写成空串（回落到每次询问）', JSON.stringify(savedPrefs));
    check(sF.text === '每次询问' && sF.muted && sF.clearDisabled === true,
        '清除后面板回到「每次询问」', JSON.stringify(sF));

    // ── G：主进程缺少新接口时不能说「没反应」，要给出可操作的提示 ──
    // 复现用户现场：旧 electron.exe 还活着（主进程旧），页面却是新的
    pickFail = true;
    await exec(`window.App.chooseDefaultExportDir()`);
    await sleep(100);
    const sG = await exec(`({
        msg: window.App.statusMsg || '',
        path: document.getElementById('setExportDirPath').textContent
    })`);
    // 文案是「请完全退出应用再重新启动」：断言认「重新启动 / 重启」两种写法，别把好文案判成失败
    check(/重新?启动|重启应用/.test(sG.msg),
        '接口不可用时提示「重启应用」而不是静默', JSON.stringify(sG));
    check(sG.path === '每次询问',
        '接口不可用时不会把已有设置改坏', JSON.stringify(sG));
    pickFail = false;

    if (failures.length) {
        console.error('\n设置页检查失败: ' + failures.length);
        failures.forEach(f => console.error(' - ' + f));
        app.exit(1);
    } else {
        console.log('\n设置页检查全部通过');
        app.exit(0);
    }
}).catch((e) => {
    console.error((e && e.stack) || e);
    app.exit(2);
});
