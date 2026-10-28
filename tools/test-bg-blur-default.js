// 「背景模糊默认开启」记忆开关回归。
// 用法:
//   node tools/test-bg-blur-default.js
//
// 覆盖:
//  ① 未设置时保持旧行为（跟随预设，视觉基线不受影响）
//  ② 点按钮后立即改写当前模板并记住；切到另一支持风格仍生效
//  ③ 不支持背景模糊的风格不被误改，按钮也不露出
//  ④ 显式记忆「默认关」能覆盖预设自带的 signBgBlur=1
//  ⑤ 重新加载页面后偏好仍在（localStorage 持久化）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
// 主进程 stdout/stderr 在管道调用方(CI/npm/PowerShell)关闭后,残留日志会触发 EPIPE 弹窗;吞掉它。
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'src', 'renderer', 'index.html');
// 本用例真读写 localStorage，必须与用户/其他用例隔离。
const TMP_UD = path.join(os.tmpdir(), 'qfs-test-bgblur-' + process.pid);
app.setPath('userData', TMP_UD);
process.on('exit', () => { try { fs.rmSync(TMP_UD, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响退出码 */ } });

ipcMain.handle('list-presets', () => fs.readdirSync(path.join(ROOT, 'shared', 'presets'))
    .filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'presets', n + '.json'), 'utf8')));
for (const c of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers']) ipcMain.handle(c, () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template',
    'export-qfs', 'save-user', 'logout-user', 'read-exif', 'save-image-base64', 'save-images-batch',
    'check-for-updates', 'start-update-download', 'quit-and-install', 'write-export-files',
    'pick-export-location', 'open-wall-covers-dir']) {
    ipcMain.handle(c, () => (c.startsWith('open') || c.startsWith('pick') ? { canceled: true } : { ok: true }));
}

