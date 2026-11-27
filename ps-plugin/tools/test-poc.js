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
                const p = /qfPlacePng\\("([^"]+)","([^"]+)"\\)/.exec(src);
                if (p) { window.qfMockPlaced.push({ path: p[1], name: p[2] }); cb('OK:' + p[2]); return; }
                if (/qfGetDocPath/.test(src)) { cb('OK:' + prefix + 'exif-source.jpg'); return; }
                cb('ERR:unknown script');
            }
        };
        // 生成模拟「当前图层」
        const c = document.createElement('canvas'); c.width = 800; c.height = 1000;
        const g = c.getContext('2d');
        const gr = g.createLinearGradient(0, 0, 800, 1000);
        gr.addColorStop(0, '#c9624e'); gr.addColorStop(1, '#3d7a83');
        g.fillStyle = gr; g.fillRect(0, 0, 800, 1000);
        window.qfMockFiles[prefix + 'qingframe-source.png'] = c.toDataURL('image/png').split(',')[1];
        window.qfMockFiles[prefix + 'exif-source.jpg'] = c.toDataURL('image/jpeg').split(',')[1];
        window.__parseExif = () => ({
            0x010F: 'SONY', 0x0110: 'ILCE-6000',
            0x829A: { num: 1, den: 125 }, 0x829D: { num: 56, den: 10 },
            0x8827: 100, 0x920A: { num: 35, den: 1 }, 0xA405: 52
        });
        await window.QF_PS_POC.detectExif();
        const exifText = document.getElementById('exifText').textContent;

        const presets = window.QF_PRESETS || [];
        const sel = document.getElementById('preset');
        if (sel) sel.value = '0';
        const bpCount = document.querySelectorAll('[data-bp]').length;
        const swInput = document.querySelector('[data-bp="stroke-宽度"]');
        if (swInput) { swInput.value = '40'; swInput.dispatchEvent(new Event('input', { bubbles: true })); }
        const tpl0 = window.QF_BorderParams.current() || {};
        const strokeWidth = ((tpl0.layerList || [])[0] || {}).strokeConfig
            ? tpl0.layerList[0].strokeConfig.strokeWidth : null;
        document.getElementById('btnBorder').click();
        await wait(1200);
        const logText = document.getElementById('log').textContent;

        return {
            presets: presets.length,
            hasRender: typeof window.__render === 'function',
            bpCount, strokeWidth, exifText,
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
    check(r.bpCount >= 15 && r.strokeWidth === 40, '边框参数面板可改模板', JSON.stringify({ bpCount: r.bpCount, strokeWidth: r.strokeWidth }));
    check(['SONY', 'ILCE-6000', '35mm', '52mm', 'f/5.6', '1/125s', 'ISO100']
        .every((s) => r.exifText.indexOf(s) >= 0), '自动识别 EXIF 拍摄参数', r.exifText);
    check(/放回文档：OK/.test(r.logText), '边框渲染并写回图层', r.logText.split('\n').slice(-2).join(' / '));
    check(r.placed.length === 1 && r.placed[0].name === '清框影边框',
        '只写回一层边框', JSON.stringify(r.placed.map((p) => p.name)));
    check(r.outputs.every((f) => f.len > 10000 && f.jpeg && f.hasIcc), '写回的是带 Adobe RGB ICC 的 JPEG', JSON.stringify(r.outputs));
    check(errors.length === 0, '无控制台错误', errors.slice(0, 3).join(' / '));

    win.destroy();
    app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });
