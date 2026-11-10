// 「效果」段三行数值回归：纹理 / 清晰度 / 去除薄雾拖动时标签必须即时更新，
// 且与同组晕影、颗粒一样用纯数字；锐化 / 校准等其余滑块保持原来的带符号格式。
// 用法: node tools/run-electron.js tools/test-grade-fx-labels.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_event, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name.replace(/\.json$/, '') + '.json'), 'utf8')); } catch (_) { return null; }
});
const EMPTY_LIST = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });
for (const channel of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers', 'list-grade-presets']) ipcMain.handle(channel, EMPTY_LIST);
for (const channel of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install',
    'open-wall-covers-dir']) ipcMain.handle(channel, OK);
for (const channel of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files',
    'read-exif', 'open-image']) ipcMain.handle(channel, CANCEL);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('load-acr-tables', () => null);
ipcMain.handle('load-acr-shadows', () => null);

const failures = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}

const MAKE_IMAGE = `async (w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d'); g.fillStyle = '#808080'; g.fillRect(0, 0, w, h);
    const el = new Image();
    await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
    return el;
}`;

async function main() {
    await app.whenReady();
    const win = new BrowserWindow({
        width: 1280, height: 900, show: false, paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const exec = (expr) => win.webContents.executeJavaScript(expr);
    await sleep(400);
    win.showInactive();
    await exec(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(600);
    await exec(`window.__mk = ${MAKE_IMAGE}; true`);

    await exec(`(async () => {
        const A = window.App;
        const el = await window.__mk(320, 240);
        const im = { el };
        A.images = [im]; A.image = im;
        A.template = A.defaultTemplate();
        A.setTpl(im, A.template);
        if (A.invalidateGrade) A.invalidateGrade(im);
        A.scheduleRender(true);
        if (A.switchTab) A.switchTab('grade');
        return true;
    })()`);
    await sleep(300);

    const r = await exec(`(() => {
        const A = window.App;
        const $ = (id) => document.getElementById(id);
        const fire = (inp, v, type) => {
            inp.value = String(v);
            inp.dispatchEvent(new Event(type || 'input', { bubbles: true }));
        };
        const read = () => ({
            tex: $('lblDetTex').textContent,
            clar: $('lblDetClar').textContent,
            dhz: $('lblDetDhz').textContent
        });
        const gradeDet = () => {
            const p = A.gradeOf(A.image) || {};
            return { tex: (p.det || {}).tex, clar: (p.det || {}).clar, dhz: (p.det || {}).dhz };
        };
        const out = { bound: !!A._gradeExtra };

        // 1) 拖动（input）即时更新
        fire($('slDetTex'), 42);
        fire($('slDetClar'), -30);
        fire($('slDetDhz'), 18);
        out.drag = read();
        out.grade = gradeDet();

        // 2) 松手（change）同样更新
        fire($('slDetTex'), 7, 'change');
        out.change = $('lblDetTex').textContent;

        // 3) 切图 / 套预设走的 syncGradeExtraUI 回填也必须是纯数字
        if (A.syncGradeExtraUI) A.syncGradeExtraUI({ det: { tex: 55, clar: -12, dhz: 9 } });
        out.sync = read();

        // 4) 复位「效果」段：三行回 0，数据也归零
        if (A.resetGradeSection) A.resetGradeSection('fx');
        out.reset = read();
        out.resetGrade = gradeDet();

        // 5) 对照组：锐化 / 校准仍是带符号整数，没被「纯数字」误伤
        const shdBefore = {
            val: $('slDetShd').value, lbl: $('lblDetShd').textContent,
            bound: !!(A._gradeExtra && A._gradeExtra.det && A._gradeExtra.det.shd)
        };
        fire($('slDetShp'), 60);
        fire($('slCalRH'), 20);
        out.controls = {
            shp: $('lblDetShp').textContent,
            cal: $('lblCalRH').textContent,
            shpVal: $('slDetShp').value,
            shpGrade: (A.gradeOf(A.image).det || {}).shp,
            shdBefore
        };
        return out;
    })()`);

    check(r.bound, '细节滑块组已完成绑定（_gradeExtra 存在）', JSON.stringify(r.bound));
    check(r.drag && r.drag.tex === '42' && r.drag.clar === '-30' && r.drag.dhz === '18',
        '纹理 / 清晰度 / 去除薄雾拖动时标签即时显示纯数字', JSON.stringify(r.drag));
    check(r.grade && r.grade.tex === 42 && r.grade.clar === -30 && r.grade.dhz === 18,
        '三行拖动同时写入 grade.det（控件确实生效）', JSON.stringify(r.grade));
    check(r.change === '7', '松手（change）时标签同样即时更新', JSON.stringify(r.change));
    check(r.sync && r.sync.tex === '55' && r.sync.clar === '-12' && r.sync.dhz === '9',
        '切图 / 套预设的程序化回填也是纯数字', JSON.stringify(r.sync));
    // 全零的 det 会被 normalizeGrade 压成空对象（中性不存），空字段等价于 0
    const neutral = (v) => v == null || Number(v) === 0;
    check(r.reset && r.reset.tex === '0' && r.reset.clar === '0' && r.reset.dhz === '0'
          && r.resetGrade && neutral(r.resetGrade.tex) && neutral(r.resetGrade.clar) && neutral(r.resetGrade.dhz),
        '复位「效果」段后三行与数据都回到 0（中性 det 可不存）', JSON.stringify({ labels: r.reset, grade: r.resetGrade }));
    check(r.controls && r.controls.shp === '+60' && r.controls.cal === '+20',
        '锐化 / 校准仍保持原来的带符号格式', JSON.stringify(r.controls));

    console.log(failures.length
        ? `\n未通过 ${failures.length} 项：` + failures.map((f) => '\n - ' + f).join('')
        : '\nALL PASS');
    app.quit();
    process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.error('FAIL', e); app.quit(); process.exit(1); });