const SCENARIO = `
(async () => {
    const A = window.App;
    const KEY = 'qfs_bg_blur_default';
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const res = [];
    const add = (ok, label, got) => res.push({ ok: !!ok, label, got: String(got) });
    const num = (v) => Number(v || 0);

    // 面板几何断言要求"有照片"的状态：applyPreset() 现在会刷新空态，
    // 而 #inspector.no-image 会把 #panel-canvas 的 param-group 全部 display:none，
    // 没照片时 rect 恒为 0（CI 上的 row=0.0 就是这个）。这里给一张最小照片。
    if (!A.images || !A.images.length) {
        const c0 = document.createElement('canvas'); c0.width = 800; c0.height = 600;
        c0.getContext('2d').fillRect(0, 0, 800, 600);
        const im0 = new Image();
        await new Promise((r) => { im0.onload = r; im0.src = c0.toDataURL('image/jpeg', 0.9); });
        A.image = { el: im0, name: 't.jpg', w: 800, h: 600, exif: {} };
        A.images = [A.image];
        A.selectedIdx = [0]; A.currentIdx = 0;
        A.template = A.template || A.defaultTemplate();
        if (typeof A.updateEmptyState === 'function') A.updateEmptyState();
    }

    // 等预设库真正加载完（init 里的 loadPresets 是异步的）
    for (let i = 0; i < 120 && !(A.presets || []).length; i++) await sleep(50);
    if (!(A.presets || []).length) throw new Error('预设库未加载');

    const supported = A.presets.filter(p => window.StyleCaps.visibleRows(p.photoFrameStyle || '').rowBgBlur);
    const unsupported = A.presets.filter(p => !window.StyleCaps.visibleRows(p.photoFrameStyle || '').rowBgBlur);
    // 优先挑预设本来没开模糊的，避免「默认开」和预设自带值撞在一起看不出效果。
    const pFollow = supported.find(p => !p.signBgBlur) || supported[0];
    const pNext = supported.find(p => p !== pFollow && !p.signBgBlur) || supported.find(p => p !== pFollow);
    const pNo = unsupported.find(p => p.photoFrameStyle) || unsupported[0];
    const pExplicit = A.presets.find(p => p.photoFrameStyle === 'PARAM_CREDIT');
    if (!pFollow || !pNext || !pNo) throw new Error('预设样本不足');

    // 从「未设置」开始，模拟首次使用
    try { localStorage.removeItem(KEY); } catch (e) {}
    A._bgBlurDefault = A.readBgBlurDefault();
    A.refreshBgBlurDefaultUI();
    A.applyPreset(pFollow);
    await sleep(40);

    const btn = document.getElementById('btnBgBlurDefault');
    const chk = document.getElementById('chkBgBlur');
    const row = document.getElementById('rowBgBlur');
    const rowInt = document.getElementById('rowBgBlurInt');
    if (!btn || !chk || !row || !rowInt) throw new Error('背景模糊控件缺失');

    add(row.style.display !== 'none', '支持风格露出背景模糊行', row.style.display);
    const rr = row.getBoundingClientRect(), br = btn.getBoundingClientRect(), cr = chk.getBoundingClientRect();
    add(rr.width > 0 && br.left >= cr.right && br.right <= rr.right + 0.5, '默认键在复选框后且不溢出', 'row=' + rr.width.toFixed(1) + ' btn=' + br.left.toFixed(1) + '..' + br.right.toFixed(1));
    add(A._bgBlurDefault === null, '首次为「跟随预设」', A._bgBlurDefault);
    add(btn.textContent.trim() === '默认跟随', '按钮文案=默认跟随', btn.textContent.trim());
    add(num(A.template.signBgBlur) === num(pFollow.signBgBlur), '初始值跟随预设', num(A.template.signBgBlur) + ' vs ' + num(pFollow.signBgBlur));

    // ① 打开默认记忆 → 当前模板立即开
    btn.click();
    await sleep(40);
    add(localStorage.getItem(KEY) === '1', '记忆写入 localStorage=1', localStorage.getItem(KEY));
    add(A._bgBlurDefault === 1, '内存偏好=默认开', A._bgBlurDefault);
    add(num(A.template.signBgBlur) === 1, '当前模板立即开启', num(A.template.signBgBlur));
    add(chk.checked === true, '当前复选框同步勾选', chk.checked);
    add(btn.textContent.trim() === '默认开', '按钮文案=默认开', btn.textContent.trim());
    add(getComputedStyle(rowInt).display !== 'none', '模糊程度行展开', getComputedStyle(rowInt).display);

    // ② 切到另一个支持模糊的预设，默认开仍生效
    A.applyPreset(pNext);
    await sleep(40);
    add(num(A.template.signBgBlur) === 1, '切预设后仍默认开', num(A.template.signBgBlur));
    add(document.getElementById('chkBgBlur').checked === true, '切预设后复选框仍勾选', document.getElementById('chkBgBlur').checked);
    add(getComputedStyle(rowInt).display !== 'none', '切预设后模糊程度行仍展开', getComputedStyle(rowInt).display);

    // ③ 不支持模糊的风格：按钮不露出，预设值不被改写
    A.applyPreset(pNo);
    await sleep(40);
    add(document.getElementById('rowBgBlur').style.display === 'none', '不支持风格隐藏模糊行', document.getElementById('rowBgBlur').style.display);
    add(num(A.template.signBgBlur) === num(pNo.signBgBlur), '不支持风格不被误改', num(A.template.signBgBlur) + ' vs ' + num(pNo.signBgBlur));

    // ④ 改回默认关；显式 signBgBlur=1 的预设也应被覆盖
    A.applyPreset(pFollow);
    await sleep(30);
    btn.click();
    await sleep(40);
    add(localStorage.getItem(KEY) === '0', '记忆写入 localStorage=0', localStorage.getItem(KEY));
    add(A._bgBlurDefault === 0, '内存偏好=默认关', A._bgBlurDefault);
    add(num(A.template.signBgBlur) === 0, '当前模板立即关闭', num(A.template.signBgBlur));
    add(btn.textContent.trim() === '默认关', '按钮文案=默认关', btn.textContent.trim());

    A.applyPreset(pNext);
    await sleep(40);
    add(num(A.template.signBgBlur) === 0, '默认关在下一预设生效', num(A.template.signBgBlur));
    add(document.getElementById('chkBgBlur').checked === false, '默认关时复选框不勾选', document.getElementById('chkBgBlur').checked);
    add(getComputedStyle(rowInt).display === 'none', '默认关时模糊程度行收起', getComputedStyle(rowInt).display);

    if (pExplicit) {
        A.applyPreset(pExplicit);
        await sleep(40);
        add(num(A.template.signBgBlur) === 0, '默认关覆盖显式 signBgBlur=1', num(A.template.signBgBlur));
    }

    // 留一个「默认开」给页面重载后的持久化断言
    try { localStorage.setItem(KEY, '1'); } catch (e) {}
    return { res, pNext: pNext.templateName, pFollow: pFollow.templateName, pExplicit: pExplicit ? pExplicit.templateName : '' };
})()
`;

