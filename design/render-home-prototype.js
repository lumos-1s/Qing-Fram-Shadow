// 生成首页「看片台」静态原型所需的示例照片与真实预设封面。
// 用法：node tools/run-electron.js design/render-home-prototype.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.join(__dirname, '..');
const PRESET_DIR = path.join(ROOT, 'shared', 'presets');
const OUT_DIR = path.join(__dirname, 'home-prototype-assets');
const COVER_DIR = path.join(OUT_DIR, 'covers');
const SAMPLE_DIR = path.join(OUT_DIR, 'samples');

const ITEMS = [
    { id: 'gallery', title: '画廊留白', category: 'minimal', categoryName: '极简', categories: ['minimal', 'travel'], desc: '干净留白，适合展览与作品集', preset: '画廊留白.json', sample: 'lake' },
    { id: 'torn-film', title: '撕边胶片', category: 'film', categoryName: '胶片', categories: ['film', 'travel'], desc: '不规则撕边，适合街头与旅行', preset: '复古胶片撕裂.json', sample: 'desert' },
    { id: 'newspaper', title: '复古报纸', category: 'magazine', categoryName: '杂志', categories: ['magazine', 'travel'], desc: '旧报纸版式，适合纪实与城市', preset: '复古报纸.json', sample: 'city' },
    { id: 'polaroid', title: '拍立得手写', category: 'retro', categoryName: '复古', categories: ['retro', 'portrait'], desc: '手写留白，适合日常人像', preset: '拍立得手写.json', sample: 'portrait' },
    { id: 'vintage-line', title: '复古双线', category: 'retro', categoryName: '复古', categories: ['retro', 'travel'], desc: '1970s 双线画框，复古耐看', preset: '复古双线.json', sample: 'lake' },
    { id: 'album-corners', title: '老相册角贴', category: 'retro', categoryName: '复古', categories: ['retro', 'portrait'], desc: '相册角贴，适合家庭与纪念', preset: '老相册角贴.json', sample: 'forest' },
    { id: 'vhs', title: 'VHS 录像带', category: 'film', categoryName: '胶片', categories: ['film', 'travel'], desc: '录像带界面，适合夜景与派对', preset: 'VHS录像带.json', sample: 'city' },
    { id: 'magazine', title: '杂志封面', category: 'magazine', categoryName: '杂志', categories: ['magazine', 'portrait'], desc: '大刊头版式，适合人像与时尚', preset: '杂志封面.json', sample: 'portrait' },
    { id: 'minimal-line', title: '极简细线', category: 'minimal', categoryName: '极简', categories: ['minimal', 'art'], desc: '一条细线，适合极简与静物', preset: '极简细线.json', sample: 'still' },
    { id: 'cinema', title: '电影宽银幕', category: 'art', categoryName: '艺术', categories: ['art', 'travel'], desc: '宽银幕比例，适合风景与叙事', preset: '电影宽银幕.json', sample: 'desert' },
    { id: 'cyanotype', title: '蓝晒法', category: 'art', categoryName: '艺术', categories: ['art', 'travel'], desc: '蓝晒工艺，适合植物与建筑', preset: '蓝晒法.json', sample: 'forest' },
    { id: 'gold', title: '金箔奢华', category: 'art', categoryName: '艺术', categories: ['art', 'portrait'], desc: '金箔质感，适合纪念与礼物', preset: '金箔奢华.json', sample: 'still' }
];

const CATEGORIES = [
    { id: 'all', name: '全部' },
    { id: 'portrait', name: '人像' },
    { id: 'travel', name: '旅行' },
    { id: 'film', name: '胶片' },
    { id: 'minimal', name: '极简' },
    { id: 'magazine', name: '杂志' },
    { id: 'retro', name: '复古' },
    { id: 'art', name: '艺术' }
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── IPC：让渲染进程通过现有 presets.js 读取真实预设 ──
ipcMain.handle('list-presets', () => fs.readdirSync(PRESET_DIR).filter(name => name.endsWith('.json')));
ipcMain.handle('load-preset', (_event, name) => {
    try {
        return JSON.parse(fs.readFileSync(path.join(PRESET_DIR, name), 'utf8'));
    } catch (_) {
        return null;
    }
});

const EMPTY_LIST = () => [];
const OK = () => ({ ok: true });
const CANCEL = () => ({ canceled: true });

for (const channel of ['list-logos', 'list-textures', 'list-templates']) {
    ipcMain.handle(channel, EMPTY_LIST);
}
for (const channel of [
    'save-prefs', 'save-user', 'logout-user', 'save-template', 'delete-template',
    'rename-template', 'export-template', 'export-qfs', 'open-external',
    'open-data-dir', 'copy-text', 'save-diagnostics', 'check-for-updates',
    'start-update-download', 'quit-and-install'
]) {
    ipcMain.handle(channel, OK);
}
for (const channel of [
    'open-image', 'open-images', 'open-sticker-image', 'import-template',
    'open-qfs', 'load-template', 'save-image-base64', 'save-images-batch',
    'pick-export-location', 'write-export-files', 'read-exif'
]) {
    ipcMain.handle(channel, CANCEL);
}
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('get-app-info', () => ({
    version: '0.1.20', electron: '31.7.7', chrome: '126.0.6478.234', node: '20.18.3',
    platform: 'win32', arch: 'x64', packaged: false, portable: false,
    osRelease: '10.0.22631', userData: process.env.TEMP, appPath: ROOT
}));

// ── 渲染进程里执行的绘图函数 ──
function makeSamples() {
    const rng = (seed) => {
        let s = seed >>> 0;
        return () => {
            s = (s + 0x6D2B79F5) >>> 0;
            let t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    };
    const canvas = (w, h) => {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        return { c, g: c.getContext('2d') };
    };
    const grain = (g, w, h, seed, amount = 0.05) => {
        const r = rng(seed);
        const img = g.getImageData(0, 0, w, h);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
            const n = (r() - 0.5) * 255 * amount;
            d[i] = Math.max(0, Math.min(255, d[i] + n));
            d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
            d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
        }
        g.putImageData(img, 0, 0);
    };
    const vignette = (g, w, h, strength = 0.28) => {
        const gr = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.max(w, h) * 0.75);
        gr.addColorStop(0, 'rgba(0,0,0,0)');
        gr.addColorStop(1, `rgba(0,0,0,${strength})`);
        g.fillStyle = gr;
        g.fillRect(0, 0, w, h);
    };
    const glow = (g, x, y, r, color) => {
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, color);
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    };

    const out = {};

    // 1. 黄昏湖面
    {
        const w = 1200, h = 1500;
        const { c, g } = canvas(w, h);
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#7ec8e3');
        sky.addColorStop(0.42, '#e78ba0');
        sky.addColorStop(0.72, '#8f6f9b');
        sky.addColorStop(1, '#4a3f68');
        g.fillStyle = sky; g.fillRect(0, 0, w, h);
        glow(g, 330, 430, 260, 'rgba(255,236,176,.55)');
        g.fillStyle = '#ffe9b0'; g.beginPath(); g.arc(330, 430, 78, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(255,255,255,.18)';
        for (let i = 0; i < 6; i++) {
            g.beginPath();
            g.ellipse(240 + i * 150, 260 + (i % 2) * 40, 120, 18, 0, 0, Math.PI * 2);
            g.fill();
        }
        g.fillStyle = '#5b557a';
        g.beginPath(); g.moveTo(0, 980);
        g.lineTo(180, 780); g.lineTo(320, 900); g.lineTo(470, 720); g.lineTo(680, 930);
        g.lineTo(860, 760); g.lineTo(1050, 900); g.lineTo(1200, 820); g.lineTo(1200, 1500); g.lineTo(0, 1500);
        g.closePath(); g.fill();
        g.fillStyle = '#34314f';
        g.beginPath(); g.moveTo(0, 1120);
        g.lineTo(150, 980); g.lineTo(300, 1080); g.lineTo(430, 940); g.lineTo(620, 1100);
        g.lineTo(780, 1000); g.lineTo(950, 1120); g.lineTo(1200, 1020); g.lineTo(1200, 1500); g.lineTo(0, 1500);
        g.closePath(); g.fill();
        const water = g.createLinearGradient(0, 1080, 0, h);
        water.addColorStop(0, '#4c446b'); water.addColorStop(1, '#242238');
        g.fillStyle = water; g.fillRect(0, 1080, w, h - 1080);
        g.fillStyle = 'rgba(255,233,176,.20)';
        for (let i = 0; i < 24; i++) {
            const y = 1110 + i * 16;
            const ww = 60 + (i % 5) * 30;
            g.fillRect(330 - ww / 2, y, ww, 3 + (i % 3));
        }
        g.fillStyle = 'rgba(255,255,255,.08)';
        for (let i = 0; i < 10; i++) g.fillRect(0, 1140 + i * 36, w, 2);
        vignette(g, w, h, 0.24);
        grain(g, w, h, 11, 0.045);
        out.lake = { dataUrl: c.toDataURL('image/webp', 0.92), w, h };
    }

    // 2. 暖光人像（也是“我的照片”演示）
    {
        const w = 1000, h = 1250;
        const { c, g } = canvas(w, h);
        const bg = g.createLinearGradient(0, 0, w, h);
        bg.addColorStop(0, '#ead8c5'); bg.addColorStop(0.55, '#d6b39a'); bg.addColorStop(1, '#9e6f62');
        g.fillStyle = bg; g.fillRect(0, 0, w, h);
        const light = g.createLinearGradient(0, 0, 520, 700);
        light.addColorStop(0, 'rgba(255,247,226,.72)');
        light.addColorStop(1, 'rgba(255,247,226,0)');
        g.fillStyle = light; g.fillRect(0, 0, w, h);
        g.fillStyle = 'rgba(92,56,48,.18)';
        g.beginPath(); g.ellipse(720, 1040, 280, 220, 0, 0, Math.PI * 2); g.fill();
        // 肩颈与衣服
        g.fillStyle = '#4d4a3e';
        g.beginPath();
        g.moveTo(170, 1250); g.bezierCurveTo(210, 1010, 360, 950, 500, 940);
        g.bezierCurveTo(650, 950, 800, 1010, 840, 1250); g.closePath(); g.fill();
        g.fillStyle = '#c58d74';
        g.beginPath(); g.ellipse(500, 880, 78, 118, 0, 0, Math.PI * 2); g.fill();
        // 头发
        g.fillStyle = '#3b2b2a';
        g.beginPath(); g.ellipse(500, 600, 180, 220, 0, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.ellipse(380, 760, 95, 190, -0.25, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.ellipse(625, 760, 95, 190, 0.25, 0, Math.PI * 2); g.fill();
        // 脸
        const face = g.createLinearGradient(380, 470, 620, 800);
        face.addColorStop(0, '#f0c3a5'); face.addColorStop(0.6, '#d99b7f'); face.addColorStop(1, '#b97562');
        g.fillStyle = face;
        g.beginPath(); g.ellipse(500, 620, 145, 190, 0, 0, Math.PI * 2); g.fill();
        // 五官（克制）
        g.fillStyle = 'rgba(74,43,38,.75)';
        g.beginPath(); g.ellipse(445, 610, 13, 7, 0, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.ellipse(555, 610, 13, 7, 0, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(120,68,58,.55)'; g.lineWidth = 4; g.lineCap = 'round';
        g.beginPath(); g.moveTo(500, 635); g.quadraticCurveTo(492, 690, 505, 700); g.stroke();
        g.strokeStyle = 'rgba(150,70,70,.55)'; g.lineWidth = 6;
        g.beginPath(); g.moveTo(460, 742); g.quadraticCurveTo(500, 760, 540, 742); g.stroke();
        // 高光与阴影
        g.fillStyle = 'rgba(255,236,210,.22)';
        g.beginPath(); g.ellipse(430, 560, 60, 90, -0.25, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(80,38,34,.18)';
        g.beginPath(); g.ellipse(590, 700, 55, 100, 0.2, 0, Math.PI * 2); g.fill();
        vignette(g, w, h, 0.30);
        grain(g, w, h, 22, 0.05);
        out.portrait = { dataUrl: c.toDataURL('image/webp', 0.92), w, h };
    }

    // 3. 沙漠
    {
        const w = 1400, h = 1000;
        const { c, g } = canvas(w, h);
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#f7d6a2'); sky.addColorStop(0.45, '#e9a17b'); sky.addColorStop(0.75, '#a95f55'); sky.addColorStop(1, '#4f3442');
        g.fillStyle = sky; g.fillRect(0, 0, w, h);
        glow(g, 1040, 250, 230, 'rgba(255,226,160,.55)');
        g.fillStyle = '#ffe3a3'; g.beginPath(); g.arc(1040, 250, 68, 0, Math.PI * 2); g.fill();
        const dune = (y, color, amp, phase) => {
            g.fillStyle = color; g.beginPath(); g.moveTo(0, h);
            g.lineTo(0, y);
            for (let x = 0; x <= w; x += 20) {
                const yy = y + Math.sin((x / w) * Math.PI * 2 + phase) * amp + Math.sin((x / w) * Math.PI * 5 + phase) * amp * 0.25;
                g.lineTo(x, yy);
            }
            g.lineTo(w, h); g.closePath(); g.fill();
        };
        dune(620, '#d28a5f', 34, 0.4);
        dune(730, '#b56b4e', 42, 1.6);
        dune(850, '#7f473e', 30, 2.8);
        g.fillStyle = 'rgba(255,214,160,.18)';
        for (let i = 0; i < 18; i++) {
            g.beginPath(); g.ellipse(200 + i * 70, 560 + (i % 3) * 24, 50, 5, -0.1, 0, Math.PI * 2); g.fill();
        }
        vignette(g, w, h, 0.26);
        grain(g, w, h, 33, 0.045);
        out.desert = { dataUrl: c.toDataURL('image/webp', 0.92), w, h };
    }

    // 4. 雾林
    {
        const w = 1000, h = 1250;
        const { c, g } = canvas(w, h);
        const bg = g.createLinearGradient(0, 0, 0, h);
        bg.addColorStop(0, '#b8cdbd'); bg.addColorStop(0.45, '#6f8f79'); bg.addColorStop(1, '#23342b');
        g.fillStyle = bg; g.fillRect(0, 0, w, h);
        // 光
        g.fillStyle = 'rgba(255,246,214,.16)';
        g.beginPath(); g.moveTo(700, 0); g.lineTo(1000, 0); g.lineTo(760, 900); g.lineTo(480, 900); g.closePath(); g.fill();
        // 远树
        g.fillStyle = 'rgba(40,62,50,.35)';
        for (let i = 0; i < 18; i++) {
            const x = 40 + i * 58;
            g.fillRect(x, 180 + (i % 4) * 30, 10 + (i % 3) * 4, 850);
        }
        // 近树
        for (let i = 0; i < 7; i++) {
            const x = 50 + i * 150;
            const tw = 22 + (i % 3) * 10;
            g.fillStyle = i % 2 ? '#1c2c24' : '#24382d';
            g.fillRect(x, 0, tw, h);
            g.beginPath();
            g.moveTo(x + tw / 2, 260 + (i % 3) * 90);
            g.lineTo(x - 90, 60 + (i % 4) * 40); g.lineTo(x - 60, 60 + (i % 4) * 40);
            g.lineTo(x + tw / 2, 220 + (i % 3) * 90); g.closePath(); g.fill();
        }
        // 雾层
        for (let i = 0; i < 5; i++) {
            const y = 400 + i * 150;
            const fog = g.createLinearGradient(0, y, 0, y + 120);
            fog.addColorStop(0, 'rgba(230,240,230,0)');
            fog.addColorStop(0.5, 'rgba(230,240,230,.18)');
            fog.addColorStop(1, 'rgba(230,240,230,0)');
            g.fillStyle = fog; g.fillRect(0, y, w, 120);
        }
        vignette(g, w, h, 0.34);
        grain(g, w, h, 44, 0.05);
        out.forest = { dataUrl: c.toDataURL('image/webp', 0.92), w, h };
    }

    // 5. 城市夜色
    {
        const w = 1400, h = 1000;
        const { c, g } = canvas(w, h);
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#131a33'); sky.addColorStop(0.5, '#2f2b55'); sky.addColorStop(1, '#8f4d6b');
        g.fillStyle = sky; g.fillRect(0, 0, w, h);
        // 楼群
        const r = rng(55);
        for (let layer = 0; layer < 3; layer++) {
            const base = 620 + layer * 90;
            g.fillStyle = ['#1b2038', '#242847', '#303252'][layer];
            for (let x = -40; x < w + 60; x += 90 + r() * 80) {
                const bw = 60 + r() * 100;
                const bh = 160 + r() * 360;
                g.fillRect(x, base - bh, bw, bh);
                g.fillStyle = 'rgba(255,210,130,.55)';
                for (let yy = base - bh + 24; yy < base - 20; yy += 34) {
                    for (let xx = x + 12; xx < x + bw - 10; xx += 24) {
                        if (r() > 0.55) g.fillRect(xx, yy, 8, 12);
                    }
                }
                g.fillStyle = ['#1b2038', '#242847', '#303252'][layer];
            }
        }
        // 霓虹
        const neon = (x, y, ww, hh, color, glowColor) => {
            g.shadowColor = glowColor; g.shadowBlur = 28;
            g.fillStyle = color; g.fillRect(x, y, ww, hh);
            g.shadowBlur = 0;
        };
        neon(180, 520, 150, 8, '#ff5f9e', 'rgba(255,95,158,.8)');
        neon(190, 560, 90, 6, '#5fe3ff', 'rgba(95,227,255,.8)');
        neon(980, 430, 180, 8, '#ffcf5f', 'rgba(255,207,95,.8)');
        neon(1000, 470, 110, 6, '#7b8cff', 'rgba(123,140,255,.8)');
        // 湿地反射
        const street = g.createLinearGradient(0, 760, 0, h);
        street.addColorStop(0, '#1a1830'); street.addColorStop(1, '#0d0d18');
        g.fillStyle = street; g.fillRect(0, 760, w, h - 760);
        g.globalAlpha = 0.25;
        for (let i = 0; i < 24; i++) {
            g.fillStyle = i % 3 === 0 ? '#ff5f9e' : (i % 3 === 1 ? '#5fe3ff' : '#ffcf5f');
            g.fillRect(120 + i * 48, 790 + (i % 5) * 30, 3 + (i % 4) * 3, 40 + (i % 6) * 12);
        }
        g.globalAlpha = 1;
        vignette(g, w, h, 0.38);
        grain(g, w, h, 66, 0.055);
        out.city = { dataUrl: c.toDataURL('image/webp', 0.92), w, h };
    }

    // 6. 静物花
    {
        const w = 1000, h = 1000;
        const { c, g } = canvas(w, h);
        const bg = g.createLinearGradient(0, 0, w, h);
        bg.addColorStop(0, '#e9dfcf'); bg.addColorStop(0.6, '#cdb79d'); bg.addColorStop(1, '#8f6b52');
        g.fillStyle = bg; g.fillRect(0, 0, w, h);
        // 光
        const light = g.createLinearGradient(0, 0, 600, 700);
        light.addColorStop(0, 'rgba(255,248,226,.62)'); light.addColorStop(1, 'rgba(255,248,226,0)');
        g.fillStyle = light; g.fillRect(0, 0, w, h);
        // 桌面
        g.fillStyle = '#7b5a45'; g.fillRect(0, 760, w, 240);
        g.fillStyle = 'rgba(255,230,190,.18)'; g.fillRect(0, 760, w, 5);
        // 花瓶阴影
        g.fillStyle = 'rgba(50,30,22,.28)';
        g.beginPath(); g.ellipse(500, 820, 170, 32, 0, 0, Math.PI * 2); g.fill();
        // 花瓶
        const vase = g.createLinearGradient(380, 0, 650, 0);
        vase.addColorStop(0, '#bda58d'); vase.addColorStop(0.5, '#ead8c1'); vase.addColorStop(1, '#9b7f68');
        g.fillStyle = vase;
        g.beginPath();
        g.moveTo(430, 520); g.bezierCurveTo(360, 650, 390, 800, 500, 810);
        g.bezierCurveTo(610, 800, 640, 650, 570, 520); g.closePath(); g.fill();
        g.fillStyle = 'rgba(255,255,255,.18)';
        g.beginPath(); g.ellipse(455, 650, 24, 100, 0.15, 0, Math.PI * 2); g.fill();
        // 花茎
        g.strokeStyle = '#4d6b4c'; g.lineWidth = 6; g.lineCap = 'round';
        const stems = [[470, 540, 420, 320], [500, 540, 520, 280], [530, 540, 600, 340], [490, 540, 470, 250]];
        stems.forEach(([x1, y1, x2, y2]) => { g.beginPath(); g.moveTo(x1, y1); g.quadraticCurveTo((x1 + x2) / 2 + 20, (y1 + y2) / 2, x2, y2); g.stroke(); });
        // 花
        const flower = (x, y, r, col, center) => {
            for (let i = 0; i < 7; i++) {
                const a = (i / 7) * Math.PI * 2;
                g.fillStyle = col;
                g.beginPath(); g.ellipse(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55, r * 0.55, r * 0.32, a, 0, Math.PI * 2); g.fill();
            }
            g.fillStyle = center; g.beginPath(); g.arc(x, y, r * 0.22, 0, Math.PI * 2); g.fill();
        };
        flower(420, 320, 68, 'rgba(196,96,92,.9)', '#e7c37b');
        flower(520, 280, 78, 'rgba(226,172,150,.95)', '#d9a34e');
        flower(600, 340, 62, 'rgba(160,72,80,.9)', '#e4bd72');
        flower(470, 250, 58, 'rgba(238,210,186,.95)', '#c98d3f');
        // 叶
        g.fillStyle = 'rgba(74,105,70,.8)';
        for (let i = 0; i < 5; i++) {
            g.beginPath(); g.ellipse(430 + i * 42, 420 + (i % 2) * 50, 36, 12, -0.5 + i * 0.25, 0, Math.PI * 2); g.fill();
        }
        vignette(g, w, h, 0.30);
        grain(g, w, h, 77, 0.05);
        out.still = { dataUrl: c.toDataURL('image/webp', 0.92), w, h };
    }

    return out;
}

function renderHomeCover(options) {
    return new Promise((resolve, reject) => {
        const sample = window.__homeSamples && window.__homeSamples[options.sampleKey];
        const preset = (window.App.presets || []).find(p => p._fileName === options.presetFile);
        if (!sample) { reject(new Error('missing sample: ' + options.sampleKey)); return; }
        if (!preset) { reject(new Error('missing preset: ' + options.presetFile)); return; }
        const img = new Image();
        img.onload = () => {
            try {
                const cv = document.createElement('canvas');
                cv.width = 1; cv.height = 1;
                const renderApp = {
                    dom: { canvas: cv },
                    image: { el: img, w: img.naturalWidth, h: img.naturalHeight, exif: {}, name: options.sampleKey },
                    template: JSON.parse(JSON.stringify(preset)),
                    displayMax: options.max || 1200,
                    uiDprOverride: 1,
                    textures: [],
                    selectedEls: [],
                    applyZoomStyle() {},
                    requestRender() {}
                };
                window.__render(renderApp, false);
                resolve({
                    dataUrl: cv.toDataURL('image/webp', 0.9),
                    width: cv.width,
                    height: cv.height
                });
            } catch (error) {
                reject(error);
            }
        };
        img.onerror = () => reject(new Error('sample load failed: ' + options.sampleKey));
        img.src = sample.dataUrl;
    });
}

async function main() {
    fs.mkdirSync(COVER_DIR, { recursive: true });
    fs.mkdirSync(SAMPLE_DIR, { recursive: true });

    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        show: false,
        webPreferences: {
            preload: path.join(ROOT, 'tools', 'preload-about.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            backgroundThrottling: false
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    const exec = (code) => win.webContents.executeJavaScript(code);

    let ready = false;
    for (let i = 0; i < 200; i++) {
        ready = await exec('!!(window.App && window.App.dom && Array.isArray(window.App.presets) && window.App.presets.length)');
        if (ready) break;
        await sleep(100);
    }
    if (!ready) throw new Error('App/presets did not become ready');
    await exec(`(() => {
        const splash = document.getElementById('splash');
        if (splash) splash.style.display = 'none';
        const intro = document.getElementById('introModal');
        if (intro) intro.style.display = 'none';
        document.documentElement.classList.add('dark');
        return true;
    })()`);

    console.log('presets:', await exec('window.App.presets.length'));

    const samples = await exec(`(${makeSamples.toString()})()`);
    for (const [key, sample] of Object.entries(samples)) {
        const base64 = sample.dataUrl.split(',')[1];
        fs.writeFileSync(path.join(SAMPLE_DIR, `${key}.webp`), Buffer.from(base64, 'base64'));
        console.log('sample:', key, `${sample.w}x${sample.h}`, Math.round(base64.length * 0.75 / 1024) + 'KB');
    }
    await exec(`window.__homeSamples = ${JSON.stringify(samples)}; true`);
    await exec(`window.__renderHomeCover = ${renderHomeCover.toString()}; true`);

    const outItems = [];
    for (const item of ITEMS) {
        const sampleCover = await exec(`window.__renderHomeCover(${JSON.stringify({ sampleKey: item.sample, presetFile: item.preset, max: 1200 })})`);
        const mineCover = await exec(`window.__renderHomeCover(${JSON.stringify({ sampleKey: 'portrait', presetFile: item.preset, max: 1200 })})`);
        const save = (name, cover) => {
            const base64 = cover.dataUrl.split(',')[1];
            fs.writeFileSync(path.join(COVER_DIR, name), Buffer.from(base64, 'base64'));
            return Math.round(base64.length * 0.75 / 1024);
        };
        const sampleKb = save(`${item.id}-sample.webp`, sampleCover);
        const mineKb = save(`${item.id}-mine.webp`, mineCover);
        outItems.push({
            ...item,
            coverSample: `home-prototype-assets/covers/${item.id}-sample.webp`,
            coverMine: `home-prototype-assets/covers/${item.id}-mine.webp`,
            sampleW: sampleCover.width,
            sampleH: sampleCover.height,
            mineW: mineCover.width,
            mineH: mineCover.height
        });
        console.log('cover:', item.id, `${sampleCover.width}x${sampleCover.height}`, `${sampleKb}KB / ${mineKb}KB`);
    }

    const data = {
        generatedAt: new Date().toISOString(),
        categories: CATEGORIES,
        myPhoto: 'home-prototype-assets/samples/portrait.webp',
        items: outItems
    };
    fs.writeFileSync(
        path.join(__dirname, 'home-prototype-data.js'),
        '// 由 design/render-home-prototype.js 生成，请勿手改。\nwindow.HOME_PROTOTYPE = ' + JSON.stringify(data, null, 2) + ';\n',
        'utf8'
    );
    console.log('wrote', path.join(__dirname, 'home-prototype-data.js'));
    app.exit(0);
}

app.whenReady().then(main).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
});
