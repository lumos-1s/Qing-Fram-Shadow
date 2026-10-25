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
        for (let i = 0; i < 80 && !document.getElementById('presetWallGrid').querySelectorAll('.pw-tile').length; i++) await wait(100);
        return { ok: true, presets: App.presets.length, tiles: document.getElementById('presetWallGrid').querySelectorAll('.pw-tile').length };
      } catch (e) { return { error: String(e) }; }
    })()`);
    check(setup.ok, 'App 与预设墙就绪', setup.error || `presets=${setup.presets} tiles=${setup.tiles}`);

    // 1. 启动默认显示预设墙（hidden=false）
    const wallVisible = await exec(`(() => {
        const w = document.getElementById('presetWall');
        return !!(w && !w.hidden && w.getClientRects().length > 0);
    })()`);
    check(wallVisible, '启动默认显示预设墙');

    // 2. 90 格周期网格渲染（87 张预设循环填充）+ 每张有封面图
    const tiles = await exec(`(() => {
        const g = document.getElementById('presetWallGrid');
        const list = Array.from(g.querySelectorAll('.pw-tile'));
        return {
            count: list.length,
            noCover: list.filter(t => !t.querySelector('.pw-tile-cover img')).length,
            noName: list.filter(t => !t.querySelector('.pw-tile-name') || !t.querySelector('.pw-tile-name').textContent).length,
            sub: (document.getElementById('pwSub') || {}).textContent || ''
        };
    })()`);
    check(tiles.count === 90, '周期网格渲染 90 张卡片', `count=${tiles.count}`);
    check(tiles.noCover === 0, '每张卡片都有封面图', `noCover=${tiles.noCover}`);
    check(tiles.noName === 0, '每张卡片都有名称', `noName=${tiles.noName}`);

    // 2.5 方向键移动选中（上下左右，周期内循环）
    const kb = await exec(`(async () => {
      const g = document.getElementById('presetWallGrid');
      const first = g.querySelector('.pw-tile');
      first.focus();
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 50));
      return { selCount: g.querySelectorAll('.pw-tile.selected').length, selC: App._wallSel.c, selR: App._wallSel.r };
    })()`);
    check(kb.selCount === 1, '方向键移动出现选中框', `selected=${kb.selCount}`);
    check(kb.selC === 1 && kb.selR === 0, '方向键右移选中下一格', `c=${kb.selC} r=${kb.selR}`);

    const kb2 = await exec(`(async () => {
      const g = document.getElementById('presetWallGrid');
      const first = g.querySelector('.pw-tile');
      first.focus();
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 50));
      return { selC: App._wallSel.c, selR: App._wallSel.r };
    })()`);
    check(kb2.selC === 0 && kb2.selR === 0, '方向键左移选中上一格', `c=${kb2.selC} r=${kb2.selR}`);

    const kb3 = await exec(`(async () => {
      const g = document.getElementById('presetWallGrid');
      const first = g.querySelector('.pw-tile');
      first.focus();
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 50));
      return { selC: App._wallSel.c, selR: App._wallSel.r };
    })()`);
    check(kb3.selR === 1 && kb3.selC === 0, '方向键下移选中下一行', `r=${kb3.selR} c=${kb3.selC}`);

    // 2.6 无限磁贴墙：周期块覆盖视口 + 中间卡片最显眼 + 拖动平移 + 取模回绕
    const wall = await exec(`(async () => {
      const g = document.getElementById('presetWallGrid');
      const block = g.querySelector('.pw-block');
      const tiles = Array.from(block.querySelectorAll('.pw-tile'));
      const b = App._wallBounds;
      // 无限墙基础：周期块宽高均大于视口（任意偏移下视口内都有卡）
      const covers = !!b && b.BW > g.clientWidth && b.BH > g.clientHeight;
      // 中间卡片（视口中心附近）scale 最大（inline transform 由 JS focusWall 写入）
      const sc = (t) => { const ts = t.style.transform; const p = ts.indexOf('scale('); return p >= 0 ? parseFloat(ts.slice(p + 6)) : 1; };
      let maxT = null, maxS = 0;
      for (const t of tiles) { const v = sc(t); if (v > maxS) { maxS = v; maxT = t; } }
      const vr = g.getBoundingClientRect();
      const tr = maxT.getBoundingClientRect();
      const centerDist = Math.hypot((tr.left + tr.width / 2) - (vr.left + vr.width / 2), (tr.top + tr.height / 2) - (vr.top + vr.height / 2));
      const centerFocus = centerDist < b.tw * 0.9;
      // 模拟按住拖动（横向 + 纵向）：整墙应跟随平移
      const r = g.getBoundingClientRect();
      g.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: r.left + 600, clientY: r.top + 400, bubbles: true }));
      g.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: r.left + 600 - 2000, clientY: r.top + 400 - 1500, bubbles: true }));
      g.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
      await new Promise((x) => setTimeout(x, 120));
      const ox1 = App._wallOffsetX, oy1 = App._wallOffsetY;
      const wallMoved = ox1 < -1000 && oy1 < -1000;
      // 取模回绕：连续拖 4 个周期宽，偏移仍被约束在 [-BW, 0]（墙无尽头）
      g.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: r.left + 600, clientY: r.top + 400, bubbles: true }));
      for (let i = 0; i < 4; i++) {
        g.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: r.left + 600 - (i + 1) * b.BW, clientY: r.top + 400, bubbles: true }));
      }
      g.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
      await new Promise((x) => setTimeout(x, 120));
      const ox2 = App._wallOffsetX;
      const wrapped = ox2 <= 0 && ox2 > -b.BW;
      return { tileCount: tiles.length, covers, maxS, centerDist, centerFocus, ox1, oy1, wallMoved, ox2, wrapped, bw: b.BW, bh: b.BH, vw: g.clientWidth, vh: g.clientHeight };
    })()`);
    check(wall.tileCount === 90, '周期网格渲染 90 张卡片', `count=${wall.tileCount}`);
    check(wall.covers, '周期块覆盖视口（无限墙基础）', `BW=${wall.bw} BH=${wall.bh} vw=${wall.vw} vh=${wall.vh}`);
    check(wall.centerFocus, '最中间的图片最显眼', `scale=${wall.maxS} dist=${Math.round(wall.centerDist)}`);
    check(wall.wallMoved, '按住拖动后整墙跟随鼠标平移', `ox=${wall.ox1} oy=${wall.oy1}`);
    check(wall.wrapped, '拖动超界自动取模回绕（墙无尽头）', `ox2=${wall.ox2} BW=${wall.bw}`);

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
