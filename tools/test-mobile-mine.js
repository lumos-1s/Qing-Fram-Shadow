'use strict';
// 手机版「我的」页专项：昵称/签名、应用设置、系统设置。
// 用法：node tools/run-electron.js tools/test-mobile-mine.js
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
        const modalText = () => (document.getElementById('styleModal') || {}).textContent || '';
        const close = () => { const m = document.querySelector('#styleModal .act-btn'); if (m) m.click(); };
        try {
            const ph = document.createElement('canvas'); ph.width = 400; ph.height = 300;
            const g = ph.getContext('2d'); g.fillStyle = '#789'; g.fillRect(0, 0, 400, 300);
            ph.naturalWidth = 400; ph.naturalHeight = 300; ph.complete = true;
            window.qfsNative.pickImages = async () => [{ el: ph, name: 'mine.jpg', w: 400, h: 300, grade: null }];
            document.getElementById('btnPick').click();
            await wait(320);

            document.querySelector('#tabbar [data-page="mine"]').click();
            await wait(140);
            out.rows = ['mineProfileRow', 'mineFocalRow', 'mineLogoRow', 'btnUserTerms', 'btnPrivacy', 'btnAbout']
                .filter(id => !!document.getElementById(id)).length;
            out.groups = Array.from(document.querySelectorAll('#pageMine .mine-group h3')).map(x => x.textContent.trim());

            // 1) 昵称与署名：保存后本机留存、写进当前模板、头像行显示昵称
            document.getElementById('mineProfileRow').click();
            await wait(100);
            out.modalOpen = !!document.getElementById('styleModal');
            const inp = document.getElementById('profileName');
            const sig = document.getElementById('profileSign');
            if (inp && sig) {
                inp.value = '阿影';
                sig.value = '© 2026 阿影';
                document.querySelector('#styleModal .act-btn.primary').click();
                await wait(160);
            }
            out.storedName = localStorage.getItem('qfm_user_name');
            out.signature = window.App.template.userSignature;
            out.profileSum = document.getElementById('mineProfileSum').textContent;
            out.avatarName = document.getElementById('mineAvatarName').textContent;
            out.modalClosed = !document.getElementById('styleModal');

            // 2) 焦距类型：开/关都改模板与摘要
            const focalBefore = window.App.template.focalEq || 0;
            document.getElementById('mineFocalRow').click();
            await wait(140);
            const focalAfter = window.App.template.focalEq || 0;
            out.focal = [focalBefore, focalAfter, document.getElementById('mineFocalSum').textContent];
            document.getElementById('mineFocalRow').click();
            await wait(140);
            out.focalBack = window.App.template.focalEq || 0;

            // 3) 我的 Logo：跳到编辑页元素子页
            document.getElementById('mineLogoRow').click();
            await wait(180);
            out.logoPage = document.getElementById('app').dataset.page;
            out.logoPanel = !!document.querySelector('[data-draft-logo]');

            // 4) 系统设置：三个说明弹窗有内容、能关闭
            document.querySelector('#tabbar [data-page="mine"]').click();
            await wait(120);
            ['btnUserTerms', 'btnPrivacy', 'btnAbout'].forEach(id => {
                document.getElementById(id).click();
                out[id] = modalText();
                close();
            });
            out.allClosed = !document.getElementById('styleModal');

            // 5) 导出画质：仍从「我的」页打开原导出设置
            document.getElementById('btnOpenExport').click();
            await wait(120);
            out.exportOpen = !document.getElementById('exportSheet').hidden;
            document.getElementById('btnExportCancel').click();

            // 6) 再进资料：已存的值回填，清空昵称不应破坏默认署名
            document.querySelector('#tabbar [data-page="mine"]').click();
            document.getElementById('mineProfileRow').click();
            await wait(100);
            out.refillName = document.getElementById('profileName').value;
            out.refillSign = document.getElementById('profileSign').value;
            document.getElementById('profileName').value = '';
            document.getElementById('profileSign').value = '';
            document.querySelector('#styleModal .act-btn.primary').click();
            await wait(140);
            out.clearedName = localStorage.getItem('qfm_user_name');
            out.clearedSign = window.App.template.userSignature;

            // 7) 切换预设：签名/头像类沿用用户署名，票券类保持空白
            document.getElementById('mineProfileRow').click();
            await wait(80);
            document.getElementById('profileName').value = '阿影';
            document.getElementById('profileSign').value = '© 2026 阿影';
            document.querySelector('#styleModal .act-btn.primary').click();
            await wait(120);
            document.querySelector('#tabbar [data-page="edit"]').click();
            await wait(150);
            const tabStyle = document.querySelector('[data-tab="style"]');
            if (tabStyle) tabStyle.click();
            await wait(150);
            const ps = window.QF_PRESETS || [];
            const applyPresetByName = (name) => {
                const i = ps.findIndex(p => p.templateName === name);
                const card = document.querySelector('[data-preset="' + i + '"]');
                if (card) card.click();
                return i >= 0;
            };
            out.hasSignPreset = applyPresetByName('签名+参数');
            await wait(220);
            out.afterSignPreset = window.App.template.userSignature;
            out.hasTicketPreset = applyPresetByName('演唱会票根');
            await wait(220);
            out.afterTicketPreset = window.App.template.userSignature;
            out.hasAvatarPreset = applyPresetByName('头像纪念');
            await wait(220);
            out.afterAvatarPreset = window.App.template.userSignature;

            // 8) 编辑页直接改「署名内容」也要同步回偏好，切预设时才不会退回旧签名
            const editTab = document.querySelector('[data-tab="edit"]');
            if (editTab) editTab.click();
            await wait(160);
            const textTab = document.querySelector('[data-edit-sub="text"]');
            if (textTab) textTab.click();
            await wait(180);
            const signRow = Array.from(document.querySelectorAll('.ctl-row')).find(r =>
                r.querySelector('label') && r.querySelector('label').textContent.trim() === '署名内容');
            const signInput = signRow && signRow.querySelector('input[data-ctl]');
            out.foundSignInput = !!signInput;
            if (signInput) {
                signInput.value = '© 编辑页改的';
                signInput.dispatchEvent(new Event('input', { bubbles: true }));
                await wait(160);
            }
            out.prefAfterEdit = localStorage.getItem('qfm_user_signature');
        } catch (e) { out.err = String(e && e.stack || e); }
        return out;
    })()`);

    check(!r.err && r.rows === 6 && r.groups.includes('用户资料') && r.groups.includes('应用设置')
        && r.groups.includes('系统设置'),
        '我的页：补齐用户资料 / 应用设置 / 系统设置分组',
        JSON.stringify({ rows: r.rows, groups: r.groups, err: r.err }));
    check(!r.err && r.modalOpen && r.modalClosed && r.storedName === '阿影'
        && r.signature === '© 2026 阿影' && r.profileSum === '阿影' && r.avatarName === '阿影',
        '昵称与签名：本机保存、写进署名、头像行显示昵称',
        JSON.stringify({ name: r.storedName, sig: r.signature, sum: r.profileSum, avatar: r.avatarName, err: r.err }));
    check(!r.err && r.focal[0] === 0 && r.focal[1] === 1 && r.focal[2] === '等效焦距' && r.focalBack === 0,
        '焦距类型：一键切换等效焦距并回退',
        JSON.stringify({ focal: r.focal, back: r.focalBack, err: r.err }));
    check(!r.err && r.logoPage === 'edit' && r.logoPanel,
        '我的 Logo：跳到编辑页元素子页', JSON.stringify({ page: r.logoPage, panel: r.logoPanel, err: r.err }));
    check(!r.err && /使用范围/.test(r.btnUserTerms || '') && /照片与资料/.test(r.btnPrivacy || '')
        && /清框影/.test(r.btnAbout || '') && r.allClosed,
        '系统设置：协议/隐私/关于有内容且可关闭', JSON.stringify({ closed: r.allClosed, err: r.err }));
    check(!r.err && r.exportOpen,
        '导出画质：仍从我的页打开导出设置', JSON.stringify({ open: r.exportOpen, err: r.err }));
    check(!r.err && r.refillName === '阿影' && r.refillSign === '© 2026 阿影'
        && !r.clearedName && r.clearedSign === '清框影',
        '昵称与签名：再次打开可回填，清空后不破坏默认署名',
        JSON.stringify({ refill: r.refillName, sign: r.refillSign, cleared: r.clearedSign, err: r.err }));
    check(!r.err && r.hasSignPreset && r.hasTicketPreset && r.hasAvatarPreset
        && r.afterSignPreset === '© 2026 阿影' && r.afterTicketPreset === ''
        && r.afterAvatarPreset === '© 2026 阿影',
        '切换预设：签名风格沿用用户署名，票券类保持空白',
        JSON.stringify({ sign: r.afterSignPreset, ticket: r.afterTicketPreset,
            back: r.afterAvatarPreset, err: r.err }));
    check(!r.err && r.foundSignInput && r.prefAfterEdit === '© 编辑页改的',
        '编辑页改署名：同步回本机偏好',
        JSON.stringify({ found: r.foundSignInput, pref: r.prefAfterEdit, err: r.err }));
    check(errors.length === 0, '我的页流程无脚本异常', errors.slice(0, 3).join(' / '));

    console.log(fails.length ? `\n${fails.length} FAILURE(S)` : '\nALL PASS');
    win.destroy();
    app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });
