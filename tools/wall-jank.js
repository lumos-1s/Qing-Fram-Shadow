// 预设墙拖动流畅度探针：模拟一段连续拖动，统计 rAF 帧间隔分布。
//
// 用法：
//   node tools/wall-jank.js                      # 等启动页消失后测（正常观感）
//   node tools/wall-jank.js --early              # 连"刚进墙"那一下一起测
//   node tools/wall-jank.js --dpr2               # 按 2 倍像素密度测（高分屏近似）
//   node tools/wall-jank.js --dpr2 --input       # 用真实鼠标拖（含悬停倾斜；额外输出 INPUT）
//
// 判读：这块屏是 165Hz，vsync ≈ 6.06ms；p95 ≤ 6.3 才算满帧，over12 是掉到 82fps 档的帧数。
//       16.7ms（60fps）只是最低及格线，不是这面墙的目标；over24 才是明显卡顿。
//       看 mean/fps 比只看 p50 可靠：p50 6.1 时仍可能有三成帧在 12ms。
// 注意：这台机器同时跑别的 Electron / CI 时数字会明显变差，比较前后务必在同样负载下跑两遍。
// --input 的 INPUT 行统计的是"鼠标事件派发期间"的 rAF 帧间隔；JANK 行仍是松手后的程序化平移。
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
// 本机 node_modules/electron 起不来时用 QF_ELECTRON_BIN 指到可用的那份
const EXE = (process.env.QF_ELECTRON_BIN || '').trim() || require('electron');
const PROFILE = path.join(os.tmpdir(), 'qfs-jank-' + Date.now());
const PORT = 9350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const extra = [];
    if (process.argv.includes('--dpr2')) extra.push('--force-device-scale-factor=2');
    const child = spawn(EXE, ['--no-sandbox', ...extra, '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT, ROOT],
        { cwd: ROOT, stdio: 'ignore', windowsHide: true });
    let page = null;
    for (let i = 0; i < 40 && !page; i++) {
        await sleep(400);
        try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page'); } catch (_) { /* 端口还没起来，下一轮再试 */ }
    }
    if (!page) { console.log('NO_PAGE'); process.exit(1); }

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0; const P = new Map();
    const send = (m, p) => new Promise((res, rej) => {
        const i = ++id; P.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method: m, params: p }));
        setTimeout(() => { if (P.has(i)) { P.delete(i); rej(new Error('timeout ' + m)); } }, 30000);
    });
    ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.id && P.has(m.id)) { const p = P.get(m.id); P.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    });
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const ev = async (x) => {
        const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
        return r.exceptionDetails ? { __exc: (r.exceptionDetails.exception || {}).description } : r.result.value;
    };

    // 等墙出现（旧版：启动即开；新版：可能先过加载页）
    for (let i = 0; i < 80; i++) {
        // 等真正"能看见墙"的瞬间：启动页已移除 + 墙可见 + 卡片已生成
        const ready = await ev(`!!(document.getElementById('presetWallGrid') && document.getElementById('presetWallGrid').querySelectorAll('.pw-tile').length && !document.getElementById('presetWall').hidden && !document.getElementById('splash'))`);
        if (ready === true) break;
        await sleep(200);
    }
    // 新 profile 会弹首次使用引导（#introModal），它盖在墙上面；不关掉的话
    // --input 的鼠标事件全打在引导层上，墙根本收不到（以前 --input 就是这样假测的）。
    await ev(`(() => {
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (_) {}
        if (window.App && typeof App.closeIntro === 'function') App.closeIntro();
        return true;
    })()`);
    await sleep(250);

    const EARLY = process.argv.includes('--early');
    if (!EARLY) await sleep(800);   // 默认测"稳定后"；--early 测刚进墙那一两秒

    let inputResult = null;
    if (process.argv.includes('--input')) {
        const rect = await ev(`(() => { const r = document.getElementById('presetWallGrid').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
        const cx = rect.l + rect.w / 2, cy = rect.t + rect.h / 2;
        const ampX = Math.min(260, rect.w * 0.25);
        const ampY = Math.min(140, rect.h * 0.2);
        const start = await ev(`({ x: App._wallPan.x, y: App._wallPan.y })`);
        const mouse = (type, x, y) => send('Input.dispatchMouseEvent', {
            type, x, y, button: type === 'mouseMoved' ? 'none' : 'left',
            buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 0
        });
        // 先启动帧采样，再按键拖动：统计的是真实 pointermove 期间的 rAF，
        // 不是之前那种"先拖一下、再测程序化平移"的假输入。
        await ev(`(() => {
            window.__wallInputProbe = { deltas: [], active: true };
            let last = performance.now();
            const tick = (t) => {
                window.__wallInputProbe.deltas.push(t - last); last = t;
                if (window.__wallInputProbe.active) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        })()`);
        await mouse('mouseMoved', cx, cy);
        await mouse('mousePressed', cx, cy);
        const t0 = Date.now();
        let k = 0, lx = cx, ly = cy;
        // 画一条留在视口内的 Lissajous 轨迹；避免以前一拖就出窗口、后半段根本没事件。
        while (Date.now() - t0 < 2400) {
            k++;
            const a = k * 0.045;
            lx = cx + Math.sin(a) * ampX;
            ly = cy + Math.cos(a * 0.8) * ampY;
            await mouse('mouseMoved', lx, ly);
            await sleep(8);
        }
        await mouse('mouseReleased', lx, ly);
        await sleep(100);
        const s = await ev(`(() => {
            window.__wallInputProbe.active = false;
            const d = window.__wallInputProbe.deltas.slice(3).sort((a, b) => a - b);
            const at = (q) => d[Math.min(d.length - 1, Math.floor(d.length * q))] || 0;
            const mean = d.reduce((a, b) => a + b, 0) / d.length;
            return {
                frames: d.length,
                p50: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), max: +d[d.length - 1].toFixed(1),
                mean: +mean.toFixed(2), fps: +(1000 / mean).toFixed(1),
                over12: d.filter((x) => x > 12).length,
                over16: d.filter((x) => x > 16).length,
                over24: d.filter((x) => x > 24).length,
                over50: d.filter((x) => x > 50).length,
                pan: { x: App._wallPan.x, y: App._wallPan.y },
                dragging: !!(App._wallDrag && App._wallDrag.dragging)
            };
        })()`);
        inputResult = Object.assign({ moves: k, moved: +Math.hypot(s.pan.x - start.x, s.pan.y - start.y).toFixed(1) }, s);
    }

    const result = await ev(`(async () => {
        const EARLY_IN_PAGE = ${EARLY ? 'true' : 'false'};
        const g = document.getElementById('presetWallGrid');
        App.stopWallMotion();
        // 程序化平移不是鼠标拖动，先撤掉鼠标悬停可能留下的 3D 倾斜卡；
        // 否则测到的是"倾斜卡 + 每帧 scale"的额外开销，和真实拖动（pointerdown 会清掉）不一致。
        const wt = App._wallTilt;
        if (wt && wt.card) { wt.card.removeAttribute('data-tilting'); wt.card = null; wt.rx = 0; wt.ry = 0; }
        App.panWallTo(0, 0);
        if (!EARLY_IN_PAGE) await new Promise(r => setTimeout(r, 200));

        const deltas = [];
        let last = performance.now();
        let running = true;
        const tick = (t) => {
            deltas.push(t - last); last = t;
            if (running) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);

        // 连续平移 2.4 秒（每帧 18px，接近中速拖动）
        const t0 = performance.now();
        let frames = 0;
        await new Promise((done) => {
            const step = () => {
                if (performance.now() - t0 > 2400) { running = false; done(); return; }
                frames++;
                App.panWallTo(App._wallPan.x - 18, App._wallPan.y - 6);
                requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
        });
        await new Promise(r => setTimeout(r, 60));

        const d = deltas.slice(3).sort((a, b) => a - b);
        const at = (q) => d[Math.min(d.length - 1, Math.floor(d.length * q))] || 0;
        const mean = d.reduce((a, b) => a + b, 0) / d.length;
        return {
            frames: d.length,
            p50: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), max: +d[d.length - 1].toFixed(1),
            mean: +mean.toFixed(2), fps: +(1000 / mean).toFixed(1),
            over12: d.filter(x => x > 12).length,
            over16: d.filter(x => x > 16).length,
            over24: d.filter(x => x > 24).length,
            over50: d.filter(x => x > 50).length,
            tiles: g.querySelectorAll('.pw-tile').length,
            imgsDecoded: (() => { let n = 0; for (const im of g.querySelectorAll('img')) if (im.complete && im.naturalWidth) n++; return n; })(),
            splash: !!document.getElementById('bootSplash')
        };
    })()`);
    if (inputResult) console.log('INPUT ' + JSON.stringify(inputResult));
    console.log('JANK ' + JSON.stringify(result));

    ws.close(); child.kill();
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) { /* profile 可能还被 Chromium 占着，退出时清不掉就算了 */ }
    process.exit(0);
})().catch((e) => { console.error('FAIL ' + (e && e.message)); process.exit(1); });
