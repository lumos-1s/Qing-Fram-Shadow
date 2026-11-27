'use strict';
// 手机版功能细节专项：搜索自建风格 / 头像选图提示 / 铺满与导出取消 /
// 效果与调色重置 / 分享码文案 / 首页返回。用法：node tools/run-electron.js tools/test-mobile-details.js
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
        const toast = () => (document.getElementById('toast').textContent || '');
        const row = (label) => Array.from(document.querySelectorAll('#panel .ctl-row'))
            .find(x => x.querySelector('label') && x.querySelector('label').textContent.trim() === label);
        try {
            // 0) 首页是完整目录：所有分类、每组全部预设都要露出，不能被 4 组 / 8 张截断
            const wall = (window.QF_WALL && window.QF_WALL.items) || [];
            const allTags = Array.from(new Set(wall.map(x => x.tag).filter(Boolean)));
            out.wallItems = wall.length;
            out.homeTags = allTags.length;
            out.tagSections = document.querySelectorAll('#homeSections .home-sec-more[data-tag]').length;
            out.homePresets = document.querySelectorAll('#homeSections [data-home-preset]').length;

            const ph = document.createElement('canvas'); ph.width = 400; ph.height = 300;
            const pg = ph.getContext('2d'); pg.fillStyle = '#889'; pg.fillRect(0, 0, 400, 300);
            ph.naturalWidth = 400; ph.naturalHeight = 300; ph.complete = true;
            window.qfsNative.pickImages = async () => [{ el: ph, name: 'detail.jpg', w: 400, h: 300, grade: null }];
            document.getElementById('btnPick').click();
            await wait(320);

            // 1) 效果重置：漏光类型/角度也要回到默认值
            document.querySelector('[data-tab="grade"]').click();
            await wait(180);
            const typeRow = row('漏光类型'), angleRow = row('漏光角度');
            out.fxRows = !!(typeRow && angleRow);
            if (typeRow && angleRow) {
                const sel = typeRow.querySelector('select');
                sel.value = 'green';
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                const inp = angleRow.querySelector('input');
                inp.value = '90';
                inp.dispatchEvent(new Event('input', { bubbles: true }));
                out.fxBefore = [window.App.template.lightEffect.lightLeakType, window.App.template.lightEffect.lightLeakAngle];
                document.getElementById('btnFxReset').click();
                await wait(80);
                const le = window.App.template.lightEffect;
                out.fxAfter = [le.lightLeakType, le.lightLeakAngle, le.vignetteStrength, le.lightLeakOpacity];
            }

            // 2) 重置调色：模块未就绪时不能假报成功
            document.querySelector('[data-tab="grade"]').click();
            await wait(120);
            const origReset = window.App.resetGrade;
            window.App.resetGrade = undefined;
            document.getElementById('btnGradeReset').click();
            out.guardToast = toast();
            window.App.resetGrade = origReset;

            // 3) 一键铺满：铺满之后再点要给反馈，而不是无反应
            document.querySelector('[data-tab="puzzle"]').click();
            await wait(180);
            const layout = document.querySelector('[data-layout="grid4"]');
            if (layout) layout.click();
            await wait(140);
            document.getElementById('btnFillAll').click();
            await wait(120);
            document.getElementById('btnFillAll').click();
            out.fillToast = toast();

            // 4) 切图导出：再点一次导出按钮应能取消，取消后标志复位可重新导出
            document.querySelector('[data-tab="crop"]').click();
            await wait(200);
            let saves = 0;
            const origSave = window.qfsNative.saveImage;
            window.qfsNative.saveImage = async () => { saves++; await wait(480); return { ok: true }; };
            document.getElementById('btnExport').click();
            await wait(180);
            out.exportingToast = toast();
            document.getElementById('btnExport').click();
            await wait(700);
            out.cancelToast = toast();
            out.savesAfterCancel = saves;
            document.getElementById('btnExport').click();
            await wait(2400);
            out.savesAfterRetry = saves;
            window.qfsNative.saveImage = origSave;

            // 5) 分享码文案指向真实入口
            document.querySelector('[data-page="mine"]').click();
            await wait(120);
            document.getElementById('btnShareStyle').click();
            await wait(120);
            out.shareNote = (document.getElementById('styleCodeNote').textContent || '');
            const mask = document.querySelector('#styleModal [data-modal-close]');
            if (mask) mask.click();

            // 6) 头像选图取消要有提示，不再静默
            window.QF_Avatar.clear();
            window.qfsNative.pickImages = async () => [];
            document.getElementById('mineAvatarRow').click();
            await wait(180);
            out.avatarToast = toast();

            // 7) 搜索要能找到「我的风格」，切走再回来也保持筛选
            window.qfsNative.pickImages = async () => [{ el: ph, name: 'detail.jpg', w: 400, h: 300, grade: null }];
            document.querySelector('[data-page="edit"]').click();
            document.querySelector('[data-tab="style"]').click();
            await wait(200);
            document.getElementById('btnSaveStyle').click();
            await wait(100);
            const nameInput = document.getElementById('styleNameInput');
            if (nameInput) {
                nameInput.value = '细节测试风格';
                const primary = document.querySelector('#styleModal .act-btn.primary');
                if (primary) primary.click();
            }
            await wait(200);
            // 长按自建风格：管理菜单里能改名，删除仍是第一步操作（不破坏原交互）
            const ownCard = document.querySelector('[data-my-style="0"]');
            out.renameCard = !!ownCard;
            if (ownCard) {
                ownCard.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 61, button: 0 }));
                await wait(720);
                const renameAct = document.querySelector('#styleModal [data-modal-act="2"]');
                out.renameAct = !!renameAct;
                if (renameAct) renameAct.click();
                await wait(120);
                const renInput = document.getElementById('styleRenameInput');
                if (renInput) {
                    renInput.value = '改名后风格';
                    const saveAct = document.querySelector('#styleModal .act-btn.primary');
                    if (saveAct) saveAct.click();
                }
                await wait(180);
                const stored = JSON.parse(localStorage.getItem('qfm_styles') || '[]');
                out.renamed = stored[0] && stored[0].name;
            }
            const qEl = document.getElementById('styleQuery');
            qEl.value = '改名后';
            qEl.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(180);
            out.mineVisible = document.querySelectorAll('.style-cell[data-mine="1"]:not([hidden])').length;
            out.allVisible = document.querySelectorAll('.style-cell:not([hidden])').length;
            const allCards = document.querySelectorAll('.style-cell[data-q]').length;
            out.searchCount = (document.getElementById('styleCount').textContent || '').trim();
            out.countMatches = out.searchCount === (out.allVisible + ' / ' + allCards + ' 款');
            out.emptyHidden = document.getElementById('styleEmpty').hidden;
            document.querySelector('[data-tab="crop"]').click();
            await wait(100);
            document.querySelector('[data-tab="style"]').click();
            await wait(180);
            out.afterReRender = document.querySelectorAll('.style-cell:not([hidden])').length;
            out.queryKept = document.getElementById('styleQuery').value;

            // 8) 首页返回键：已在首页时滚回顶部
            document.querySelector('[data-page="home"]').click();
            await wait(120);
            const sc = document.getElementById('homeScroll');
            if (sc) sc.scrollTop = 300;
            out.scrollBefore = sc ? sc.scrollTop : -1;
            document.getElementById('btnBack').click();
            await wait(500);
            out.scrollAfter = sc ? sc.scrollTop : -1;
            out.stillHome = document.getElementById('app').dataset.page === 'home';
        } catch (e) { out.err = String(e && e.stack || e); }
        return out;
    })()`);

    check(!r.err && r.fxRows && r.fxBefore && r.fxBefore[0] === 'green' && r.fxBefore[1] === 90
        && r.fxAfter && r.fxAfter[0] === 'warm' && r.fxAfter[1] === 225
        && r.fxAfter[2] === 0 && r.fxAfter[3] === 0,
        '效果重置：漏光类型与角度一并复位', JSON.stringify({ before: r.fxBefore, after: r.fxAfter, err: r.err }));
    check(!r.err && /未就绪/.test(r.guardToast || ''),
        '重置调色：模块未就绪时明确提示', JSON.stringify({ toast: r.guardToast, err: r.err }));
    check(!r.err && /铺满/.test(r.fillToast || ''),
        '一键铺满：已满时给出反馈', JSON.stringify({ toast: r.fillToast, err: r.err }));
    check(!r.err && /正在导出/.test(r.exportingToast || '') && /已取消/.test(r.cancelToast || '')
        && r.savesAfterCancel <= 1 && r.savesAfterRetry > r.savesAfterCancel,
        '切图导出：可取消且取消后可重新导出',
        JSON.stringify({ start: r.exportingToast, cancel: r.cancelToast, saves: r.savesAfterCancel, retry: r.savesAfterRetry, err: r.err }));
    check(!r.err && /我的 → 从分享码导入/.test(r.shareNote || ''),
        '分享码文案指向真实入口', JSON.stringify({ note: r.shareNote, err: r.err }));
    check(!r.err && r.tagSections === r.homeTags && r.homePresets === r.wallItems && r.wallItems > 80,
        '首页风格目录：全部分类与全部预设都露出',
        JSON.stringify({ tags: r.tagSections + '/' + r.homeTags, cards: r.homePresets + '/' + r.wallItems, err: r.err }));
    check(!r.err && /没有选到照片/.test(r.avatarToast || ''),
        '头像选图取消后不再静默', JSON.stringify({ toast: r.avatarToast, err: r.err }));
    check(!r.err && r.mineVisible === 1 && r.allVisible === 1 && r.countMatches && r.emptyHidden,
        '风格搜索：能搜到自建风格且计数一致',
        JSON.stringify({ mine: r.mineVisible, all: r.allVisible, count: r.searchCount, err: r.err }));
    check(!r.err && r.renameCard && r.renameAct && r.renamed === '改名后风格',
        '我的风格：长按可重命名', JSON.stringify({ card: r.renameCard, act: r.renameAct, name: r.renamed, err: r.err }));
    check(!r.err && r.afterReRender === r.allVisible && r.queryKept === '改名后',
        '风格搜索：切走再回来仍保持筛选',
        JSON.stringify({ after: r.afterReRender, query: r.queryKept, err: r.err }));
    check(!r.err && r.scrollBefore > 0 && r.scrollAfter === 0 && r.stillHome,
        '首页返回键：滚回顶部且不跳页',
        JSON.stringify({ before: r.scrollBefore, after: r.scrollAfter, home: r.stillHome, err: r.err }));
    check(errors.length === 0, '细节流程无脚本异常', errors.slice(0, 3).join(' / '));

    console.log(fails.length ? `\n${fails.length} FAILURE(S)` : '\nALL PASS');
    win.destroy();
    app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });
