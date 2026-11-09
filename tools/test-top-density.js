// 顶栏维持原状 + 左侧预设树收拢回归。
// 顶栏的「⋯」收拢版已按用户要求撤回，这里把恢复后的形态冻结成断言。
// 用法：node tools/run-electron.js tools/test-top-density.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR)
    .filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name + '.json'), 'utf8')); }
    catch (_) { return null; }
});
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(c, () => []);
for (const c of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'copy-text', 'save-diagnostics',
    'check-for-updates', 'quit-and-install', 'open-external', 'open-data-dir',
    'save-image-base64', 'save-images-batch', 'load-acr-tables', 'load-acr-shadows']) {
    ipcMain.handle(c, () => ({ ok: true }));
}
for (const c of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'pick-export-location', 'write-export-files', 'read-exif', 'open-image']) {
    ipcMain.handle(c, () => ({ canceled: true }));
}
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.25', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT
}));

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(label);
}

const PROBE = `(async () => {
    const A = window.App;
    const $ = (id) => document.getElementById(id);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!A) return { missing: true };
    await A.loadPresets();
    try {
        localStorage.removeItem('qfs_preset_groups');
        localStorage.removeItem('qfs_side_mode');
    } catch (_) {}
    A.setSideMode('border');
    A.buildTree('');
    await wait(120);

    // ── 1. 顶栏恢复原样：13 个入口常驻，没有 ⋯ 弹出菜单 ──
    // 用户看过收拢版后选择恢复，这里把「原样」写成断言，免得以后又被顺手收走。
    const allBtns = Array.prototype.slice.call(document.querySelectorAll('#toolbar button'));
    const visible = allBtns.filter((b) => b.offsetParent !== null);
    const labels = visible.map((b) => (b.textContent || '').trim()).filter(Boolean);
    const barIds = ['btnOpenFolder', 'btnCopy', 'btnSyncSel', 'btnReset', 'btnRandom', 'btnTheme'];
    const allInBar = barIds.every((id) => {
        const el = $(id);
        return !!el && !!el.closest('#toolbar .toolbar-group') && !el.closest('[hidden]');
    });
    const noMore = !$('btnToolbarMore') && !$('toolbarMoreMenu');
    const themeInRight = !!($('btnTheme') && $('btnTheme').closest('.toolbar-group.right'));
    const g = document.querySelector('.toolbar-group');
    const cs = g ? getComputedStyle(g) : null;
    const pillBack = !!cs && cs.backgroundColor !== 'rgba(0, 0, 0, 0)'
        && cs.backgroundColor !== 'transparent' && parseFloat(cs.borderTopWidth) > 0;

    // ── 3. 左侧分组默认展开状态 ──
    const tree = $('presetTree');
    const groups = Array.prototype.slice.call(tree.querySelectorAll('.preset-group'));
    const openNames = groups.filter((x) => x.classList.contains('open'))
        .map((x) => (x.querySelector('.group-name') || {}).textContent || '');
    const visibleItems = () => Array.prototype.slice.call(tree.querySelectorAll('.preset-item'))
        .filter((el) => getComputedStyle(el).display !== 'none').length;
    const defaultVisible = visibleItems();
    const recent = groups.find((x) => /最近使用/.test(x.textContent || ''));
    const recentCollapsed = !!recent && !recent.classList.contains('open');
    const recentCount = recent ? recent.querySelectorAll('.preset-item').length : -1;

    // 手动展开一组 → 写盘 → 重建后仍展开
    const closed = groups.find((x) => !x.classList.contains('open') && x.querySelector('.group-name[draggable]'));
    let persisted = null, rebuiltOpen = null;
    if (closed) {
        // 组头文本以「▸ + emoji + 组名 · 数量」开头，键只要中文组名
        const key = (closed.querySelector('.group-name').textContent || '').trim()
            .split(' · ')[0].replace(/^[^\u4e00-\u9fa5]+/, '');
        closed.querySelector('.group-name').click();
        persisted = key;
        const raw = localStorage.getItem('qfs_preset_groups');
        const st = raw ? JSON.parse(raw) : {};
        persisted = { key, saved: st[key], beforeRebuild: visibleItems() };
        A.buildTree('');
        rebuiltOpen = !!Array.prototype.slice.call(tree.querySelectorAll('.preset-group'))
            .find((x) => x.classList.contains('open') && (x.querySelector('.group-name') || {}).textContent.includes(key));
    }

    // 搜索时强制展开命中组，结果不能藏在折叠里
    A.filterTree('参数');
    const searchOpen = Array.prototype.slice.call(tree.querySelectorAll('.preset-group.open')).length;
    const searchVisible = visibleItems();
    A.filterTree('');
    try { localStorage.removeItem('qfs_preset_groups'); } catch (_) {}

    return {
        labels, allInBar, noMore, themeInRight, pillBack,
        openNames, defaultVisible, recentCollapsed, recentCount,
        persisted, rebuiltOpen, searchOpen, searchVisible, groupCount: groups.length
    };
})()`;

