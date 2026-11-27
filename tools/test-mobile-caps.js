'use strict';
// 手机版面板能力对齐：预设不支持的滑块/分组必须收起，别让用户对着无效控件拖。
// 用法：node tools/run-electron.js tools/test-mobile-caps.js
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
            const ph = document.createElement('canvas'); ph.width = 400; ph.height = 300;
            const pg = ph.getContext('2d'); pg.fillStyle = '#889'; pg.fillRect(0, 0, 400, 300);
            ph.naturalWidth = 400; ph.naturalHeight = 300; ph.complete = true;
            window.qfsNative.pickImages = async () => [{ el: ph, name: 'caps.jpg', w: 400, h: 300, grade: null }];
            document.getElementById('btnPick').click();
            await wait(320);

            const presetBy = (name) => (window.QF_PRESETS || []).findIndex(p => p.templateName === name);
            const apply = async (name) => {
                const i = presetBy(name);
                if (i < 0) throw new Error('missing preset ' + name);
                document.querySelector('#tabbar [data-page="home"]').click();
                await wait(160);
                const card = document.querySelector('[data-home-preset="' + i + '"]');
                if (!card) throw new Error('missing card ' + name);
                card.click();
                await wait(280);
            };
            const openEdit = async (sub) => {
                document.querySelector('[data-tab="edit"]').click();
                await wait(160);
                const b = document.querySelector('[data-edit-sub="' + sub + '"]');
                if (b) b.click();
                await wait(220);
            };
            const labels = () => Array.from(document.querySelectorAll('#panel .ctl-row > label'))
                .map(x => x.textContent.trim());
            const groups = () => Array.from(document.querySelectorAll('#panel details > summary'))
                .map(x => x.textContent.trim());

            // 1) 老相册角贴：能力表只认照片圆角 → 边距/缩放不出现
            await apply('老相册角贴');
            await openEdit('border');
            out.albumLabels = labels();
            out.albumGroups = groups();

            // 支持位移的风格：背景模糊-经典要保留「位置微调」
            await apply('背景模糊-经典');
            await openEdit('border');
            out.blurGroups = groups();

            // 2) 赛博故障：五个数值档都支持；相框风格不显示图层四组
            await apply('赛博故障');
            await openEdit('border');
            out.cyberLabels = labels();
            out.cyberGroups = groups();
            out.cyberNote = Array.from(document.querySelectorAll('#panel .panel-note'))
                .map((x) => x.textContent).join(' ');

            // 3) NOMO 是图层模板：填充/描边/边框圆角/阴影都要在
            await apply('NOMO复古相机');
            await openEdit('border');
            out.nomoLabels = labels();
            out.nomoGroups = groups();
            // 打开背景模糊后切到卡片管线，图层四组应立即收起；关掉再回来
            const blurRow = Array.from(document.querySelectorAll('#panel .ctl-row')).find((x) => {
                const l = x.querySelector('label');
                return l && l.textContent.trim() === '开启背景模糊';
            });
            if (blurRow) {
                const cb = blurRow.querySelector('[data-ctl]');
                cb.checked = true;
                cb.dispatchEvent(new Event('change', { bubbles: true }));
                await wait(300);
                out.cardGroups = groups();
                const t2 = Array.from(document.querySelectorAll('#panel .ctl-row')).find((x) => {
                    const l = x.querySelector('label');
                    return l && l.textContent.trim() === '开启背景模糊';
                });
                if (t2) {
                    const cb2 = t2.querySelector('[data-ctl]');
                    cb2.checked = false;
                    cb2.dispatchEvent(new Event('change', { bubbles: true }));
                    await wait(300);
                }
                out.backGroups = groups();
            }
            await openEdit('text');
            out.nomoTextLabels = labels();

            // 4) 签名纪念：署名/头像要有，参数位置不该出现
            await apply('签名纪念');
            await openEdit('text');
            out.signLabels = labels();
            const sigInput = Array.from(document.querySelectorAll('#panel .ctl-row')).find((x) => {
                const l = x.querySelector('label');
                return l && l.textContent.trim() === '署名内容';
            });
            if (sigInput) {
                const inp = sigInput.querySelector('[data-ctl]');
                inp.value = '能力测试署名';
                inp.dispatchEvent(new Event('input', { bubbles: true }));
                await wait(120);
                out.signValue = window.App.template.userSignature;
            }

            // 5) 赛博故障：不画签名，也没有通用 EXIF 参数条
            await apply('赛博故障');
            await openEdit('text');
            out.cyberTextLabels = labels();
            out.cyberTextGroups = groups();
        } catch (e) { out.err = String(e && e.stack || e); }
        return out;
    })()`);

    const has = (list, label) => Array.isArray(list) && list.indexOf(label) >= 0;
    const hasGroup = (list, label) => Array.isArray(list) && list.some((x) => x.indexOf(label) === 0);

    check(!r.err && !has(r.albumLabels, '边距大小') && !has(r.albumLabels, '照片缩放')
        && has(r.albumLabels, '照片圆角') && !hasGroup(r.albumGroups, '位置微调'),
        '老相册角贴：无效的边距/缩放/位移已收起',
        JSON.stringify({ labels: r.albumLabels, groups: r.albumGroups, err: r.err }));
    check(!r.err && hasGroup(r.blurGroups, '位置微调'),
        '背景模糊-经典：支持位移的风格保留位置微调',
        JSON.stringify({ groups: r.blurGroups, err: r.err }));
    check(!r.err && has(r.cyberLabels, '边距大小') && has(r.cyberLabels, '照片缩放')
        && !hasGroup(r.cyberGroups, '填充') && !hasGroup(r.cyberGroups, '描边')
        && !hasGroup(r.cyberGroups, '边框圆角') && !hasGroup(r.cyberGroups, '阴影')
        && !hasGroup(r.cyberGroups, '位置微调') && /由预设自己绘制/.test(r.cyberNote || ''),
        '赛博故障：支持的五档保留，图层四组收起并有说明',
        JSON.stringify({ labels: r.cyberLabels, groups: r.cyberGroups, note: r.cyberNote, err: r.err }));
    check(!r.err && hasGroup(r.nomoGroups, '填充') && hasGroup(r.nomoGroups, '描边')
        && hasGroup(r.nomoGroups, '边框圆角') && hasGroup(r.nomoGroups, '阴影')
        && hasGroup(r.nomoGroups, '位置微调')
        && has(r.nomoLabels, '边距大小') && has(r.nomoLabels, '照片缩放'),
        'NOMO 图层模板：图层组与通用档位都在',
        JSON.stringify({ labels: r.nomoLabels, groups: r.nomoGroups, err: r.err }));
    check(!r.err && !hasGroup(r.cardGroups, '填充') && hasGroup(r.backGroups, '填充'),
        '图层模板开启背景模糊：图层组临时收起，关闭后恢复',
        JSON.stringify({ card: r.cardGroups, back: r.backGroups, err: r.err }));
    check(!r.err && !has(r.nomoTextLabels, '署名内容') && has(r.nomoTextLabels, 'EXIF 参数条')
        && !has(r.nomoTextLabels, '参数字号') && !has(r.nomoTextLabels, '等效焦距'),
        'NOMO 文字页：署名/参数字号/等效焦距这些无效行收起',
        JSON.stringify({ labels: r.nomoTextLabels, err: r.err }));
    check(!r.err && has(r.signLabels, '署名内容') && has(r.signLabels, '头像大小')
        && has(r.signLabels, '参数位置') && !has(r.signLabels, '参数字号')
        && r.signValue === '能力测试署名',
        '签名纪念：署名/头像保留，参数字号收起且署名可写回',
        JSON.stringify({ labels: r.signLabels, sign: r.signValue, err: r.err }));
    check(!r.err && !has(r.cyberTextLabels, '署名内容') && !has(r.cyberTextLabels, 'EXIF 参数条')
        && has(r.cyberTextLabels, '参数字号'),
        '赛博故障文字页：无签名与通用 EXIF 行',
        JSON.stringify({ labels: r.cyberTextLabels, groups: r.cyberTextGroups, err: r.err }));
    check(errors.length === 0, '能力对齐流程无脚本异常', errors.slice(0, 3).join(' / '));

    console.log(fails.length ? `\n${fails.length} FAILURE(S)` : '\nALL PASS');
    win.destroy();
    app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });
