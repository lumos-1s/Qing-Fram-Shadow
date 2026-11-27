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
        if (level >= 2 && !/Electron Security Warning|Content Security Policy/.test(message)) errors.push(message);
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

        const presets = window.QF_PRESETS || [];
        const sel = document.getElementById('preset');
        if (sel) sel.value = '0';
        document.getElementById('btnBorder').click();
        await wait(1200);
        const logText = document.getElementById('log').textContent;

        return {
            presets: presets.length,
            hasRender: typeof window.__render === 'function',
            logText, placed: window.qfMockPlaced,
            outputs: window.qfMockPlaced.map((p) => {
                const b64 = window.qfMockFiles[p.path] || '';
                return { len: b64.length, png: /^iVBORw0KGgo/.test(b64) };
            }),
            canvas: document.getElementById('renderCanvas').width + 'x' + document.getElementById('renderCanvas').height
        };
    })()`);

    console.log(JSON.stringify(r, null, 2));
    check(r.presets === 91 && r.hasRender, '引擎与预设已加载', JSON.stringify({ presets: r.presets, hasRender: r.hasRender }));
    check(/放回文档：OK/.test(r.logText), '边框渲染并写回图层', r.logText.split('\n').slice(-2).join(' / '));
    check(r.placed.length === 1 && r.placed[0].name === '清框影边框',
        '只写回一层边框', JSON.stringify(r.placed.map((p) => p.name)));
    check(r.outputs.every((f) => f.len > 10000 && f.png), '写回的是有效 PNG', JSON.stringify(r.outputs));
    check(errors.length === 0, '无控制台错误', errors.slice(0, 3).join(' / '));

    win.destroy();
    app.exit(fails.length ? 1 : 0);
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });
