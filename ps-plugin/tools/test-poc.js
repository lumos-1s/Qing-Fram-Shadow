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
                const key = 'OK:800x1000|' + prefix + 'exif-source.jpg|1|Layer 1';
                if (/qfGetDocKey/.test(src)) { cb(key); return; }
                const m = /qfGetLayerPng\\("([^"]+)"\\)/.exec(src);
                if (m) {
                    // 面板每次导出用新的临时文件名，mock 也要按实际路径回填
                    window.qfMockFiles[m[1]] = window.qfMockSourceB64;
                    cb(key); return;
                }
                const p = /qfPlacePng\\("([^"]+)","([^"]+)","([^"]+)","([^"]+)","([^"]+)",([^,]+),([^,]+),([^)]+)\\)/.exec(src);
                if (p) { window.qfMockPlaced.push({ path: p[1], name: p[2], hide: p[3], smart: p[4], fit: p[5], out: p[6] + 'x' + p[7], canvasFit: p[8] }); cb('OK:' + p[2]); return; }
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
        window.qfMockSourceB64 = c.toDataURL('image/jpeg').split(',')[1];
        window.qfMockFiles[prefix + 'qingframe-source.jpg'] = window.qfMockSourceB64;
        window.qfMockFiles[prefix + 'exif-source.jpg'] = window.qfMockSourceB64;
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

        await wait(200);
        const wallCount = document.querySelectorAll('[data-wall]').length;
        const thumbImgs = document.querySelectorAll('#presetWall img').length;
        const presets = window.QF_PRESETS || [];
        window.QF_PS_POC.searchPresets('背景模糊');
        const filteredWall = Array.from(document.querySelectorAll('[data-wall]'))
            .filter((b) => !b.hidden).length;
        window.QF_PS_POC.searchPresets('');
        const sel = document.getElementById('preset');
        const groupByTitle = (title) => Array.from(document.querySelectorAll('#textParams details'))
            .find((d) => d.querySelector('summary') && d.querySelector('summary').textContent === title);

        // 签名控件只在支持签名/头像的风格里出现
        sel.value = '71'; sel.dispatchEvent(new Event('change', { bubbles: true }));
        const signGroup = groupByTitle('个性签名');
        const signCtls = signGroup ? signGroup.querySelectorAll('[data-tp]').length : 0;
        const signInput = signGroup ? signGroup.querySelector('[data-tp]') : null;
        const defaultSignature = (window.QF_BorderParams.current() || {}).userSignature || '';
        if (signInput) { signInput.value = '个性签名测试'; signInput.dispatchEvent(new Event('input', { bubbles: true })); }
        const hasAvatarBtn = !!(signGroup && signGroup.querySelector('#btnPickAvatar'));
        const signText = ((window.QF_TextParams.current() || {}).userSignature) || '';

        // 背景模糊控件只在实测支持的风格里出现
        sel.value = '77'; sel.dispatchEvent(new Event('change', { bubbles: true }));
        const blurCount = document.querySelectorAll('[data-bp^="blur-"]').length;
        const blurChk = document.querySelector('[data-bp="blur-开启背景模糊"]');
        if (blurChk) { blurChk.checked = true; blurChk.dispatchEvent(new Event('change', { bubbles: true })); }
        const blurOn = ((window.QF_BorderParams.current() || {}).baseMargin || {}).bgBlurEnable;

        // 液态玻璃：玻璃条大小可调，且不该出现签名/头像控件（模糊是真实用到的）
        sel.value = '55'; sel.dispatchEvent(new Event('change', { bubbles: true }));
        const glassSlider = document.querySelector('[data-bp="style-liquidGlassSize"]');
        const glassDate = document.querySelector('[data-bp="style-liquidGlassDate"]');
        if (glassSlider) { glassSlider.value = '150'; glassSlider.dispatchEvent(new Event('input', { bubbles: true })); }
        const glassSize = (window.QF_BorderParams.current() || {}).liquidGlassSize;
        const signHiddenOnGlass = !groupByTitle('个性签名');

        // 其它风格的专属字段也要有控件，并写回引擎认的口径
        const findCtl = (group, label) => {
            const rows = group ? Array.from(group.querySelectorAll('.exif-row')) : [];
            const row = rows.find((r) => r.querySelector('label')
                && r.querySelector('label').textContent === label);
            return row ? row.querySelector('[data-tp]') : null;
        };
        sel.value = '6'; sel.dispatchEvent(new Event('change', { bubbles: true }));
        const brandGroup = groupByTitle('风格专属');
        const brandSizeEl = findCtl(brandGroup, '品牌大小');
        if (brandSizeEl) { brandSizeEl.value = '150'; brandSizeEl.dispatchEvent(new Event('input', { bubbles: true })); }
        const brandSize = (window.QF_TextParams.current() || {}).brandSize;

        sel.value = '83'; sel.dispatchEvent(new Event('change', { bubbles: true }));
        const appleModelEl = findCtl(groupByTitle('风格专属'), '型号字号');
        if (appleModelEl) { appleModelEl.value = '120'; appleModelEl.dispatchEvent(new Event('input', { bubbles: true })); }
        const appleModelScale = (((window.QF_TextParams.current() || {}).appleCard || {}).modelScale);

        sel.value = '76'; sel.dispatchEvent(new Event('change', { bubbles: true }));
        const xmTrackEl = findCtl(groupByTitle('风格专属'), '字标字距');
        if (xmTrackEl) { xmTrackEl.value = '20'; xmTrackEl.dispatchEvent(new Event('input', { bubbles: true })); }
        const xmTracking = (((window.QF_TextParams.current() || {}).xmLeica || {}).brandTracking);

        // 无相框风格：填充/描边/阴影、文字、边框参数都可用
        sel.value = '1'; sel.dispatchEvent(new Event('change', { bubbles: true }));
        const bpCount = document.querySelectorAll('[data-bp]').length;
        const tpCount = document.querySelectorAll('#textParams [data-tp]').length;
        const textInput = document.querySelector('#textParams [data-tp="0"]');
        if (textInput) { textInput.value = '编辑后的文字'; textInput.dispatchEvent(new Event('input', { bubbles: true })); }
        const editedLine = ((window.QF_TextParams.current() || {}).decorConfig || {}).textLines || [];
        const lineText = editedLine.length ? editedLine[0].text : '';
        const paramGroup = groupByTitle('参数文字');
        const paramInputs = paramGroup ? paramGroup.querySelectorAll('[data-tp]') : [];
        if (paramInputs[0]) { paramInputs[0].value = '88'; paramInputs[0].dispatchEvent(new Event('input', { bubbles: true })); }
        if (paramInputs[1]) { paramInputs[1].value = 'CUSTOMMODEL'; paramInputs[1].dispatchEvent(new Event('input', { bubbles: true })); }
        const tpTpl = window.QF_TextParams.current() || {};
        const paramFontSize = tpTpl.paramFontSize;
        const paramModel = (tpTpl.manualExif || {}).model;
        // 不支持的风格必须把控件收起来，不能摆死滑块
        const signHiddenOnPlain = !groupByTitle('个性签名');
        const blurHiddenOnPlain = document.querySelectorAll('[data-bp^="blur-"]').length === 0;
        const bpTotal = document.querySelectorAll('[data-bp]').length;
        const swInput = document.querySelector('[data-bp="stroke-宽度"]');
        if (swInput) { swInput.value = '40'; swInput.dispatchEvent(new Event('input', { bubbles: true })); }
        const tpl0 = window.QF_BorderParams.current() || {};
        const strokeWidth = ((tpl0.layerList || [])[0] || {}).strokeConfig
            ? tpl0.layerList[0].strokeConfig.strokeWidth : null;

        // 每个预设各自记住参数：切走再切回，编辑值应还原
        await wait(400);
        sel.value = '0'; sel.dispatchEvent(new Event('change', { bubbles: true }));
        sel.value = '1'; sel.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(100);
        const strokeEl = document.querySelector('[data-bp="stroke-宽度"]');
        const rememberedStroke = strokeEl ? strokeEl.value : null;

        await wait(200); // 让切换预设可能排队的预览先渲完，避免计入套用
        const origApplyRender = window.__render;
        let applyRenderCount = 0;
        window.__render = function () { applyRenderCount++; return origApplyRender.apply(this, arguments); };
        document.getElementById('btnBorder').click();
        for (let i = 0; i < 100 && window.QF_PS_POC.isBusy(); i++) await wait(100);
        await wait(150);
        window.__render = origApplyRender;
        const logText = document.getElementById('log').textContent;
        const statusText = document.getElementById('status').textContent;
        // 套用时必须拿面板里正在编辑的模板，不能重新克隆预设把改动冲掉
        const applied0 = window.QF_PS_POC.lastTemplate() || {};
        const appliedStroke = ((applied0.layerList || [])[0] || {}).strokeConfig
            ? applied0.layerList[0].strokeConfig.strokeWidth : null;
        const appliedSign = applied0.userSignature;
        const appliedModel = (applied0.manualExif || {}).model;
        const appliedRatio = applied0.canvasRatio;
        const canvasAtApply = document.getElementById('renderCanvas').width + 'x'
            + document.getElementById('renderCanvas').height;

        // 液态玻璃是重风格：连续拖滑块只应渲染一次（停手后的那一次）
        sel.value = '55'; sel.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(250);
        const origRender = window.__render;
        let heavyCount = 0;
        window.__render = function () { heavyCount++; return origRender.apply(this, arguments); };
        const heavyEl = document.querySelector('[data-bp="style-liquidGlassSize"]');
        for (let i = 0; i < 8; i++) {
            if (!heavyEl) break;
            heavyEl.value = String(100 + i * 10);
            heavyEl.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(25);
        }
        await wait(300);
        const heavyRenderCount = heavyCount;
        window.__render = origRender;

        // 第二次套用应命中缓存，不再从 PS 重新导出源图
        document.getElementById('btnBorder').click();
        for (let i = 0; i < 100 && window.QF_PS_POC.isBusy(); i++) await wait(100);
        await wait(150);
        const cachedLog = document.getElementById('log').textContent;

        // 回到无相框预设再验证重置（液态玻璃那边没有描边滑块）
        sel.value = '1'; sel.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(120);
        window.QF_PS_POC.resetCurrent();
        const strokeAfterReset = document.querySelector('[data-bp="stroke-宽度"]').value;
        const editsAfterReset = JSON.parse(localStorage.getItem('qfs_preset_edits_v1') || '{}');
        const hasSavedEdit = Object.keys(editsAfterReset).some((k) => k.indexOf('Canva错位拼贴') === 0);

        return {
            cachedLog, statusText, filteredWall, strokeAfterReset, rememberedStroke, hasSavedEdit,
            appliedStroke, appliedSign, appliedModel, appliedRatio, canvasAtApply, heavyRenderCount, applyRenderCount,
            presets: presets.length, wallCount, thumbImgs,
            hasRender: typeof window.__render === 'function',
            bpCount, bpTotal, strokeWidth, blurCount, blurOn, tpCount, lineText, signCtls, hasAvatarBtn, defaultSignature,
            signHiddenOnPlain, blurHiddenOnPlain, signText, paramFontSize, paramModel, exifText, profileAuto, srgbAuto,
            glassSlider: !!glassSlider, glassDate: !!glassDate, glassSize, signHiddenOnGlass,
            brandSize, appleModelScale, xmTracking,
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
    check(r.wallCount === 91 && r.thumbImgs === 0, '风格列表为纯文字按钮', JSON.stringify({ buttons: r.wallCount, images: r.thumbImgs }));
    check(r.filteredWall >= 2, '风格搜索可过滤', String(r.filteredWall));
    check(r.bpCount >= 15 && r.strokeWidth === 40, '边框参数面板可改模板', JSON.stringify({ bpCount: r.bpCount, strokeWidth: r.strokeWidth }));
    check(r.blurCount > 0 && r.blurOn === 1, '背景模糊参数可开启', JSON.stringify({ blurCount: r.blurCount, blurOn: r.blurOn }));
    check(r.signHiddenOnPlain && r.blurHiddenOnPlain, '不支持的风格隐藏签名/模糊控件',
        JSON.stringify({ signHidden: r.signHiddenOnPlain, blurHidden: r.blurHiddenOnPlain }));
    check(r.glassSlider && r.glassDate && r.glassSize === 1.5 && r.signHiddenOnGlass,
        '液态玻璃有玻璃条大小/日期开关且无签名控件',
        JSON.stringify({ slider: r.glassSlider, date: r.glassDate, size: r.glassSize, signHidden: r.signHiddenOnGlass }));
    check(r.brandSize === 1.5 && r.appleModelScale === 1.2 && r.xmTracking === 0.2,
        '其它风格的专属字段可改且按引擎口径写回',
        JSON.stringify({ brand: r.brandSize, apple: r.appleModelScale, xm: r.xmTracking }));
    check(r.tpCount > 0 && r.lineText === '编辑后的文字', '预设文字可编辑', JSON.stringify({ tpCount: r.tpCount, lineText: r.lineText }));
    check(!!r.defaultSignature, '空签名预设自动补默认签名', String(r.defaultSignature));
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
    check(/已放回文档/.test(r.statusText), '状态栏显示写回结果', r.statusText);
    check(r.appliedStroke === 40 && r.appliedSign === '个性签名测试' && r.appliedModel === 'CUSTOMMODEL',
        '套用时使用面板当前编辑值', JSON.stringify({ stroke: r.appliedStroke, sign: r.appliedSign, model: r.appliedModel }));
    check(r.heavyRenderCount === 1, '液态玻璃连续调参只渲染一次', String(r.heavyRenderCount));
    check(r.applyRenderCount === 1, '套用只跑一次引擎（预览复用成品）', String(r.applyRenderCount));
    check(r.appliedRatio === 'original', '边框画布比例按预设，不扩成文档比例', String(r.appliedRatio));
    check(r.rememberedStroke === '40', '切走再切回还原该预设的参数', r.rememberedStroke);
    check(r.strokeAfterReset === '0' && !r.hasSavedEdit, '重置会清除该预设的记忆',
        JSON.stringify({ stroke: r.strokeAfterReset, saved: r.hasSavedEdit }));
    check(r.placed.every((p) => p.hide === 'true'), '隐藏原图层参数已传给 PS', JSON.stringify(r.placed.map((p) => p.hide)));
    check(r.placed.every((p) => p.smart === 'true'), '智能对象参数已传给 PS', JSON.stringify(r.placed.map((p) => p.smart)));
    check(r.placed.every((p) => p.fit === 'false'), '默认不缩放铺满文档', JSON.stringify(r.placed.map((p) => p.fit)));
    check(r.placed[0].canvasFit === 'true' && r.placed[0].out === r.canvasAtApply,
        '画布按预设尺寸调整，成品不缩放不裁切',
        JSON.stringify({ out: r.placed[0].out, canvas: r.canvasAtApply, fit: r.placed[0].canvasFit }));
    check(r.outputs.every((f) => f.len > 10000 && f.jpeg && f.hasIcc), '写回的是带 Adobe RGB ICC 的 JPEG', JSON.stringify(r.outputs));
    check(errors.length === 0, '无控制台错误', errors.slice(0, 3).join(' / '));

    win.destroy();
    app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });
