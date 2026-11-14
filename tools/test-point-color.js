// 点颜色（对齐 LR 的 Point Color）—— 真实 Electron 渲染进程回归
//   node tools/run-electron.js tools/test-point-color.js
//   GL 相关的 ⑫ 需要能起 WebGL 的环境才生效，例如：
//   $env:QF_ELECTRON_FLAGS='--use-gl=swiftshader --no-sandbox'; node tools/run-electron.js tools/test-point-color.js
//
// 验证：
//  ① 混色器组出现「混色器 / 点颜色」一级页签，默认停在混色器
//  ② 切到点颜色：混色器三指标行隐藏、点颜色面板出现；无样本时是空态
//  ③ 取样按钮激活 → 画布十字光标，Esc 可退出
//  ④ 点红色块建一个样本（色相≈0、范围=30），取完自动退出取样态
//  ⑤ 再点同一个颜色不重复建样本（去重）
//  ⑥ 点蓝色块建第二个样本并选中它，色块跟着变
//  ⑦ 色相/范围滑块写回当前样本；标签同步
//  ⑧ 样本列表可展开，删除某项后数量减一、当前项归位
//  ⑨ 中性灰取不到颜色，不会建样本
//  ⑩ 切回混色器页，原来的 8 条色带行照常可用
//  ⑪ 管线接线：样本进了 grade（sanitize 后仍保留），烘焙产物存在
//  ⑫ WebGL 可用时：前置 GL pass 只动目标颜色，邻近色不乱
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
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_event, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name.replace(/\.json$/, '') + '.json'), 'utf8')); } catch (_) { return null; }
});
const EMPTY_LIST = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });
for (const channel of ['list-logos', 'list-textures', 'list-templates', 'list-wall-covers']) ipcMain.handle(channel, EMPTY_LIST);
for (const channel of ['save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external', 'open-data-dir', 'copy-text',
    'save-diagnostics', 'check-for-updates', 'start-update-download', 'quit-and-install',
    'open-wall-covers-dir']) ipcMain.handle(channel, OK);
for (const channel of ['open-images', 'open-sticker-image', 'import-template', 'open-qfs',
    'load-template', 'save-image-base64', 'save-images-batch', 'pick-export-location', 'write-export-files',
    'read-exif', 'open-image']) ipcMain.handle(channel, CANCEL);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('load-acr-tables', () => {
    try {
        const zlib = require('zlib');
        const raw = fs.readFileSync(path.join(ROOT, 'shared', 'acr', 'cr-tables.bin'));
        if (raw.slice(0, 4).toString('ascii') !== 'CRT4') return null;
        const planes = zlib.inflateSync(raw.slice(10));
        return { size: raw.readUInt16LE(4), count: raw.readUInt16LE(6), step: raw.readUInt16LE(8),
            data: planes.buffer.slice(planes.byteOffset, planes.byteOffset + planes.byteLength) };
    } catch (_) { return null; }
});
ipcMain.handle('load-acr-shadows', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.25', electron: '45', chrome: '1', node: '1',
    platform: 'win32', arch: 'x64', packaged: false, portable: false, userData: process.env.TEMP, appPath: ROOT
}));

const failures = [];
const skips = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) failures.push(`${label}${extra ? ': ' + extra : ''}`);
}
function skip(label, why) {
    console.log(`SKIP  ${label}${why ? ' | ' + why : ''}`);
    skips.push(label);
}

// 四条色条 + 右端一条中性灰：红/黄/蓝/灰的取样点各自可预期
const MAKE_IMAGE = `async (w, h) => {
    const c = document.createElement('canvas');
    c.width = w || 800; c.height = h || 500;
    const g = c.getContext('2d');
    const cols = ['#e02020', '#e8d020', '#2040e0'];
    cols.forEach((col, i) => { g.fillStyle = col; g.fillRect(i * 190, 0, 190, 500); });
    g.fillStyle = '#808080';
    g.fillRect(570, 0, 230, 500);
    const el = new Image();
    await new Promise((r) => { el.onload = r; el.onerror = r; el.src = c.toDataURL('image/png'); });
    return el;
}`;

// 在归一化照片坐标 (nx,ny) 上派发一次 mousedown
const clickJs = (nx, ny) => `(() => {
    const A = window.App, cv = A.dom.canvas;
    const rect = cv.getBoundingClientRect();
    const base = A._baseSize();
    const pr = A._photoRect;
    const bx = pr.x + ${nx} * pr.w, by = pr.y + ${ny} * pr.h;
    cv.dispatchEvent(new MouseEvent('mousedown', {
        clientX: rect.left + bx / base.w * rect.width,
        clientY: rect.top + by / base.h * rect.height,
        button: 0, bubbles: true, cancelable: true
    }));
    return true;
})()`;

const stateJs = `(() => {
    const A = window.App;
    const g = A.gradeOf(A.image) || {};
    const list = Array.isArray(g.samples) ? g.samples : [];
    const cur = list[A._pc ? A._pc.idx : 0] || null;
    return {
        n: list.length,
        idx: A._pc ? A._pc.idx : -1,
        on: !!(A._pc && A._pc.on),
        btn: document.getElementById('btnPcPick').classList.contains('active'),
        tab: document.getElementById('grpMix').dataset.tab,
        none: document.getElementById('pcPanel').classList.contains('pc-none'),
        cur: cur,
        swatch: document.getElementById('pcSwatch').style.background,
        status: A.dom.stCanvas ? A.dom.stCanvas.textContent : ''
    };
})()`;

async function main() {
    const win = new BrowserWindow({
        width: 1280, height: 900, show: false, paintWhenInitiallyHidden: true,
        backgroundColor: '#181B1A',
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    await sleep(500);
    const exec = (expr) => win.webContents.executeJavaScript(expr);
    await exec(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && App.closeIntro) App.closeIntro();
        return true;
    })()`);
    await sleep(1200);

    const s = await exec(`(async () => {
        const A = window.App;
        if (!A._pc && A.initGrade) A.initGrade();
        const makeImage = ${MAKE_IMAGE};
        const el = await makeImage(800, 500);
        const im = { el, name: '点颜色.png', path: null, w: 800, h: 500, exif: {}, customSettings: null };
        A.images = [im]; A.image = im; A.currentIdx = 0;
        A.selectedIdx = [0]; A.batchSel = [0];
        A.template = A.defaultTemplate();
        A.setTpl(im, A.template);
        A.updateEmptyState();
        // 侧栏默认停在别的子页时调色面板整块是 display:none，量不到尺寸
        if (A.switchTab) A.switchTab('grade');
        A.scheduleRender(true);
        await A.flushRender();
        await new Promise((r) => setTimeout(r, 160));
        return { inited: !!A._pc, pr: A._photoRect };
    })()`);
    check(s.inited === true, '⓪ 点颜色模块已初始化', `inited=${s.inited}`);
    check(!!s.pr && s.pr.w > 0, '⓪ 渲染后拿到照片矩形', `pr=${s.pr ? `${s.pr.w.toFixed(0)}×${s.pr.h.toFixed(0)}` : 'null'}`);

    /* ① 一级页签 */
    const tabs = await exec(`(() => {
        const t = document.getElementById('mixTabs');
        if (!t) return { exists: false };
        const b = Array.prototype.slice.call(t.querySelectorAll('.mix-tab'));
        return { exists: true, n: b.length, labels: b.map((x) => x.textContent.trim()),
                 active: !!b.find((x) => x.classList.contains('active')),
                 tab: document.getElementById('grpMix').dataset.tab };
    })()`);
    check(tabs.exists && tabs.n === 2, '① 混色器组出现两个一级页签', `n=${tabs.n} labels=${tabs.labels}`);
    check(tabs.tab === 'mix' && !!tabs.active, '① 默认停在混色器页', `tab=${tabs.tab}`);

    /* ② 空态（隐藏窗口 + 无 WebGL 时 #grpMix 带 mix-na，整个组被禁用，量高度前先摘掉） */
    const na = await exec(`(() => {
        const g = document.getElementById('grpMix');
        const had = g.classList.contains('mix-na');
        g.classList.remove('mix-na');
        return { had: had, tab: g.dataset.tab };
    })()`);
    await exec(`document.querySelector('#mixTabs .mix-tab[data-tab="pc"]').click()`);
    const before = await exec(stateJs);
    check(before.tab === 'pc', '② 点「点颜色」页签切换成功', `tab=${before.tab} mixNa=${na.had}`);
    check(before.n === 0 && before.none === true, '② 还没取样时是空态', `n=${before.n} none=${before.none}`);
    const hiddenRows = await exec(`(() => {
        const r = document.getElementById('pcRows').getBoundingClientRect();
        const e = document.getElementById('pcEmpty').getBoundingClientRect();
        return { rows: Math.round(r.height), empty: Math.round(e.height) };
    })()`);
    check(hiddenRows.rows === 0 && hiddenRows.empty > 0, '② 空态下五个滑块收起、提示文案可见', `rows=${hiddenRows.rows} empty=${hiddenRows.empty}`);

    /* ③ 取样按钮 → 十字光标 */
    await exec(`document.getElementById('btnPcPick').click()`);
    const on = await exec(`(() => {
        const A = window.App;
        return { on: !!A._pc.on, btn: document.getElementById('btnPcPick').classList.contains('active'),
                 picking: document.getElementById('canvasPane').classList.contains('mix-picking'),
                 cursor: getComputedStyle(A.dom.canvas).cursor,
                 tat: !!(A._mixPick && A._mixPick.on) };
    })()`);
    check(on.on === true && on.btn === true, '③ 点击取样进入取色态', `on=${on.on} btn=${on.btn}`);
    check(on.picking === true && on.cursor === 'crosshair', '③ 画布切到十字光标', `picking=${on.picking} cursor=${on.cursor}`);
    check(on.tat === false, '③ 混色器吸管与点颜色互斥', `tat=${on.tat}`);

    /* ④ 取红色 */
    await exec(clickJs(0.11875, 0.5));
    await sleep(80);
    const s1 = await exec(stateJs);
    check(s1.n === 1, '④ 点红块建了一个样本', `n=${s1.n}`);
    check(s1.cur && Math.abs(s1.cur.hue - 0) <= 6, '④ 样本色相等的是点到的红', `hue=${s1.cur && s1.cur.hue}`);
    check(s1.cur && s1.cur.range === 30, '④ 新样本范围默认 30', `range=${s1.cur && s1.cur.range}`);
    check(s1.on === false && s1.btn === false, '④ 取完自动退出取样态', `on=${s1.on} btn=${s1.btn}`);
    check(s1.none === false, '④ 有样本后面板离开空态', `none=${s1.none}`);
    check(String(s1.status).indexOf('已取样') >= 0, '④ 状态栏给出取样反馈', `status=${s1.status}`);

    /* ⑤ 去重 */
    await exec(`document.getElementById('btnPcPick').click()`);
    await exec(clickJs(0.12, 0.52));
    await sleep(80);
    const s2 = await exec(stateJs);
    check(s2.n === 1, '⑤ 同一个颜色不会重复建样本', `n=${s2.n}`);
    check(String(s2.status).indexOf('已经有样本') >= 0, '⑤ 提示直接调已有样本', `status=${s2.status}`);

    /* ⑥ 取蓝色 */
    await exec(`document.getElementById('btnPcPick').click()`);
    await exec(clickJs(0.71, 0.5));
    await sleep(80);
    const s3 = await exec(stateJs);
    check(s3.n === 2 && s3.idx === 1, '⑥ 点蓝块建了第二个样本并选中它', `n=${s3.n} idx=${s3.idx}`);
    check(s3.cur && Math.abs(s3.cur.hue - 240) <= 12, '⑥ 第二个样本的色相接近蓝', `hue=${s3.cur && s3.cur.hue}`);
    const blueSw = await exec(`(() => {
        const bg = getComputedStyle(document.getElementById('pcSwatch')).backgroundColor;
        const m = /rgb\\((\\d+), ?(\\d+), ?(\\d+)\\)/.exec(bg) || [];
        return { bg, r: +m[1], g: +m[2], b: +m[3] };
    })()`);
    check(blueSw.b > 150 && blueSw.r < 100, '⑥ 当前样本色块跟着换色', `bg=${blueSw.bg}`);

    /* ⑦ 滑块写回样本（input 走 rAF 节流、change 同步落地，两条路径都验） */
    await exec(`(() => {
        const h = document.getElementById('slPcH');
        h.value = '50';
        h.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    })()`);
    // 隐藏窗口里 rAF 被降到约 1Hz，这里等够两个节拍，验证节流路径确实会落地
    await sleep(1400);
    const rafH = await exec(`(() => {
        const A = window.App, l = (A.gradeOf(A.image) || {}).samples || [];
        return { dh: l[A._pc.idx] && l[A._pc.idx].dh };
    })()`);
    check(rafH.dh === 50, '⑦ input 节流后写回当前样本', `dh=${rafH.dh}`);

    await exec(`(() => {
        const r = document.getElementById('slPcRange');
        r.value = '60';
        r.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    await sleep(120);
    const afterR = await exec(`(() => {
        const A = window.App, g = A.gradeOf(A.image) || {};
        const l = g.samples || [];
        return { range: l[A._pc.idx] && l[A._pc.idx].range, dh0: l[0] && l[0].dh,
                 lbl: document.getElementById('lblPcRange').textContent };
    })()`);
    check(afterR.range === 60, '⑦ 范围滑块写回当前样本', `range=${afterR.range}`);
    check(afterR.dh0 === 0, '⑦ 没动过的样本保持不动', `dh0=${afterR.dh0}`);
    check(afterR.lbl === '60', '⑦ 范围标签同步', `lbl=${afterR.lbl}`);
    await exec(`(() => {
        const h = document.getElementById('slPcH');
        h.value = '50';
        h.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    await sleep(120);
    const afterH = await exec(`(() => {
        const A = window.App, l = (A.gradeOf(A.image) || {}).samples || [];
        return { dh: l[A._pc.idx] && l[A._pc.idx].dh,
                 lbl: document.getElementById('lblPcH').textContent };
    })()`);
    check(afterH.dh === 50 && afterH.lbl === '+50', '⑦ 松手后色相立即落地并同步标签',
        `dh=${afterH.dh} lbl=${afterH.lbl}`);

    /* ⑧ 列表展开 / 删除 */
    const listState = await exec(`(() => {
        document.getElementById('btnPcList').click();
        const box = document.getElementById('pcList');
        const items = box.querySelectorAll('.pc-item');
        return { hidden: box.hasAttribute('hidden'), items: items.length,
                 expanded: document.getElementById('btnPcList').getAttribute('aria-expanded') };
    })()`);
    check(listState.hidden === false && listState.items === 2, '⑧ 样本列表可展开并列出两条',
        `hidden=${listState.hidden} items=${listState.items}`);
    check(listState.expanded === 'true', '⑧ 展开按钮 aria-expanded 同步', `aria=${listState.expanded}`);

    await exec(`(() => {
        const b = document.querySelector('#pcList .pc-item[data-i="1"] .pc-del');
        if (b) b.click();
        return true;
    })()`);
    await sleep(120);
    const afterDel = await exec(stateJs);
    check(afterDel.n === 1 && afterDel.idx === 0, '⑧ 删除后只剩一条且选中项归位', `n=${afterDel.n} idx=${afterDel.idx}`);
    check(String(afterDel.status).indexOf('删除') >= 0, '⑧ 状态栏提示已删除', `status=${afterDel.status}`);

    /* ⑨ 中性灰取不到（取失败保持取样态，方便接着再点） */
    await exec(`document.getElementById('btnPcPick').click()`);
    await exec(clickJs(0.87, 0.5));
    await sleep(80);
    const gray = await exec(stateJs);
    check(gray.n === 1, '⑨ 中性灰不建样本，也不会把删掉的样本带回来', `n=${gray.n}`);
    check(String(gray.status).indexOf('中性灰') >= 0, '⑨ 说明为什么取不到', `status=${gray.status}`);
    check(gray.on === true, '⑨ 取失败时保持在取样态，可以接着再点', `on=${gray.on}`);
    await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

    /* ⑩ 切回混色器页（仍然摘掉 mix-na，否则两条子页都会被环境禁用） */
    const back = await exec(`(() => {
        document.getElementById('grpMix').classList.remove('mix-na');
        const b = Array.prototype.slice.call(document.querySelectorAll('#mixTabs .mix-tab'))
            .find((x) => x.dataset.tab === 'mix');
        b.click();
        const rows = document.getElementById('mixRows');
        const pc = document.getElementById('pcPanel');
        const r = rows.getBoundingClientRect(), p = pc.getBoundingClientRect();
        return { tab: document.getElementById('grpMix').dataset.tab,
                 rowsH: Math.round(r.height), pcH: Math.round(p.height) };
    })()`);
    check(back.tab === 'mix' && back.rowsH > 0 && back.pcH === 0, '⑩ 切回混色器页后 8 条色带行照常显示',
        `tab=${back.tab} rowsH=${back.rowsH} pcH=${back.pcH}`);

    /* ⑪ 管线接线 */
    const pipe0 = await exec(`(() => {
        const A = window.App, im = A.image;
        const g = A.gradeOf(im) || {};
        const l = g.samples || [];
        return { samples: l.length, dh: l[0] && l[0].dh, low: !!(im._grade && im._grade.low),
                 neutral: !!(im._grade && im._grade.neutral) };
    })()`);
    check(pipe0.samples === 1 && pipe0.dh === 0, '⑪ 样本随 grade 一起存下来了', `n=${pipe0.samples} dh=${pipe0.dh}`);
    // 样本四档全 0 时不产生位移，管线会走中性短路（这是有意的省算），这里补一档验证真的会烘
    await exec(`(() => { const h = document.getElementById('slPcH'); h.value = '30';
        h.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(140);
    const pipe = await exec(`(() => {
        const A = window.App, im = A.image;
        return { dh: ((A.gradeOf(im) || {}).samples || [])[0].dh,
                 low: !!(im._grade && im._grade.low), neutral: !!(im._grade && im._grade.neutral) };
    })()`);
    check(pipe.dh === 30 && pipe.low === true && pipe.neutral === false,
        '⑪ 带位移的样本触发重新烘焙', `dh=${pipe.dh} low=${pipe.low} neutral=${pipe.neutral}`);

    /* ⑫ GL pass：只动目标颜色（需要 WebGL） */
    const glOk = await exec(`!!(window.QfsMix && window.QfsMix.available())`);
    if (!glOk) {
        skip('⑫ 前置 GL pass 的像素验证（本环境没有 WebGL）');
    } else {
        const px = await exec(`(() => {
            const c = document.createElement('canvas');
            c.width = 400; c.height = 100;
            const g = c.getContext('2d');
            g.fillStyle = '#e02020'; g.fillRect(0, 0, 200, 100);
            g.fillStyle = '#2040e0'; g.fillRect(200, 0, 200, 100);
            const out = window.QfsMix.pass(c, {}, [{
                hue: 0, sat: 0.9, light: 0.45, range: 40, dh: 50, ds: 20, dl: 0, dv: 0
            }], 400, 100, false);
            if (!out) return { pass: false };
            // pass 交回的是 WebGL canvas，取不到 2d 上下文，先 drawImage 到普通画布再读点
            const o2 = document.createElement('canvas');
            o2.width = 400; o2.height = 100;
            const o = o2.getContext('2d');
            o.drawImage(out, 0, 0);
            const a = o.getImageData(50, 50, 1, 1).data;
            const b = o.getImageData(300, 50, 1, 1).data;
            return { pass: true, red: [a[0], a[1], a[2]], blue: [b[0], b[1], b[2]] };
        })()`);
        const redMoved = px.pass && (Math.abs(px.red[0] - 224) + Math.abs(px.red[1] - 32) + Math.abs(px.red[2] - 32) > 12);
        const blueKept = px.pass && (Math.abs(px.blue[0] - 32) <= 3 && Math.abs(px.blue[1] - 64) <= 3 && Math.abs(px.blue[2] - 224) <= 3);
        check(redMoved, '⑫ 样本只改目标色（红色被拉动）', `red=${px.red}`);
        check(blueKept, '⑫ 邻近色不受影响（蓝色保持）', `blue=${px.blue}`);
    }

    console.log('────────────────────────────────────────────────────────────');
    if (skips.length) console.log(`SKIP ${skips.length} 项（环境不支持，见上）`);
    console.log(failures.length ? `FAILED: ${failures.length}` : 'ALL PASS');
    app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(main).catch((e) => {
    console.error(e);
    app.exit(1);
});
