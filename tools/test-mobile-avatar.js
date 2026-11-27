'use strict';
// 手机版用户头像专项测试：加载 / 注入 / 预设继承 / 面板滑块 / 我的页入口。
// 用法：node tools/run-electron.js tools/test-mobile-avatar.js
const path = require('path');
const { app, BrowserWindow } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'mobile', 'www', 'index.html');
const fails = [];
const check = (ok, label, extra) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) fails.push(label);
};

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 390, height: 844, show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const errors = [];
    win.webContents.on('console-message', (_e, level, message) => {
        if (level === 2 || /Uncaught|is not defined|Cannot read/i.test(message)) errors.push(message);
    });
    await win.loadFile(INDEX);
    const exec = (x) => win.webContents.executeJavaScript(x, true);
    for (let i = 0; i < 100; i++) { if (await exec('!!window.QF_MOBILE_READY')) break; await new Promise((r) => setTimeout(r, 100)); }

    const r = await exec(`(async () => {
        const wait = ms => new Promise(res => setTimeout(res, ms));
        const out = { err: '' };
        try {
            // 先导入一张测试图，编辑面板才有内容可渲染
            const ph = document.createElement('canvas'); ph.width = 400; ph.height = 300;
            const pg = ph.getContext('2d'); pg.fillStyle = '#889'; pg.fillRect(0, 0, 400, 300);
            ph.naturalWidth = 400; ph.naturalHeight = 300; ph.complete = true;
            window.qfsNative.pickImages = async () => [{ el: ph, name: 'avatar-test.jpg', w: 400, h: 300, grade: null }];
            document.getElementById('btnPick').click();
            await wait(300);

            // 1) 初始状态：无头像时显示默认头像与「设置我的头像」
            out.initialHas = window.QF_Avatar.hasAvatar();
            out.initialName = document.getElementById('mineAvatarName').textContent;

            // 2) 注入一张头像（等价于用户上传后的 localStorage），等待解码
            const c = document.createElement('canvas'); c.width = 200; c.height = 200;
            const g = c.getContext('2d');
            g.fillStyle = '#E9A857'; g.fillRect(0, 0, 200, 200);
            g.fillStyle = '#0A0B0A'; g.beginPath(); g.arc(100, 100, 60, 0, 7); g.fill();
            const url = c.toDataURL('image/jpeg', 0.9);
            window.QF_Avatar.__setForTest(url);
            await wait(150);
            out.injectedHas = window.QF_Avatar.hasAvatar();
            out.globalW = window.__qfsAvatarImg && window.__qfsAvatarImg.naturalWidth;
            out.stored = (localStorage.getItem('qfs_user_avatar') || '').slice(0, 22);
            out.mineName = document.getElementById('mineAvatarName').textContent;
            out.mineSrc = (document.getElementById('mineAvatarImg').src || '').slice(0, 22);

            // 3) 头像引入后切到「头像纪念」预设：avatarShow 应为 1，头像大小可继承
            const ps = window.QF_PRESETS || [];
            const idx = ps.findIndex(p => p.templateName === '头像纪念' || p._fileName === '头像纪念');
            out.avatarPresetFound = idx >= 0;
            if (idx >= 0) {
                const before = window.App.template ? window.App.template.avatarScale : undefined;
                document.querySelector('[data-preset="' + idx + '"]');
                // 用页面 API 走完整链路：点风格墙卡片
                const card = Array.from(document.querySelectorAll('[data-preset]'))
                    .find(b => b.dataset.preset === String(idx));
                if (card) card.click();
                await wait(200);
                out.showAfter = window.App.template.avatarShow;
                out.scaleAfter = window.App.template.avatarScale;
            }

            // 4) 面板滑杆：文字子页应含「头像大小」
            document.querySelector('[data-tab="edit"]') && document.querySelector('[data-tab="edit"]').click();
            document.querySelector('[data-edit-sub="text"]') && document.querySelector('[data-edit-sub="text"]').click();
            await wait(120);
            const labels = Array.from(document.querySelectorAll('#panel .ctl-row label')).map(e => e.textContent.trim());
            out.hasSizeCtl = labels.includes('头像大小');
            out.hasShowCtl = labels.includes('显示头像');
            out.sizeCtlCount = labels.filter(l => l === '头像大小').length;

            // 5) 像素级验证：红色头像应出现在「头像纪念」成品里
            const av = document.createElement('canvas'); av.width = 200; av.height = 200;
            const ag = av.getContext('2d'); ag.fillStyle = '#ff0000'; ag.fillRect(0, 0, 200, 200);
            window.QF_Avatar.__setForTest(av.toDataURL('image/jpeg', 0.95));
            await wait(150);
            const cv = document.getElementById('previewCanvas');
            const dg = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
            out.redPixels = 0;
            for (let i = 0; i < dg.length; i += 4) {
                if (dg[i] > 180 && dg[i + 1] < 80 && dg[i + 2] < 80) out.redPixels++;
            }

            // 6) 移除头像后，全局图应清空、我的页回到默认文案
            window.QF_Avatar.clear();
            await wait(80);
            out.clearedHas = window.QF_Avatar.hasAvatar();
            out.clearedStored = localStorage.getItem('qfs_user_avatar');
            out.clearedName = document.getElementById('mineAvatarName').textContent;
            out.clearedSrc = (document.getElementById('mineAvatarImg').src || '').slice(-10);
        } catch (e) { out.err = String(e && e.stack || e); }
        return out;
    })()`);

    check(!r.err && !r.initialHas && r.initialName === '设置我的头像',
        '头像默认未设置，我的页显示设置引导', JSON.stringify({ has: r.initialHas, name: r.initialName, err: r.err }));
    check(!r.err && r.injectedHas && r.globalW === 200 && r.stored.startsWith('data:image/jpeg')
        && r.mineName === '我的头像' && r.mineSrc.startsWith('data:image/jpeg'),
        '头像注入后引擎全局图、本机存储与我的页同步更新',
        JSON.stringify({ has: r.injectedHas, w: r.globalW, stored: r.stored, name: r.mineName, err: r.err }));
    check(!r.err && r.avatarPresetFound && r.showAfter === 1,
        '头像风格预设能打开头像开关',
        JSON.stringify({ found: r.avatarPresetFound, show: r.showAfter, scale: r.scaleAfter, err: r.err }));
    check(!r.err && r.hasShowCtl && r.hasSizeCtl && r.sizeCtlCount === 1,
        '文字面板含显示头像与头像大小控件',
        JSON.stringify({ show: r.hasShowCtl, size: r.hasSizeCtl, count: r.sizeCtlCount, err: r.err }));
    check(!r.err && r.redPixels > 200,
        '红色用户头像真的画进了「头像纪念」成品',
        JSON.stringify({ redPixels: r.redPixels, err: r.err }));
    check(!r.err && !r.clearedHas && !r.clearedStored && r.clearedName === '设置我的头像'
        && r.clearedSrc === 'avatar.png',
        '移除头像后清空存储并回到默认图',
        JSON.stringify({ has: r.clearedHas, stored: r.clearedStored, name: r.clearedName, src: r.clearedSrc, err: r.err }));
    check(errors.length === 0, '头像流程无脚本异常', errors.slice(0, 3).join(' / '));

    console.log(fails.length ? `\n${fails.length} FAILURE(S)` : '\nALL PASS');
    win.destroy();
    app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });
