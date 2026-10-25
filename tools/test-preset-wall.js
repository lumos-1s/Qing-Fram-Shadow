// 预设墙启动主页回归：启动默认显示墙、87 张卡片渲染、点击进编辑（sidebar 隐藏）、返回墙、跳过入口。
// 用法：node tools/run-electron.js tools/test-preset-wall.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── IPC mock：让渲染进程的 presets.js 能读到 shared/presets ──
ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR).filter(name => name.endsWith('.json')));
ipcMain.handle('load-preset', (_event, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name), 'utf8')); } catch (_) { return null; }
});
const EMPTY_LIST = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });
for (const channel of ['list-logos', 'list-textures', 'list-templates']) ipcMain.handle(channel, EMPTY_LIST);
for (const channel of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install']) ipcMain.handle(channel, OK);
for (const channel of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files',
    'read-exif']) ipcMain.handle(channel, CANCEL);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({ version: '0.1.20', electron: '31', chrome: '126', node: '20',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT }));
const failures = [];

function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

async function main() {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        show: false,
        paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(400);
    win.showInactive();
    const exec = (expr) => win.webContents.executeJavaScript(expr);
    await exec(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(1600);

    const setup = await exec(`(async () => {
      try {
        const App = window.App;
        if (!App) return { error: 'App 未加载' };
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 80 && (!App.presets || App.presets.length < 4); i++) await wait(100);
        for (let i = 0; i < 80 && !document.getElementById('presetWallGrid').childElementCount; i++) await wait(100);
        return { ok: true, presets: App.presets.length, tiles: document.getElementById('presetWallGrid').childElementCount };
      } catch (e) { return { error: String(e) }; }
    })()`);
    check(setup.ok, 'App 与预设墙就绪', setup.error || `presets=${setup.presets} tiles=${setup.tiles}`);

    // 1. 启动默认显示预设墙（hidden=false）
    const wallVisible = await exec(`(() => {
        const w = document.getElementById('presetWall');
        return !!(w && !w.hidden && w.getClientRects().length > 0);
    })()`);
    check(wallVisible, '启动默认显示预设墙');

    // 2. 87 张卡片渲染 + 每张有封面图
    const tiles = await exec(`(() => {
        const g = document.getElementById('presetWallGrid');
        const list = Array.from(g.children);
        return {
            count: list.length,
            noCover: list.filter(t => !t.querySelector('.pw-tile-cover img')).length,
            noName: list.filter(t => !t.querySelector('.pw-tile-name') || !t.querySelector('.pw-tile-name').textContent).length,
            sub: (document.getElementById('pwSub') || {}).textContent || ''
        };
    })()`);
    check(tiles.count === 87, '预设墙渲染 87 张卡片', `count=${tiles.count}`);
    check(tiles.noCover === 0, '每张卡片都有封面图', `noCover=${tiles.noCover}`);
    check(tiles.noName === 0, '每张卡片都有名称', `noName=${tiles.noName}`);

    // 2.5 方向键移动选中（folia 式选中框）
    const kb = await exec(`(async () => {
      const g = document.getElementById('presetWallGrid');
      const first = g.querySelector('.pw-tile');
      first.focus();
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 50));
      const selCount = g.querySelectorAll('.pw-tile.selected').length;
      const selIdx = Array.from(g.children).findIndex(t => t.classList.contains('selected'));
      const firstTop = first.getBoundingClientRect().top;
      const selTop = selIdx >= 0 ? g.children[selIdx].getBoundingClientRect().top : -1;
      return { selCount, selIdx, sameRow: selTop >= 0 && Math.abs(selTop - firstTop) < 4 };
    })()`);
    check(kb.selCount === 1, '方向键移动出现选中框', `selected=${kb.selCount}`);
    check(kb.sameRow, '方向键右移选中同行下一张', `idx=${kb.selIdx}`);

    const kb2 = await exec(`(async () => {
      const g = document.getElementById('presetWallGrid');
      const first = g.querySelector('.pw-tile');
      first.focus();
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 50));
      const selIdx = Array.from(g.children).findIndex(t => t.classList.contains('selected'));
      const firstTop = first.getBoundingClientRect().top;
      const selTop = selIdx >= 0 ? g.children[selIdx].getBoundingClientRect().top : -1;
      return { selIdx, sameRow: selTop >= 0 && Math.abs(selTop - firstTop) < 4 };
    })()`);
    check(kb2.sameRow, '方向键左移选中上一张', `idx=${kb2.selIdx}`);

    // 2.6 横向焦点墙：卡片横排溢出 + 中间卡片最显眼 + 拖动平移
    const wall = await exec(`(async () => {
      const g = document.getElementById('presetWallGrid');
      const tiles = Array.from(g.children);
      const t0 = tiles[0], tn = tiles[tiles.length - 1];
      const first = t0.getBoundingClientRect();
      const last = tn.getBoundingClientRect();
      const overflows = last.right > g.getBoundingClientRect().right + 200; // 末卡右缘远在视口外
      // 中间卡片（视口中心附近）scale 最大（inline transform 由 JS focusWall 写入）
      const sc = (t) => { const ts = t.style.transform; const p = ts.indexOf('scale('); return p >= 0 ? parseFloat(ts.slice(p + 6)) : 1; };
      let maxIdx = 0, maxS = 0;
      tiles.forEach((t, i) => { const v = sc(t); if (v > maxS) { maxS = v; maxIdx = i; } });
      const centerIdx = Math.round((g.clientWidth / 2 - 28) / (t0.offsetWidth + 24));
      const centerVisible = Math.abs(maxIdx - centerIdx) <= 2;
      // 模拟按住拖动：pointerdown → pointermove → 末卡应进入视口
      const r = g.getBoundingClientRect();
      g.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: r.left + 600, bubbles: true }));
      g.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: r.left + 600 - 6000, bubbles: true }));
      g.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
      await new Promise((x) => setTimeout(x, 120));
      const mt = g.style.transform.match(/-?[\\d.]+/);
      const movedLeft = mt ? parseFloat(mt[0]) : 0;
      const lastVisible = tn.getBoundingClientRect().left < g.getBoundingClientRect().right;
      return { overflows, maxIdx, centerIdx, centerVisible, movedLeft, lastVisible, tiles: tiles.length };
    })()`);
    check(wall.overflows, '卡片横向排开溢出屏幕', `lastRight>viewport`);
    check(wall.centerVisible, '最中间的图片最显眼', `maxIdx=${wall.maxIdx} centerIdx=${wall.centerIdx}`);
    check(wall.movedLeft < -2000, '按住拖动后整墙跟随鼠标平移', `offsetX=${wall.movedLeft}`);

    // 3. 点击第一张卡片 → 进入编辑：墙隐藏、body.editing、sidebar 隐藏、模板已应用
    const enter = await exec(`(async () => {
      const App = window.App;
      const tile = document.querySelector('#presetWallGrid .pw-tile');
      const expectName = tile.querySelector('.pw-tile-name').textContent;
      tile.click();
      await new Promise((r) => setTimeout(r, 400));
      const w = document.getElementById('presetWall');
      const side = document.getElementById('sidebar');
      const cs = side ? getComputedStyle(side) : null;
      return {
        expectName,
        wallHidden: !!(w && w.hidden),
        editing: document.body.classList.contains('editing'),
        sidebarHidden: !!(cs && cs.display === 'none'),
        tplName: (App.template && (App.template.templateName || '')) || ''
      };
    })()`);
    check(enter.wallHidden, '点击卡片后预设墙隐藏');
    check(enter.editing, '进入编辑模式 body.editing');
    check(enter.sidebarHidden, '编辑模式左侧预设树隐藏');
    check(enter.tplName === enter.expectName, '模板已应用为所选预设', `${enter.tplName} vs ${enter.expectName}`);

    // 4. 工具栏「预设墙」按钮 → 返回墙
    const back = await exec(`(async () => {
      const btn = document.getElementById('btnBackWall');
      const visible = !!(btn && btn.offsetParent);
      btn.click();
      await new Promise((r) => setTimeout(r, 200));
      const w = document.getElementById('presetWall');
      return {
        btnVisible: visible,
        wallShown: !!(w && !w.hidden && w.getClientRects().length > 0),
        editing: document.body.classList.contains('editing')
      };
    })()`);
    check(back.btnVisible, '编辑模式工具栏显示「预设墙」按钮');
    check(back.wallShown, '点击后返回预设墙');
    check(!back.editing, '返回后移除 body.editing');

    // 5. 跳过入口：pwSkip → 进工作台（不应用新模板、sidebar 隐藏）
    const skip = await exec(`(async () => {
      const tplBefore = window.App.template ? (window.App.template.templateName || '') : '';
      document.getElementById('pwSkip').click();
      await new Promise((r) => setTimeout(r, 200));
      const w = document.getElementById('presetWall');
      return {
        wallHidden: !!(w && w.hidden),
        editing: document.body.classList.contains('editing'),
        tplBefore,
        tplAfter: window.App.template ? (window.App.template.templateName || '') : ''
      };
    })()`);
    check(skip.wallHidden, '「进入工作台」隐藏预设墙');
    check(skip.editing, '进入工作台后 body.editing');
    check(skip.tplAfter === skip.tplBefore, '跳过不改变当前模板', `${skip.tplBefore} → ${skip.tplAfter}`);

    console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL PASS');
    app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(main).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
});
