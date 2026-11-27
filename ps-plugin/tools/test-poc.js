'use strict';
/* 用 Electron 模拟 Photoshop 宿主，验证 CEP 面板的整条渲染/写回链路。
   用法：node tools/run-electron.js ps-plugin/tools/test-poc.js */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const TMP = 'C:/Users/lumos/AppData/Local/Temp/opencode/';

const fails = [];
function check(ok, label, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' | ' + extra : ''}`);
    if (!ok) fails.push(label);
}

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 360, height: 600, show: false,
        webPreferences: { contextIsolation: false, nodeIntegration: false } });
    const errors = [];
    win.webContents.on('console-message', (_e, level, message) => {
        if (level >= 2 && !/Electron Security Warning|Content Security Policy|willReadFrequently/.test(message)) {
            errors.push(message);
        }
    });
    await win.loadURL(PAGE);
    await new Promise((r) => setTimeout(r, 500));

    const r = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const prefix = ${JSON.stringify(TMP)};
        const source = prefix + 'ps-poc-source.png';
        window.qfMockPlaced = [];
        window.qfMockFiles = {};
        window.qfMockHost = {
            tempPath: (name) => prefix + name,
            read: (p, cb) => cb(window.qfMockFiles[p] || null),
            write: (p, b64, cb) => { window.qfMockFiles[p] = b64; cb(true); },
            eval: (src, cb) => {
                const m = /qfGetLayerPng\\("([^"]+)"\\)/.exec(src);
                if (m) { cb('OK:800x1000'); return; }
                const p = /qfPlacePng\\("([^"]+)","([^"]+)","([^"]+)","([^"]+)"\\)/.exec(src);
                if (p) { window.qfMockPlaced.push({ path: p[1], name: p[2], hide: p[3], smart: p[4] }); cb('OK:' + p[2]); return; }
                if (/qfGetDocPath/.test(src)) { cb('OK:' + prefix + 'exif-source.jpg|Adobe RGB (1998)'); return; }
                cb('ERR:unknown script');
            }
        };
        // 生成模拟「当前图层」
        const c = document.createElement('canvas'); c.width = 800; c.height = 1000;
        const g = c.getContext('2d');
        const gr = g.createLinearGradient(0, 0, 800, 1000);
        gr.addColorStop(0, '#c9624e'); gr.addColorStop(1, '#3d7a83');
        g.fillStyle = gr; g.fillRect(0, 0, 800, 1000);
        window.qfMockFiles[prefix + 'qingframe-source.jpg'] = c.toDataURL('image/jpeg').split(',')[1];
        window.qfMockFiles[prefix + 'exif-source.jpg'] = c.toDataURL('image/jpeg').split(',')[1];
        window.__parseExif = () => ({
            0x010F: 'SONY', 0x0110: 'ILCE-6000',
            0x829A: { num: 1, den: 125 }, 0x829D: { num: 56, den: 10 },
            0x8827: 100, 0x920A: { num: 35, den: 1 }, 0xA405: 52
        });
        await window.QF_PS_POC.detectExif();
        const profileAuto = document.getElementById('selColorSpace').value;
        window.QF_PS_POC.applyDocProfile('sRGB IEC61966-2.1');
        const srgbAuto = document.getElementById('selColorSpace').value;
        window.QF_PS_POC.applyDocProfile('Adobe RGB (1998)');
        const exifText = Array.from(document.querySelectorAll('[data-exif]'))
            .map((el) => el.value).join(' · ');
        const brandInput = document.querySelector('[data-exif="make"]');
        if (brandInput) { brandInput.value = 'CANON'; brandInput.dispatchEvent(new Event('input', { bubbles: true })); }

        await wait(2500); // 等缩略图墙生成
        const wallCount = document.querySelectorAll('[data-wall]').length;
        const thumbImgs = document.querySelectorAll('#presetWall img').length;
        const thumbErr = (window.QF_PS_POC.thumbErrors || []).filter(Boolean).slice(0, 3);
        const presets = window.QF_PRESETS || [];
        const sel = document.getElementById('preset');
        if (sel) {
            sel.value = '1'; // 无相框风格：填充/描边/阴影这些控件才有效
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const bpCount = document.querySelectorAll('[data-bp]').length;
        const tpCount = document.querySelectorAll('#textParams [data-tp]').length;
        const textInput = document.querySelector('#textParams [data-tp="0"]');
        if (textInput) { textInput.value = '编辑后的文字'; textInput.dispatchEvent(new Event('input', { bubbles: true })); }
        const editedLine = ((window.QF_TextParams.current() || {}).decorConfig || {}).textLines || [];
        const lineText = editedLine.length ? editedLine[0].text : '';
        const paramGroup = Array.from(document.querySelectorAll('#textParams details'))
            .find((d) => d.querySelector('summary') && d.querySelector('summary').textContent === '参数文字');
        const paramInputs = paramGroup ? paramGroup.querySelectorAll('[data-tp]') : [];
        if (paramInputs[0]) { paramInputs[0].value = '88'; paramInputs[0].dispatchEvent(new Event('input', { bubbles: true })); }
        if (paramInputs[1]) { paramInputs[1].value = 'CUSTOMMODEL'; paramInputs[1].dispatchEvent(new Event('input', { bubbles: true })); }
        const signGroup = Array.from(document.querySelectorAll('#textParams details'))
            .find((d) => d.querySelector('summary') && d.querySelector('summary').textContent === '个性签名');
        const signCtls = signGroup ? signGroup.querySelectorAll('[data-tp]').length : 0;
        const signInput = signGroup ? signGroup.querySelector('[data-tp]') : null;
        if (signInput) { signInput.value = '个性签名测试'; signInput.dispatchEvent(new Event('input', { bubbles: true })); }
        const hasAvatarBtn = !!(signGroup && signGroup.querySelector('#btnPickAvatar'));
        const tpTpl = window.QF_TextParams.current() || {};
        const paramFontSize = tpTpl.paramFontSize;
        const paramModel = (tpTpl.manualExif || {}).model;
        const blurCount = document.querySelectorAll('[data-bp^="blur-"]').length;
        const blurChk = document.querySelector('[data-bp="blur-开启背景模糊"]');
        if (blurChk) { blurChk.checked = true; blurChk.dispatchEvent(new Event('change', { bubbles: true })); }
        const blurOn = ((window.QF_BorderParams.current() || {}).baseMargin || {}).bgBlurEnable;
        const swInput = document.querySelector('[data-bp="stroke-宽度"]');
        if (swInput) { swInput.value = '40'; swInput.dispatchEvent(new Event('input', { bubbles: true })); }
        const tpl0 = window.QF_BorderParams.current() || {};
        const strokeWidth = ((tpl0.layerList || [])[0] || {}).strokeConfig
            ? tpl0.layerList[0].strokeConfig.strokeWidth : null;
        document.getElementById('btnBorder').click();
        await wait(1200);
        const logText = document.getElementById('log').textContent;

        // 第二次套用应命中缓存，不再从 PS 重新导出源图
        document.getElementById('btnBorder').click();
        await wait(800);
        const cachedLog = document.getElementById('log').textContent;

        return {
            cachedLog,
            presets: presets.length, wallCount, thumbImgs, thumbErr,
            hasRender: typeof window.__render === 'function',
            bpCount, strokeWidth, blurCount, blurOn, tpCount, lineText, signCtls, hasAvatarBtn,
            signText: tpTpl.userSignature, paramFontSize, paramModel, exifText, profileAuto, srgbAuto,
            exifBrand: ((window.QF_PS_POC.lastTemplate() || {}).manualExif || {}).brand,
            previewW: document.getElementById('previewCanvas').width,
            hasLive: typeof window.QF_PS_POC.renderPreviewLive === 'function',
            hasEmbedApi: typeof window.QF_IccEmbed === 'object' && typeof window.QF_IccEmbed.embed === 'function',
            iccLen: (window.QF_ICC_ADOBERGB || '').length,
            logText, placed: window.qfMockPlaced,
            outputs: window.qfMockPlaced.map((p) => {
                const b64 = window.qfMockFiles[p.path] || '';
                const head = (() => { try { return atob(b64).slice(0, 60); } catch (e) { return ''; } })();
                let hasIcc = false;
                try {
                    const bin = atob(b64);
                    for (let i = 0; i < bin.length - 12; i++) {
                        if (bin.charCodeAt(i) === 0xE2 && bin.substr(i + 3, 11) === 'ICC_PROFILE') {
                            hasIcc = true; break;
                        }
                    }
                } catch (e) { /* 忽略 */ }
                return { len: b64.length, jpeg: /^\\/9j\\//.test(b64), hasIcc, head: head.replace(/[^\x20-\x7e]/g, '.') };
            }),
            canvas: document.getElementById('renderCanvas').width + 'x' + document.getElementById('renderCanvas').height
        };
    })()`);

    console.log(JSON.stringify(r, null, 2));
    check(r.presets === 91 && r.hasRender, '引擎与预设已加载', JSON.stringify({ presets: r.presets, hasRender: r.hasRender }));
    check(r.wallCount === 91 && r.thumbImgs === 91, '风格缩略图墙已生成', JSON.stringify({ wall: r.wallCount, thumbs: r.thumbImgs }));
    check(r.bpCount >= 15 && r.strokeWidth === 40, '边框参数面板可改模板', JSON.stringify({ bpCount: r.bpCount, strokeWidth: r.strokeWidth }));
    check(r.blurCount > 0 && r.blurOn === 1, '背景模糊参数可开启', JSON.stringify({ blurCount: r.blurCount, blurOn: r.blurOn }));
    check(r.tpCount > 0 && r.lineText === '编辑后的文字', '预设文字可编辑', JSON.stringify({ tpCount: r.tpCount, lineText: r.lineText }));
    check(r.signCtls >= 7 && r.hasAvatarBtn && r.signText === '个性签名测试', '个性签名（含头像）可编辑',
        JSON.stringify({ signCtls: r.signCtls, hasAvatarBtn: r.hasAvatarBtn, signText: r.signText }));
    check(r.paramFontSize === 88 && r.paramModel === 'CUSTOMMODEL', '参数字号与相机型号可调', JSON.stringify({ paramFontSize: r.paramFontSize, paramModel: r.paramModel }));
    check(['ILCE-6000', '35mm', 'f/5.6', '1/125s', 'ISO100']
        .every((s) => r.exifText.indexOf(s) >= 0), '自动识别 EXIF 拍摄参数', r.exifText);
    check(r.profileAuto === 'adobergb' && r.srgbAuto === 'srgb', '按文档色彩配置自动选输出色域',
        JSON.stringify({ profileAuto: r.profileAuto, srgbAuto: r.srgbAuto }));
    check(r.exifBrand === 'CANON', '相机参数可手动修改并写回模板', String(r.exifBrand));
    check(r.hasLive && r.previewW > 0, '实时预览画布已渲染', JSON.stringify({ hasLive: r.hasLive, previewW: r.previewW }));
    check(/放回文档：OK/.test(r.logText), '边框渲染并写回图层', r.logText.split('\n').slice(-2).join(' / '));
    check(r.placed.length >= 1 && r.placed[0].name === '清框影边框',
        '写回边框图层', JSON.stringify(r.placed.map((p) => p.name)));
    check(/缓存/.test(r.cachedLog), '重复套用命中源图缓存', r.cachedLog.split('\n')[0]);
    check(r.placed.every((p) => p.hide === 'true'), '隐藏原图层参数已传给 PS', JSON.stringify(r.placed.map((p) => p.hide)));
    check(r.placed.every((p) => p.smart === 'true'), '智能对象参数已传给 PS', JSON.stringify(r.placed.map((p) => p.smart)));
    check(r.outputs.every((f) => f.len > 10000 && f.jpeg && f.hasIcc), '写回的是带 Adobe RGB ICC 的 JPEG', JSON.stringify(r.outputs));
    check(errors.length === 0, '无控制台错误', errors.slice(0, 3).join(' / '));

    win.destroy();
    app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });
