'use strict';
/* 手机版桌面对齐控件：颜色分级 + 曲线。
 *
 * 这两组在桌面「调色」页里，字段（grade.cg / grade.curve）与烘焙引擎
 * app-grade.js / app-curve.js 已完成，手机版此前只是没有入口。
 * 本模块只负责生成控件与把 patch 交给调用方，不直接碰全局状态。
 */
(function () {
    const ZONES = [
        { k: 'shadow', label: '阴影' }, { k: 'mid', label: '中间调' },
        { k: 'high', label: '高光' }, { k: 'global', label: '全局' }
    ];
    const METRICS = [
        { k: 'h', label: '色相', min: 0, max: 360, step: 1 },
        { k: 's', label: '饱和度', min: 0, max: 100, step: 1 },
        { k: 'l', label: '明亮度', min: -100, max: 100, step: 1 }
    ];
    const CHANS = [
        { k: 'rgb', label: 'RGB' }, { k: 'r', label: '红' },
        { k: 'g', label: '绿' }, { k: 'b', label: '蓝' }
    ];

    let zone = 'shadow';
    let chan = 'rgb';
    let drag = -1;
    let cv = null;
    let onGrade = () => {};
    let getGrade = () => ({});
    let panelRef = null;

    function defaultCg() {
        const z = () => ({ h: 0, s: 0, l: 0 });
        return { shadow: z(), mid: z(), high: z(), global: z(), blending: 50, balance: 0 };
    }
    function defaultCurve() {
        const line = [[0, 0], [1, 1]];
        return { rgb: line.slice(), r: line.slice(), g: line.slice(), b: line.slice() };
    }
    function clone(o) { return o == null ? null : JSON.parse(JSON.stringify(o)); }

    function html(g) {
        const cg = Object.assign(defaultCg(), clone(g && g.cg) || {});
        cv = Object.assign(defaultCurve(), clone(g && g.curve) || {});
        const chips = ZONES.map((z) =>
            `<button type="button" class="chip${z.k === zone ? ' active' : ''}" data-cg-zone="${z.k}">${z.label}</button>`).join('');
        const rows = METRICS.map((m) =>
            `<div class="grade-row"><label>${m.label}</label>`
            + `<input type="range" data-cg="${m.k}" min="${m.min}" max="${m.max}" step="${m.step}" value="${cg[zone][m.k]}">`
            + `<output data-cg-out="${m.k}">${cg[zone][m.k]}</output></div>`).join('');
        const glob = [
            `<div class="grade-row"><label>混合</label><input type="range" data-cg-global="blending" min="0" max="100" step="1" value="${cg.blending}"><output data-cg-global-out="blending">${cg.blending}</output></div>`,
            `<div class="grade-row"><label>平衡</label><input type="range" data-cg-global="balance" min="-100" max="100" step="1" value="${cg.balance}"><output data-cg-global-out="balance">${cg.balance}</output></div>`
        ].join('');
        const chans = CHANS.map((c) =>
            `<button type="button" class="chip${c.k === chan ? ' active' : ''}" data-curve-chan="${c.k}">${c.label}</button>`).join('');
        return `<details class="ctl-group" open><summary>颜色分级</summary>
                <div class="chips">${chips}</div>
                <div class="grade-sliders">${rows}${glob}</div>
                <div class="puzzle-acts"><button type="button" id="btnCgReset">重置颜色分级</button></div>
            </details>
            <details class="ctl-group" open><summary>曲线</summary>
                <div class="chips">${chans}</div>
                <canvas class="curve-canvas-m" id="qfCurveCanvas" width="480" height="320"
                    aria-label="曲线编辑器：拖动控制点，点空白处添加，双击删除"></canvas>
                <p class="ctl-sub">点空白处加点 · 拖动调整 · 双击删点</p>
                <div class="puzzle-acts"><button type="button" id="btnCurveMReset">重置曲线</button></div>
            </details>`;
    }

    function currentCg() {
        return Object.assign(defaultCg(), clone(getGrade() && getGrade().cg) || {});
    }

    function setZone(k) {
        zone = k;
        if (!panelRef) return;
        panelRef.querySelectorAll('[data-cg-zone]').forEach((x) =>
            x.classList.toggle('active', x.dataset.cgZone === zone));
        syncCg();
    }

    function syncCg() {
        if (!panelRef) return;
        const cg = currentCg();
        panelRef.querySelectorAll('[data-cg]').forEach((el) => {
            const v = cg[zone][el.dataset.cg] || 0;
            el.value = String(v);
            const out = panelRef.querySelector(`[data-cg-out="${el.dataset.cg}"]`);
            if (out) out.textContent = String(v);
        });
    }

    function drawCurve() {
        if (!panelRef || !cv) return;
        const el = panelRef.querySelector('#qfCurveCanvas');
        if (!el) return;
        const c = el.getContext('2d');
        const W = el.width, H = el.height, pad = 22;
        const L = pad, T = pad, R = W - pad, B = H - pad;
        const px = (x) => L + x * (R - L);
        const py = (y) => B - y * (B - T);
        c.clearRect(0, 0, W, H);
        c.fillStyle = '#0d0f0d';
        c.fillRect(0, 0, W, H);
        c.strokeStyle = 'rgba(255,255,255,.09)';
        c.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
            const x = L + (R - L) * i / 4, y = T + (B - T) * i / 4;
            c.beginPath(); c.moveTo(x, T); c.lineTo(x, B); c.stroke();
            c.beginPath(); c.moveTo(L, y); c.lineTo(R, y); c.stroke();
        }
        c.strokeStyle = 'rgba(255,255,255,.22)';
        c.setLineDash([5, 5]);
        c.beginPath(); c.moveTo(L, B); c.lineTo(R, T); c.stroke();
        c.setLineDash([]);
        const pts = cv[chan] || [[0, 0], [1, 1]];
        const C = window.QfsCurve;
        if (C) {
            const lut = C.monotoneTable(pts);
            c.strokeStyle = '#E9A857';
            c.lineWidth = 3;
            c.beginPath();
            for (let i = 0; i < lut.length; i++) {
                const x = px(i / (lut.length - 1)), y = py(lut[i]);
                if (!i) c.moveTo(x, y); else c.lineTo(x, y);
            }
            c.stroke();
        } else {
            c.strokeStyle = '#E9A857';
            c.lineWidth = 3;
            c.beginPath(); c.moveTo(px(pts[0][0]), py(pts[0][1]));
            for (let i = 1; i < pts.length; i++) c.lineTo(px(pts[i][0]), py(pts[i][1]));
            c.stroke();
        }
        pts.forEach((p) => {
            c.beginPath(); c.arc(px(p[0]), py(p[1]), 6, 0, Math.PI * 2);
            c.fillStyle = '#E9A857'; c.fill();
            c.lineWidth = 2; c.strokeStyle = '#0d0f0d'; c.stroke();
        });
    }

    function commitCurve() {
        if (window.QfsCurve) cv = window.QfsCurve.sanitizeCurve(cv) || defaultCurve();
        drawCurve();
        onGrade({ curve: clone(cv) });
    }

    function pointAt(e) {
        const el = panelRef.querySelector('#qfCurveCanvas');
        const r = el.getBoundingClientRect();
        const pad = 22;
        const x = (e.clientX - r.left) / r.width * el.width;
        const y = (e.clientY - r.top) / r.height * el.height;
        return {
            x: Math.max(0, Math.min(1, (x - pad) / (el.width - pad * 2))),
            y: Math.max(0, Math.min(1, (el.height - pad - y) / (el.height - pad * 2)))
        };
    }
    function nearest(p) {
        const pts = cv[chan];
        const el = panelRef.querySelector('#qfCurveCanvas');
        const r = el.getBoundingClientRect();
        const sx = r.width / el.width, sy = r.height / el.height;
        let best = -1, bd = 16;
        pts.forEach((q, i) => {
            const dx = (q[0] - p.x) * (el.width - 44) * sx;
            const dy = (q[1] - p.y) * (el.height - 44) * sy;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < bd) { bd = d; best = i; }
        });
        return best;
    }

    function bind(panel, fn, getter) {
        panelRef = panel;
        drag = -1;
        onGrade = typeof fn === 'function' ? fn : (() => {});
        getGrade = typeof getter === 'function' ? getter : (() => ({}));
        const g = getGrade();
        cv = Object.assign(defaultCurve(), clone(g && g.curve) || {});

        panel.querySelectorAll('[data-cg-zone]').forEach((b) => {
            b.addEventListener('click', () => setZone(b.dataset.cgZone));
        });
        panel.querySelectorAll('[data-cg]').forEach((el) => {
            el.addEventListener('input', () => {
                const cg = currentCg();
                const v = Number(el.value);
                cg[zone][el.dataset.cg] = v;
                const out = panel.querySelector(`[data-cg-out="${el.dataset.cg}"]`);
                if (out) out.textContent = String(v);
                onGrade({ cg });
            });
        });
        panel.querySelectorAll('[data-cg-global]').forEach((el) => {
            el.addEventListener('input', () => {
                const cg = currentCg();
                const v = Number(el.value);
                cg[el.dataset.cgGlobal] = v;
                const out = panel.querySelector(`[data-cg-global-out="${el.dataset.cgGlobal}"]`);
                if (out) out.textContent = String(v);
                onGrade({ cg });
            });
        });
        const cgr = panel.querySelector('#btnCgReset');
        if (cgr) cgr.addEventListener('click', () => {
            onGrade({ cg: defaultCg() });
            // 这里不走整页 render：滑块/分区 chip 在本模块内同步，避免曲线上的点被重置
            setZone('shadow');
        });

        panel.querySelectorAll('[data-curve-chan]').forEach((b) => {
            b.addEventListener('click', () => {
                chan = b.dataset.curveChan;
                panel.querySelectorAll('[data-curve-chan]').forEach((x) =>
                    x.classList.toggle('active', x === b));
                drawCurve();
            });
        });
        const el = panel.querySelector('#qfCurveCanvas');
        if (el) {
            el.addEventListener('pointerdown', (e) => {
                const p = pointAt(e);
                const pts = cv[chan];
                let i = nearest(p);
                if (i < 0) {
                    const added = [p.x, p.y];
                    pts.push(added);
                    pts.sort((a, b2) => a[0] - b2[0]);
                    i = pts.indexOf(added);
                }
                drag = i;
                try { el.setPointerCapture(e.pointerId); } catch (_) {}
                drawCurve();
                commitCurve();
            });
            el.addEventListener('pointermove', (e) => {
                if (drag < 0) return;
                const p = pointAt(e), pts = cv[chan];
                const q = pts[drag];
                if (!q) return;
                q[1] = p.y;
                if (drag > 0 && drag < pts.length - 1) q[0] = p.x;
                pts.sort((a, b2) => a[0] - b2[0]);
                drawCurve();
                commitCurve();
            });
            ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
                el.addEventListener(ev, () => { drag = -1; }));
            el.addEventListener('dblclick', (e) => {
                const i = nearest(pointAt(e));
                const pts = cv[chan];
                if (i <= 0 || i >= pts.length - 1) return;
                pts.splice(i, 1);
                commitCurve();
            });
        }
        const cr = panel.querySelector('#btnCurveMReset');
        if (cr) cr.addEventListener('click', () => {
            cv = defaultCurve();
            onGrade({ curve: clone(cv) });
            drawCurve();
        });
        drawCurve();
    }

    window.QF_GradeExtra = { html, bind, defaultCg, defaultCurve };
})();
