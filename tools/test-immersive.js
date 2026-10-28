// 沉浸式照片展示回归：入口、墙、详情、键盘、自动隐藏、退出后编辑状态不变。
// 用法：node tools/run-electron.js tools/test-immersive.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
        // 测试图自己画，不依赖 design/ 下可能未提交的示例资产
        const colors = ['#D98E5B', '#7FA8A3', '#4C6B57', '#C7AE82'];
        const srcs = colors.map((color, i) => {
            const c = document.createElement('canvas');
            c.width = 1200;
            c.height = 900 + i * 60;
            const g = c.getContext('2d');
            const grad = g.createLinearGradient(0, 0, c.width, c.height);
            grad.addColorStop(0, color);
            grad.addColorStop(1, '#1B2420');
            g.fillStyle = grad;
            g.fillRect(0, 0, c.width, c.height);
            g.fillStyle = 'rgba(255,255,255,.16)';
            g.beginPath();
            g.arc(c.width * 0.72, c.height * 0.30, 110, 0, Math.PI * 2);
            g.fill();
            g.fillStyle = 'rgba(255,255,255,.24)';
            for (let k = 0; k < 4; k++) g.fillRect(0, c.height * (0.52 + k * 0.1), c.width, 2);
            g.fillStyle = 'rgba(255,255,255,.86)';
            g.font = '700 64px sans-serif';
            g.fillText('PHOTO ' + (i + 1), 70, 110);
            return c.toDataURL('image/png');
        });
        const names = ['海边日落.jpg', '沙丘公路.jpg', '森林晨雾.jpg', '湖边倒影.jpg'];
        const imgs = [];
        for (let i = 0; i < 4; i++) {
            const img = new Image();
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = () => reject(new Error('示例图加载失败: ' + names[i]));
                img.src = srcs[i];
            });
            imgs.push({
                el: img,
                name: names[i],
                w: img.naturalWidth,
                h: img.naturalHeight,
                exif: {},
                thumb: srcs[i],
                customSettings: null
            });
        }
        const picks = [];
        const wanted = ['POLAROID_HAND', 'VINTAGE', 'NEWSPAPER', 'SIMPLE'];
        wanted.forEach((style) => {
            const p = App.presets.find((x) => String(x.photoFrameStyle || '').toUpperCase() === style);
            if (p) picks.push(p);
        });
        if (!picks.length) picks.push(App.presets[0]);
        while (picks.length < imgs.length) picks.push(App.presets[picks.length % App.presets.length]);
        App.images = imgs;
        App.currentIdx = 0;
        App.image = imgs[0];
        App.selectedIdx = [1];
        App.batchSel = [0, 2];
        App.imageTemplates = new Map();
        imgs.forEach((im, i) => {
            const tpl = JSON.parse(JSON.stringify(picks[i] || picks[0]));
            im.customSettings = tpl;
            App.imageTemplates.set(im, tpl);
        });
        App.template = JSON.parse(JSON.stringify(App.imageTemplates.get(imgs[0])));
        App.zoom = 1.37;
        App.panX = 42;
        App.panY = -17;
        App._followFit = false;
        App.selectedEls = [{ kind: 'test', obj: {} }];
        App.buildThumbnails();
        App.updateEmptyState();
        return {
            presets: App.presets.length,
            names: imgs.map((im) => im.name),
            picks: picks.map((p) => p.templateName || p.photoFrameStyle),
            buttonVisible: !document.getElementById('btnImmersive').hidden,
            buttonDisabled: document.getElementById('btnImmersive').disabled,
            zoom: App.zoom, panX: App.panX, panY: App.panY
        };
      } catch (err) {
        return { error: String((err && err.stack) || err) };
      }
    })()`);
    check(!setup.error, '测试数据准备成功', setup.error || 'ok');
    if (setup.error) throw new Error(setup.error);
    check(setup.presets >= 4, '预设已加载', String(setup.presets));
    check(setup.buttonVisible && !setup.buttonDisabled, '有照片时显示沉浸入口', JSON.stringify({ buttonVisible: setup.buttonVisible, buttonDisabled: setup.buttonDisabled }));
    check(setup.zoom === 1.37 && setup.panX === 42 && setup.panY === -17, '测试前编辑状态已就位', JSON.stringify(setup));

    const opened = await exec(`(async () => {
        const App = window.App;
        const btn = document.getElementById('btnImmersive');
        btn.focus();
        btn.click();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const im = App._immersion;
        const overlay = document.getElementById('immersion');
        const currentTiles = [...document.querySelectorAll('#immersionWall .immersion-tile.is-current')];
        const close = document.getElementById('immersionClose');
        return {
            open: !!App._immersionOpen,
            hidden: overlay.hidden,
            appInert: document.getElementById('app').hasAttribute('inert'),
            list: im && im.list.length,
            index: im && im.index,
            count: document.getElementById('immersionCount').textContent,
            no: document.getElementById('immersionNo').textContent,
            file: document.getElementById('immersionFile').textContent,
            preset: document.getElementById('immersionPreset').textContent,
            wallTiles: document.querySelectorAll('#immersionWall .immersion-tile').length,
            currentTiles: currentTiles.length,
            focus: document.activeElement && document.activeElement.id,
            closeVisible: getComputedStyle(close).display !== 'none',
            wide: window.matchMedia('(min-width: 1000px)').matches
        };
    })()`);
    check(opened.open && opened.hidden === false, '沉浸层打开', JSON.stringify(opened));
    check(opened.appInert === true, '打开时主界面 inert');
    check(opened.list === 2 && opened.index === 0, '按勾选顺序展示 2 张', JSON.stringify({ list: opened.list, index: opened.index }));
    check(opened.count === '01 / 02' && opened.no === '01', '序号与总数正确', `${opened.count} / ${opened.no}`);
    check(opened.file === setup.names[0], '文件名正确', opened.file);
    check(opened.preset === setup.picks[0], '边框预设名正确', opened.preset);
    check(opened.wallTiles > 20 && opened.currentTiles > 0, '背景墙铺满且当前照片高亮', JSON.stringify({ wallTiles: opened.wallTiles, currentTiles: opened.currentTiles }));
    check(opened.focus === 'immersionClose', '焦点进入关闭按钮', opened.focus);

    // 等离屏渲染完成：预览层应换成更高分辨率的装框图
    await sleep(1800);
    const rendered = await exec(`(() => {
        const a = document.getElementById('immersionImgA');
        const b = document.getElementById('immersionImgB');
        const front = a.classList.contains('is-front') ? a : b;
        const App = window.App;
        const card = document.getElementById('immersionCard');
        const stage = document.getElementById('immersionStage');
        return {
            src: front.getAttribute('src') || '',
            w: front.naturalWidth,
            h: front.naturalHeight,
            cardW: card.getBoundingClientRect().width,
            stageW: stage.getBoundingClientRect().width,
            stageH: stage.getBoundingClientRect().height,
            overlayW: window.innerWidth,
            loading: document.getElementById('immersionLoading').classList.contains('is-on'),
            zoom: App.zoom,
            panX: App.panX,
            panY: App.panY,
            selected: App.selectedEls.length && App.selectedEls[0].kind
        };
    })()`);
    check(/^data:image\/(webp|jpeg)/.test(rendered.src) && rendered.w > 300 && rendered.h > 300, '中央照片渲染为高分辨率', JSON.stringify({ w: rendered.w, h: rendered.h, src: rendered.src.slice(0, 24) }));
    check(rendered.loading === false, '高分辨率加载状态收起');
    const stageRatio = rendered.stageW / rendered.stageH;
    const imageRatio = rendered.w / rendered.h;
    check(Math.abs(stageRatio - imageRatio) < 0.03 && rendered.cardW < rendered.overlayW * 0.85, '卡片按成片比例收窄', JSON.stringify({ stageRatio, imageRatio, cardW: rendered.cardW, overlayW: rendered.overlayW }));
    check(rendered.zoom === 1.37 && rendered.panX === 42 && rendered.panY === -17 && rendered.selected === 'test', '离屏渲染未污染缩放/平移/选区', JSON.stringify({ zoom: rendered.zoom, panX: rendered.panX, panY: rendered.panY, selected: rendered.selected }));

    const beforeWall = await exec(`(() => {
        const wall = document.getElementById('immersionWall');
        return { x: wall.style.getPropertyValue('--imm-x'), y: wall.style.getPropertyValue('--imm-y') };
    })()`);
    await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); true`);
    await sleep(300);
    const next = await exec(`(() => {
        const App = window.App;
        const wall = document.getElementById('immersionWall');
        const currentTiles = [...document.querySelectorAll('#immersionWall .immersion-tile.is-current')];
        return {
            index: App._immersion.index,
            count: document.getElementById('immersionCount').textContent,
            file: document.getElementById('immersionFile').textContent,
            currentTiles: currentTiles.length,
            x: wall.style.getPropertyValue('--imm-x'),
            y: wall.style.getPropertyValue('--imm-y'),
            zoom: App.zoom,
            panX: App.panX,
            panY: App.panY
        };
    })()`);
    check(next.index === 1 && next.count === '02 / 02', '方向键切换到下一张', JSON.stringify(next));
    check(next.file === setup.names[2], '切换后文件名同步', next.file);
    check(next.currentTiles > 0, '墙上的当前高亮同步');
    check(next.x !== beforeWall.x || next.y !== beforeWall.y, '背景墙随切换滚动', `${beforeWall.x},${beforeWall.y} -> ${next.x},${next.y}`);

    // 滚轮：向下 = 下一张，向上 = 上一张；同时必须吞掉默认滚动
    const wheelUp = await exec(`(async () => {
        const overlay = document.getElementById('immersion');
        const ev = new WheelEvent('wheel', { deltaY: -120, deltaMode: 0, bubbles: true, cancelable: true });
        overlay.dispatchEvent(ev);
        await new Promise((r) => setTimeout(r, 280));
        return {
            index: window.App._immersion.index,
            count: document.getElementById('immersionCount').textContent,
            file: document.getElementById('immersionFile').textContent,
            prevented: ev.defaultPrevented
        };
    })()`);
    check(wheelUp.index === 0 && wheelUp.count === '01 / 02', '滚轮向上切换到上一张', JSON.stringify(wheelUp));
    check(wheelUp.file === setup.names[0], '滚轮向上切换后文件名同步', wheelUp.file);
    check(wheelUp.prevented === true, '滚轮切换阻止背景滚动');

    const wheelDown = await exec(`(async () => {
        const overlay = document.getElementById('immersion');
        const ev = new WheelEvent('wheel', { deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true });
        overlay.dispatchEvent(ev);
        await new Promise((r) => setTimeout(r, 280));
        return {
            index: window.App._immersion.index,
            count: document.getElementById('immersionCount').textContent,
            file: document.getElementById('immersionFile').textContent
        };
    })()`);
    check(wheelDown.index === 1 && wheelDown.count === '02 / 02', '滚轮向下切换到下一张', JSON.stringify(wheelDown));
    check(wheelDown.file === setup.names[2], '滚轮向下切换后文件名同步', wheelDown.file);

    // 触控板惯性会连发小增量：同一手势只切一张，停手后新手势可继续
    const trackpad = await exec(`(async () => {
        const overlay = document.getElementById('immersion');
        const fire = (dy) => overlay.dispatchEvent(new WheelEvent('wheel', {
            deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true
        }));
        for (let i = 0; i < 3; i++) fire(8);
        await new Promise((r) => setTimeout(r, 40));
        const afterStep = window.App._immersion.index;
        for (let i = 0; i < 12; i++) fire(8);
        fire(80); // 惯性峰值：仍应算同一次手势
        await new Promise((r) => setTimeout(r, 40));
        const afterInertia = window.App._immersion.index;
        await new Promise((r) => setTimeout(r, 360));
        for (let i = 0; i < 3; i++) fire(-8);
        await new Promise((r) => setTimeout(r, 40));
        return { afterStep, afterInertia, afterNextGesture: window.App._immersion.index };
    })()`);
    check(trackpad.afterStep === 0 && trackpad.afterInertia === 0, '触控板一次手势只切换一张', JSON.stringify(trackpad));
    check(trackpad.afterNextGesture === 1, '触控板新手势可继续切换', JSON.stringify(trackpad));

    // 自动隐藏：静止 2 秒后隐藏光标/工具层，移动恢复
    await sleep(2800);
    const idle = await exec(`(() => {
        const overlay = document.getElementById('immersion');
        const close = document.getElementById('immersionClose');
        return {
            idle: overlay.classList.contains('is-idle'),
            closeVisibility: getComputedStyle(close).visibility,
            closeOpacity: getComputedStyle(close).opacity
        };
    })()`);
    check(idle.idle === true && idle.closeVisibility === 'hidden', '静止 2 秒自动隐藏工具层', JSON.stringify(idle));

    await exec(`window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 180, clientY: 160 })); true`);
    await sleep(120);
    const wake = await exec(`(() => ({
        idle: document.getElementById('immersion').classList.contains('is-idle'),
        closeVisibility: getComputedStyle(document.getElementById('immersionClose')).visibility
    }))()`);
    check(wake.idle === false && wake.closeVisibility !== 'hidden', '移动鼠标恢复工具层', JSON.stringify(wake));

    await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(250);
    const closed = await exec(`(() => {
        const App = window.App;
        return {
            open: !!App._immersionOpen,
            hidden: document.getElementById('immersion').hidden,
            appInert: document.getElementById('app').hasAttribute('inert'),
            focus: document.activeElement && document.activeElement.id,
            zoom: App.zoom,
            panX: App.panX,
            panY: App.panY,
            selected: App.selectedEls.length && App.selectedEls[0].kind,
            batch: App.batchSel.slice(),
            current: App.currentIdx,
            image: App.image && App.image.name
        };
    })()`);
    check(closed.open === false && closed.hidden === true, 'Esc 退出沉浸层', JSON.stringify(closed));
    check(closed.appInert === false, '退出后主界面恢复可交互');
    check(closed.focus === 'btnImmersive', '焦点回到入口按钮', closed.focus);
    check(closed.zoom === setup.zoom && closed.panX === setup.panX && closed.panY === setup.panY, '退出后缩放/平移原样', JSON.stringify({ zoom: closed.zoom, panX: closed.panX, panY: closed.panY }));
    check(closed.selected === 'test' && closed.batch.join(',') === '0,2' && closed.current === 0 && closed.image === setup.names[0], '退出后选区/当前图原样', JSON.stringify({ selected: closed.selected, batch: closed.batch, current: closed.current, image: closed.image }));

    // 关闭按钮也要能退出（不只 Esc）
    await exec(`document.getElementById('btnImmersive').click(); true`);
    await sleep(350);
    await exec(`document.getElementById('immersionClose').click(); true`);
    await sleep(250);
    const closedByButton = await exec(`(() => ({
        open: !!window.App._immersionOpen,
        hidden: document.getElementById('immersion').hidden,
        inert: document.getElementById('app').hasAttribute('inert'),
        zoom: window.App.zoom,
        panX: window.App.panX,
        panY: window.App.panY
    }))()`);
    check(closedByButton.open === false && closedByButton.hidden === true && closedByButton.inert === false, '关闭按钮退出沉浸层', JSON.stringify(closedByButton));
    check(closedByButton.zoom === setup.zoom && closedByButton.panX === setup.panX && closedByButton.panY === setup.panY, '关闭按钮退出后编辑状态不变', JSON.stringify({ zoom: closedByButton.zoom, panX: closedByButton.panX, panY: closedByButton.panY }));

    win.destroy();
    console.log('');
    console.log(failures.length ? `FAILED ${failures.length}` : 'ALL PASS');
    app.exit(failures.length ? 1 : 0);
}

const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const presetNames = fs.readdirSync(PRESET_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''));
ipcMain.handle('list-presets', () => presetNames);
ipcMain.handle('load-preset', (_event, name) => {
    try {
        return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name + '.json'), 'utf8'));
    } catch (_) {
        return null;
    }
});
ipcMain.handle('list-logos', () => []);
ipcMain.handle('list-textures', () => []);
ipcMain.handle('list-templates', () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('save-prefs', () => ({ ok: true }));
ipcMain.handle('get-user', () => null);
for (const channel of ['save-image-base64', 'save-images-batch', 'save-template', 'load-template', 'delete-template',
    'rename-template', 'export-template', 'import-template', 'export-qfs', 'open-qfs', 'save-user', 'logout-user']) {
    ipcMain.handle(channel, () => ({ ok: true }));
}

app.whenReady().then(main).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
});