async function main() {
    const win = new BrowserWindow({
        width: 1400, height: 900, show: false, paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true,
            backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await win.webContents.executeJavaScript(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(1200);

    let res = null;
    try { res = await win.webContents.executeJavaScript(PROBE); }
    catch (e) { check(false, '探针执行', String(e && e.message)); }
    if (res) {
        if (res.missing) check(false, '模块已加载', 'App 未定义');
        check(res.labels.length >= 10 && /导入文件夹/.test(res.labels.join(''))
            && /重置/.test(res.labels.join('')) && /随机/.test(res.labels.join('')),
            '顶栏恢复常驻入口（含导入文件夹 / 重置 / 随机）', JSON.stringify(res.labels));
        check(res.allInBar && res.noMore,
            '六个按钮回到工具组，⋯ 溢出菜单已移除',
            JSON.stringify({ inBar: res.allInBar, noMore: res.noMore }));
        check(res.pillBack, '工具组 pill 底色与边框已恢复');
        check(res.themeInRight, '主题按钮回到右侧工具组（设置里那个也仍在）');
        check(res.openNames.filter((n) => !/最近使用|收藏/.test(n)).length <= 1,
            '默认只展开一个常规分组（当前选中项所在组）', JSON.stringify(res.openNames));
        check(res.recentCollapsed && res.recentCount > 0 && res.recentCount <= 4,
            '「最近使用」默认收起且最多 4 项', JSON.stringify({ collapsed: res.recentCollapsed, n: res.recentCount }));
        check(res.defaultVisible > 0 && res.defaultVisible <= 8,
            '默认可见的预设条目不超过 8 行（原来两组同时展开有 12+ 行）', String(res.defaultVisible));
        check(!!res.persisted && res.persisted.saved === true && res.rebuiltOpen === true,
            '手动展开的分组写进 localStorage，重建后仍展开',
            JSON.stringify({ persisted: res.persisted, rebuiltOpen: res.rebuiltOpen }));
        check(res.searchOpen > 0 && res.searchVisible > 0,
            '搜索时命中组强制展开，结果不会被折叠藏住',
            JSON.stringify({ open: res.searchOpen, visible: res.searchVisible }));
    }

    // 静态检查：状态栏引导语别再指错方向
    const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'app.js'), 'utf8');
    check(!/点右上角「导入照片」/.test(appSrc) && /点工具栏左侧「导入照片」/.test(appSrc),
        '示例照片提示改为「工具栏左侧」（按钮本来就在左上）');

    console.log('─'.repeat(72));
    win.destroy();
    if (failures.length) {
        console.log(`FAILURE  ${failures.length} 项未通过`);
        failures.forEach((f) => console.log('  · ' + f));
        app.exit(1);
    } else {
        console.log('ALL PASS');
        app.exit(0);
    }
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