async function waitForApp(win) {
    for (let i = 0; i < 160; i++) {
        const ok = await win.webContents.executeJavaScript('!!(window.App && window.App.dom && (window.App.presets || []).length)');
        if (ok) return;
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('App/预设库未就绪');
}

function finish(code) { app.exit(code || 0); }

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 1400, height: 900, show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true,
            backgroundThrottling: false,
        },
    });
    win.webContents.on('console-message', (_e, l, m) => {
        const s = String(m);
        if (l >= 2 && !/willReadFrequently/.test(s)) console.log('  [renderer] ' + s.slice(0, 180));
    });

    await win.loadFile(PAGE);

    win.showInactive();

    await waitForApp(win);
    const first = await win.webContents.executeJavaScript(SCENARIO);

    // 页面重载：localStorage 应仍在，init 读取后按钮和预设应用都应恢复「默认开」
    await win.loadFile(PAGE);
    await waitForApp(win);
    const persisted = await win.webContents.executeJavaScript(`(async () => {
        const A = window.App;
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 120 && !(A.presets || []).length; i++) await sleep(50);
        const p = A.presets.find(x => x.templateName === ${JSON.stringify(first.pNext)});
        A.applyPreset(p);
        await sleep(40);
        const out = {
            pref: A._bgBlurDefault,
            key: localStorage.getItem('qfs_bg_blur_default'),
            text: (document.getElementById('btnBgBlurDefault') || {}).textContent || '',
            sign: Number(A.template.signBgBlur || 0),
            checked: !!(document.getElementById('chkBgBlur') || {}).checked,
            rowInt: getComputedStyle(document.getElementById('rowBgBlurInt')).display,
        };
        try { localStorage.removeItem('qfs_bg_blur_default'); } catch (e) {}
        return out;
    })()`);

    const checks = first.res.slice();
    const add = (ok, label, got) => checks.push({ ok: !!ok, label, got: String(got) });
    add(persisted.key === '1', '重载后 localStorage 仍为 1', persisted.key);
    add(persisted.pref === 1, '重载后 init 读到默认开', persisted.pref);
    add(persisted.text.trim() === '默认开', '重载后按钮文案=默认开', persisted.text.trim());
    add(persisted.sign === 1, '重载后预设仍默认开', persisted.sign);
    add(persisted.checked === true, '重载后复选框勾选', persisted.checked);
    add(persisted.rowInt !== 'none', '重载后模糊程度行仍展开', persisted.rowInt);

    let fail = 0;
    console.log('背景模糊默认记忆  (样本: ' + first.pFollow + ' / ' + first.pNext + (first.pExplicit ? ' / ' + first.pExplicit : '') + ')');
    console.log('─'.repeat(96));
    for (const c of checks) {
        if (!c.ok) fail++;
        console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.label.padEnd(28)} ${c.got}`);
    }
    console.log('─'.repeat(96));
    console.log(fail ? `✖ ${fail} 项未通过` : `✓ 全部通过 (${checks.length} 项)`);
    finish(fail ? 1 : 0);
}).catch(e => { console.error(e); finish(1); });
