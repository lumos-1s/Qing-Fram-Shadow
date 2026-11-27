'use strict';
// 手机版细节打磨专项：弹层滚动条/高度、摘要同步、入口筛选、分级重置、返回键。
// 用法：node tools/run-electron.js tools/test-mobile-polish.js
const path = require('path');
const { app, BrowserWindow } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const INDEX = path.join(__dirname, '..', 'mobile', 'www', 'index.html');
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
            // 0) 还没有照片时，「我的 → 导出画质」也要能打开设置，只是不能导出
            document.querySelector('#tabbar [data-page="mine"]').click();
            await wait(120);
            document.getElementById('btnOpenExport').click();
            await wait(100);
            out.emptySheet = !document.getElementById('exportSheet').hidden;
            out.emptyGo = document.getElementById('btnExportGo').disabled;
            out.emptyHint = document.getElementById('exportHint').textContent;
            document.getElementById('btnExportCancel').click();
            document.querySelector('#tabbar [data-page="home"]').click();
            await wait(80);

            const ph = document.createElement('canvas'); ph.width = 1200; ph.height = 900;
            const g = ph.getContext('2d'); g.fillStyle = '#698'; g.fillRect(0, 0, 1200, 900);
            ph.naturalWidth = 1200; ph.naturalHeight = 900; ph.complete = true;
            window.qfsNative.pickImages = async () => [{ el: ph, name: 'polish.jpg', w: 1200, h: 900, grade: null }];
            document.getElementById('btnPick').click();
            await wait(320);

            // 1) 更新日志：滚动条走暗房配色，卡片/按钮都在屏内
            document.querySelector('#tabbar [data-page="mine"]').click();
            await wait(120);
            document.getElementById('btnChangelog').click();
            await wait(120);
            const list = document.querySelector('#styleModal .cl-list');
            const card = document.querySelector('#styleModal .modal-card');
            const btn = document.querySelector('#styleModal .act-btn.primary');
            out.scrollbar = list ? getComputedStyle(list).scrollbarColor : '';
            out.cardMax = card ? getComputedStyle(card).maxHeight : '';
            out.btnInView = !!btn && btn.getBoundingClientRect().bottom <= window.innerHeight + 1;
            out.listScrolls = !!list && list.scrollHeight > list.clientHeight;
            out.clVersion = document.querySelector('#styleModal .cl-head b').textContent;
            document.querySelector('#styleModal [data-modal-close]').click();
            await wait(80);

            // 2) 导出偏好：在「我的」里改格式/色域，摘要立即跟着变
            document.getElementById('btnOpenExport').click();
            await wait(100);
            document.querySelector('#optFormat [data-format="webp"]').click();
            await wait(80);
            out.webpSum = document.getElementById('mineExportSum').textContent;
            document.querySelector('#optFormat [data-format="jpeg"]').click();
            document.querySelector('#optColorSpace [data-colorspace="p3"]').click();
            await wait(80);
            out.p3Sum = document.getElementById('mineExportSum').textContent;
            out.p3Hint = document.getElementById('exportHint').textContent;
            document.querySelector('#optColorSpace [data-colorspace="srgb"]').click();
            document.getElementById('btnExportCancel').click();
            await wait(80);

            // 3) Logo 摘要：当前模板里有元素就显示数量
            document.getElementById('mineLogoRow').click();
            await wait(200);
            document.getElementById('btnImportLogo').click();
            await wait(400);
            document.querySelector('#tabbar [data-page="mine"]').click();
            await wait(120);
            out.logoSum = document.getElementById('mineLogoSum').textContent;

            // 4) 我的风格入口：清掉上一处留下的搜索/收藏筛选，保证自建风格可见
            document.querySelector('#tabbar [data-page="edit"]').click();
            document.querySelector('[data-tab="style"]').click();
            await wait(160);
            document.getElementById('btnSaveStyle').click();
            await wait(80);
            const ni = document.getElementById('styleNameInput');
            if (ni) {
                ni.value = '打磨测试风格';
                document.querySelector('#styleModal .act-btn.primary').click();
                await wait(160);
            }
            const sq = document.getElementById('styleQuery');
            sq.value = '不存在的关键词';
            sq.dispatchEvent(new Event('input', { bubbles: true }));
            const fav = document.querySelector('[data-fav-toggle]');
            if (fav) fav.click();
            await wait(160);
            out.beforeMineCount = document.querySelectorAll('[data-my-style]:not([hidden])').length;
            document.querySelector('#tabbar [data-page="mine"]').click();
            await wait(100);
            document.getElementById('mineStylesRow').click();
            await wait(200);
            out.afterQuery = document.getElementById('styleQuery').value;
            out.afterMyCount = document.querySelectorAll('[data-my-style]:not([hidden])').length;

            // 5) 颜色分级重置：分区与滑块要当场回到默认，不能只改了数据
            document.querySelector('[data-tab="grade"]').click();
            await wait(220);
            document.querySelector('[data-cg-zone="high"]').click();
            const sat = document.querySelector('[data-cg="s"]');
            if (sat) {
                sat.value = '63';
                sat.dispatchEvent(new Event('input', { bubbles: true }));
            }
            out.cgBefore = sat && sat.value;
            document.getElementById('btnCgReset').click();
            await wait(140);
            out.cgAfter = document.querySelector('[data-cg="s"]') && document.querySelector('[data-cg="s"]').value;
            out.cgZone = document.querySelector('[data-cg-zone].active') && document.querySelector('[data-cg-zone].active').dataset.cgZone;
            out.cgData = (window.App.image && window.App.image.grade && window.App.image.grade.cg) || null;

            // 6) 切图面板的勾选块：类名不能再撞上自由裁剪的 .crop-grid 覆盖层
            document.querySelector('[data-tab="crop"]').click();
            await wait(300);
            out.cropBlocks = document.querySelectorAll('.crop-blocks .crop-cell').length;
            const blockBox = document.querySelector('.crop-blocks input[data-block="0"]');
            if (blockBox) {
                blockBox.click();
                await wait(120);
                // 进切图页默认全选 9 块；点第 1 块应只取消它
                out.blockChecked = document.querySelectorAll('.crop-blocks input:checked').length;
                out.block0 = blockBox.checked;
            }
            out.cropHint = (() => {
                document.querySelector('#tabbar [data-page="mine"]').click();
                document.getElementById('btnOpenExport').click();
                document.querySelector('#optSize [data-size="1080"]').click();
                const t = document.getElementById('exportHint').textContent;
                document.querySelector('#optSize [data-size="0"]').click();
                document.getElementById('btnExportCancel').click();
                return t;
            })();

            // 7) 我的资料摘要：只有署名时也不能显示「未设置」
            try {
                localStorage.setItem('qfm_user_name', '');
                localStorage.setItem('qfm_user_signature', '© 2026 测试');
            } catch (_) {}
            document.querySelector('#tabbar [data-page="mine"]').click();
            await wait(100);
            out.profileSum = document.getElementById('mineProfileSum').textContent;

            // 8) 焦距切换要能撤销
            const f0 = Number(window.App.template && window.App.template.focalEq) || 0;
            document.getElementById('mineFocalRow').click();
            await wait(80);
            const f1 = Number(window.App.template && window.App.template.focalEq) || 0;
            document.getElementById('btnUndo').click();
            await wait(120);
            const f2 = Number(window.App.template && window.App.template.focalEq) || 0;
            out.focal = [f0, f1, f2];

            // 9) 顶栏缩略图在编辑页 = 复位预览，而不是无反应
            document.querySelector('#tabbar [data-page="edit"]').click();
            await wait(120);
            document.getElementById('hdrThumb').click();
            await wait(80);
            out.thumbToast = document.getElementById('toast').textContent;

            // 10) 返回键：先关弹层，再退页，首页交回系统
            document.getElementById('btnOpenExport').click();
            await wait(80);
            out.back1 = window.QF_MOBILE_BACK();
            out.sheetHidden = document.getElementById('exportSheet').hidden;
            out.back2 = window.QF_MOBILE_BACK();
            out.pageAfter = document.getElementById('app').dataset.page;
            document.querySelector('#tabbar [data-page="mine"]').click();
            await wait(80);
            document.getElementById('btnChangelog').click();
            await wait(80);
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await wait(80);
            out.escClosed = !document.getElementById('styleModal');
            out.back3 = window.QF_MOBILE_BACK();
            out.pageAfter2 = document.getElementById('app').dataset.page;
            out.back4 = window.QF_MOBILE_BACK();
        } catch (e) { out.err = String(e && e.stack || e); }
        return out;
    })()`);

    check(!r.err && r.emptySheet && r.emptyGo && /先导入一张照片/.test(r.emptyHint || ''),
        '零照片：导出设置仍可打开，主按钮置灰',
        JSON.stringify({ open: r.emptySheet, disabled: r.emptyGo, hint: r.emptyHint, err: r.err }));
    check(!r.err && /(transparent|rgba\(0, 0, 0, 0\))/.test(r.scrollbar) && !/auto/.test(r.scrollbar),
        '更新日志滚动条：暗色细轨而非系统白条', JSON.stringify({ color: r.scrollbar, err: r.err }));
    check(!r.err && r.cardMax !== 'none' && r.btnInView && r.listScrolls,
        '长弹层：内容可滚且底部按钮留在屏内',
        JSON.stringify({ max: r.cardMax, inView: r.btnInView, scrolls: r.listScrolls, err: r.err }));
    check(!r.err && r.clVersion === '0.1.0 · 手机版',
        '更新日志版本号与包版本对齐',
        JSON.stringify({ version: r.clVersion, err: r.err }));
    check(!r.err && /WEBP/.test(r.webpSum || '') && /P3/.test(r.p3Sum || '') && /P3/.test(r.p3Hint || ''),
        '导出偏好：我的页摘要与弹层提示同步',
        JSON.stringify({ webp: r.webpSum, p3: r.p3Sum, hint: r.p3Hint, err: r.err }));
    check(!r.err && /\d+ 个/.test(r.logoSum || ''),
        '我的 Logo：摘要显示已导入数量', JSON.stringify({ sum: r.logoSum, err: r.err }));
    check(!r.err && r.beforeMineCount === 0 && r.afterQuery === '' && r.afterMyCount > 0,
        '我的风格入口：清掉筛选后自建风格可见',
        JSON.stringify({ before: r.beforeMineCount, query: r.afterQuery, after: r.afterMyCount, err: r.err }));
    check(!r.err && r.cgBefore === '63' && r.cgAfter === '0' && r.cgZone === 'shadow' && !r.cgData,
        '颜色分级重置：滑块与分区当场复位',
        JSON.stringify({ before: r.cgBefore, after: r.cgAfter, zone: r.cgZone, data: r.cgData, err: r.err }));
    check(!r.err && r.cropBlocks === 9 && r.blockChecked === 8 && r.block0 === false
        && /1080/.test(r.cropHint || '') && /每块约 360px/.test(r.cropHint || ''),
        '切图面板：勾选块可用且摘要按块计算',
        JSON.stringify({ blocks: r.cropBlocks, checked: r.blockChecked, block0: r.block0,
            hint: r.cropHint, err: r.err }));
    check(!r.err && r.profileSum === '© 2026 测试',
        '我的资料：只填署名时摘要不再显示未设置',
        JSON.stringify({ sum: r.profileSum, err: r.err }));
    check(!r.err && r.focal && r.focal[0] === 0 && r.focal[1] === 1 && r.focal[2] === 0,
        '焦距切换：可撤销',
        JSON.stringify({ focal: r.focal, err: r.err }));
    check(!r.err && /预览已复位/.test(r.thumbToast || ''),
        '顶栏缩略图：编辑页点击有实际作用',
        JSON.stringify({ toast: r.thumbToast, err: r.err }));
    check(!r.err && r.back1 && r.sheetHidden && r.back2 && r.pageAfter === 'home'
        && r.escClosed && r.back3 && r.pageAfter2 === 'home' && r.back4 === false,
        '返回键：弹层 → 页 → 首页逐层退出',
        JSON.stringify({ b1: r.back1, hidden: r.sheetHidden, b2: r.back2, page: r.pageAfter,
            esc: r.escClosed, b3: r.back3, page2: r.pageAfter2, b4: r.back4, err: r.err }));
    check(errors.length === 0, '细节流程无脚本异常', errors.slice(0, 3).join(' / '));

    console.log(fails.length ? `\n${fails.length} FAILURE(S)` : '\nALL PASS');
    win.destroy();
    app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });
