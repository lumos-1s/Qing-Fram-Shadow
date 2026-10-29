'use strict';
/* 曲线编辑器：RGB / R / G / B 四条曲线 → 256 项查找表 → 接进调色的 LUT 滤镜。
 *
 * 设计取舍
 * ─────────────────────────────────────────────────────────────
 * 1) 单调三次插值（Fritsch–Carlson），不用 Catmull-Rom。
 *    Catmull-Rom 在控制点一密就会过冲：曲线冲出 0..1，暗部溢出成黑块、
 *    亮部翻转成死白。单调插值保证段内不过冲，这也是 PS/LR 曲线的默认行为。
 * 2) 曲线不额外走一遍像素：它和色温/高光/阴影共用同一条 feComponentTransfer
 *    的 256 项表（在 buildTables 里串联在其输出之后），所以开曲线不增加
 *    烘焙成本，拖动时仍走 1600px 降采样。
 * 3) 数据只存控制点（每通道一个 [[x,y]…] 数组），随草稿 JSON 持久化，
 *    与 7 个数值档一样是无损重放，不破坏原图。
 */
(function () {
    const N = 256;
    const HIT = 10;           // 命中控制点的像素半径
    const CHANS = [
        { k: 'rgb', label: 'RGB' },
        { k: 'r', label: '红' },
        { k: 'g', label: '绿' },
        { k: 'b', label: '蓝' }
    ];

    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

    // ── 数据 ──────────────────────────────────────────────────
    function sanitize(pts) {
        if (!Array.isArray(pts)) return null;
        const out = [];
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            if (!Array.isArray(p) || p.length < 2) continue;
            const x = Number(p[0]), y = Number(p[1]);
            if (!isFinite(x) || !isFinite(y)) continue;
            out.push([clamp01(x), clamp01(y)]);
        }
        if (out.length < 2) return null;
        out.sort((a, b) => a[0] - b[0]);
        // 相邻 x 太近会让插值除零：合并成一点（保留后写的）
        const ded = [];
        for (let i = 0; i < out.length; i++) {
            const last = ded[ded.length - 1];
            if (last && Math.abs(out[i][0] - last[0]) < 0.005) ded[ded.length - 1] = out[i];
            else ded.push(out[i]);
        }
        return ded.length >= 2 ? ded : null;
    }

    function sanitizeCurve(cv) {
        if (!cv) return null;
        const out = {};
        let any = false;
        for (const c of CHANS) {
            const pts = sanitize(cv[c.k]);
            if (pts) { out[c.k] = pts; any = true; }
        }
        return any ? out : null;
    }

    // 直线（等于没调）：用来判断中性、决定要不要把数据写进草稿
    function isLinear(pts) {
        if (!pts) return true;
        for (let i = 0; i < pts.length; i++) {
            if (Math.abs(pts[i][1] - pts[i][0]) > 0.002) return false;
        }
        return true;
    }

    function curveActive(cv) {
        if (!cv) return false;
        for (const c of CHANS) if (!isLinear(cv[c.k])) return true;
        return false;
    }

    function curveSignature(cv) {
        if (!curveActive(cv)) return '-';
        const parts = [];
        for (const c of CHANS) {
            const pts = cv[c.k];
            if (!pts || isLinear(pts)) { parts.push(''); continue; }
            parts.push(pts.map((p) => p[0].toFixed(3) + ':' + p[1].toFixed(3)).join(','));
        }
        return parts.join('|');
    }

    // ── 单调三次插值 → 256 项表 ────────────────────────────────
    function monotoneTable(pts) {
        const m = pts.length;
        const xs = new Array(m), ys = new Array(m);
        for (let i = 0; i < m; i++) { xs[i] = pts[i][0]; ys[i] = pts[i][1]; }
        const dx = new Array(m - 1), ms = new Array(m - 1);
        for (let i = 0; i < m - 1; i++) {
            dx[i] = Math.max(1e-6, xs[i + 1] - xs[i]);
            ms[i] = (ys[i + 1] - ys[i]) / dx[i];
        }
        const c = new Array(m);
        c[0] = ms[0];
        c[m - 1] = ms[m - 2];
        for (let i = 1; i < m - 1; i++) {
            if (ms[i - 1] * ms[i] <= 0) c[i] = 0;
            else {
                const w1 = 2 * dx[i] + dx[i - 1];
                const w2 = dx[i] + 2 * dx[i - 1];
                c[i] = (w1 + w2) / (w1 / ms[i - 1] + w2 / ms[i]);
            }
        }
        const out = new Array(N);
        let seg = 0;
        for (let i = 0; i < N; i++) {
            const x = i / (N - 1);
            if (x <= xs[0]) { out[i] = clamp01(ys[0]); continue; }
            if (x >= xs[m - 1]) { out[i] = clamp01(ys[m - 1]); continue; }
            while (seg < m - 2 && x > xs[seg + 1]) seg++;
            const t = (x - xs[seg]) / dx[seg];
            const t2 = t * t, t3 = t2 * t;
            let v = (2 * t3 - 3 * t2 + 1) * ys[seg]
                + (t3 - 2 * t2 + t) * dx[seg] * c[seg]
                + (-2 * t3 + 3 * t2) * ys[seg + 1]
                + (t3 - t2) * dx[seg] * c[seg + 1];
            out[i] = clamp01(v);
        }
        return out;
    }

    function sampleLut(lut, v) {
        const i = Math.round(clamp01(v) * (N - 1));
        return lut[i < 0 ? 0 : (i > N - 1 ? N - 1 : i)];
    }

    // 每通道的最终表：先走本通道曲线，再走 RGB 总曲线（与 PS 的复合顺序一致）
    function buildCurveLuts(cv) {
        const rgb = cv.rgb && !isLinear(cv.rgb) ? monotoneTable(cv.rgb) : null;
        const mk = (pts) => {
            const ch = pts && !isLinear(pts) ? monotoneTable(pts) : null;
            if (!ch && !rgb) return null;
            const out = new Array(N);
            for (let i = 0; i < N; i++) {
                let v = i / (N - 1);
                if (ch) v = sampleLut(ch, v);
                if (rgb) v = sampleLut(rgb, v);
                out[i] = v;
            }
            return out;
        };
        return { r: mk(cv.r), g: mk(cv.g), b: mk(cv.b) };
    }

    window.QfsCurve = {
        N, CHANS, sanitizeCurve, isLinear, curveActive, curveSignature,
        monotoneTable, sampleLut, buildCurveLuts, clamp01
    };

    // ── 控件 ──────────────────────────────────────────────────
    Object.assign(window.App || (window.App = {}), {
        _curveChan: 'rgb',

        initCurve() {
            const $ = (id) => document.getElementById(id);
            const cvEl = $('curveCanvas');
            if (!cvEl) return;
            this._curveDom = {
                canvas: cvEl, ctx: cvEl.getContext('2d'),
                chans: $('curveChans'), reset: $('btnCurveReset'),
                wrap: $('grpCurve')
            };
            const chanBtns = this._curveDom.chans
                ? Array.prototype.slice.call(this._curveDom.chans.querySelectorAll('.curve-chan')) : [];
            chanBtns.forEach((b) => {
                b.addEventListener('click', () => {
                    this._curveChan = b.dataset.chan || 'rgb';
                    chanBtns.forEach((x) => x.classList.toggle('active', x === b));
                    this.drawCurve();
                });
            });
            if (this._curveDom.reset) {
                this._curveDom.reset.addEventListener('click', () => this.resetCurve());
            }
            this._bindCurvePointer(cvEl);
            this.drawCurve();
        },

        // 当前照片的曲线数据（没有就是四条直线）
        curveOf(im) {
            const g = (im && im.grade) || null;
            return (g && g.curve) || null;
        },

        curvePoints(chan) {
            const cv = this.curveOf(this.image);
            const pts = cv && cv[chan];
            return pts ? pts.map((p) => [p[0], p[1]]) : [[0, 0], [1, 1]];
        },

        setCurve(chan, pts) {
            const im = this.image;
            if (!im) return false;
            const base = this.gradeOf(im);
            const cv = Object.assign({}, base.curve || {});
            const norm = window.QfsCurve.sanitizeCurve({ [chan]: pts });
            if (norm && norm[chan]) cv[chan] = norm[chan];
            else delete cv[chan];
            // 只剩直线就整份清掉，别把直线的控制点塞进草稿
            let any = false;
            for (const c of window.QfsCurve.CHANS) {
                if (cv[c.k] && !window.QfsCurve.isLinear(cv[c.k])) any = true;
            }
            return this.setGrade({ curve: any ? cv : null });
        },

        resetCurve() {
            const im = this.image;
            if (!im) return false;
            const r = this.setGrade({ curve: null });
            this.drawCurve();
            this.setStatus('已重置曲线');
            return r;
        },

        syncCurveUI() { this.drawCurve(); },

        // ── 绘制 ──
        drawCurve() {
            const d = this._curveDom;
            if (!d || !d.canvas) return;
            const css = getComputedStyle(document.documentElement);
            const v = (n, f) => (css.getPropertyValue(n) || f).trim() || f;
            const line = v('--text', '#333'), grid = v('--border', '#ddd'),
                primary = v('--primary', '#4a8');
            const chanColor = { rgb: line, r: '#e0575b', g: '#4caf6d', b: '#4a86d8' };

            const w = d.canvas.clientWidth || 260;
            const h = d.canvas.clientHeight || 176;
            const dpr = Math.min(3, window.devicePixelRatio || 1);
            if (d.canvas.width !== Math.round(w * dpr) || d.canvas.height !== Math.round(h * dpr)) {
                d.canvas.width = Math.round(w * dpr);
                d.canvas.height = Math.round(h * dpr);
            }
            const g = d.ctx;
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.clearRect(0, 0, w, h);
            const pad = 8;
            const X = (px) => pad + px * (w - pad * 2);
            const Y = (py) => h - pad - py * (h - pad * 2);

            // 网格 4×4
            g.strokeStyle = grid;
            g.lineWidth = 1;
            g.beginPath();
            for (let i = 1; i < 4; i++) {
                const t = i / 4;
                g.moveTo(Math.round(X(t)) + 0.5, pad);
                g.lineTo(Math.round(X(t)) + 0.5, h - pad);
                g.moveTo(pad, Math.round(Y(t)) + 0.5);
                g.lineTo(w - pad, Math.round(Y(t)) + 0.5);
            }
            g.globalAlpha = 0.55;
            g.stroke();
            g.globalAlpha = 1;
            // 边框
            g.strokeRect(pad + 0.5, pad + 0.5, w - pad * 2 - 1, h - pad * 2 - 1);

            // 先画其它通道（淡淡的），再画当前通道
            const cur = this._curveChan || 'rgb';
            for (const c of window.QfsCurve.CHANS) {
                if (c.k === cur) continue;
                const pts = this.curvePoints(c.k);
                if (window.QfsCurve.isLinear(pts)) continue;
                g.strokeStyle = chanColor[c.k];
                g.globalAlpha = 0.28;
                g.lineWidth = 1.4;
                this._strokeCurve(g, pts, X, Y);
                g.globalAlpha = 1;
            }
            // 当前通道
            const pts = this.curvePoints(cur);
            g.strokeStyle = cur === 'rgb' ? primary : chanColor[cur];
            g.lineWidth = 2;
            this._strokeCurve(g, pts, X, Y);

            // 控制点
            for (let i = 0; i < pts.length; i++) {
                const px = X(pts[i][0]), py = Y(pts[i][1]);
                g.beginPath();
                g.arc(px, py, 4, 0, Math.PI * 2);
                g.fillStyle = cur === 'rgb' ? primary : chanColor[cur];
                g.fill();
                g.strokeStyle = v('--surface', '#fff');
                g.lineWidth = 1.5;
                g.stroke();
            }
            if (d.wrap) d.wrap.classList.toggle('curve-on', this._curveDirty());
        },

        _strokeCurve(g, pts, X, Y) {
            const lut = window.QfsCurve.monotoneTable(pts);
            g.beginPath();
            for (let i = 0; i < window.QfsCurve.N; i++) {
                const x = X(i / (window.QfsCurve.N - 1));
                const y = Y(lut[i]);
                if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
            }
            g.stroke();
        },

        _curveDirty() {
            const cv = this.curveOf(this.image);
            return window.QfsCurve.curveActive(cv);
        },

        // ── 鼠标：拖动 / 加点 / 双击删点 ──
        _bindCurvePointer(el) {
            const self = this;
            let drag = -1;
            const pos = (e) => {
                const r = el.getBoundingClientRect();
                const pad = 8;
                const w = r.width - pad * 2, h = r.height - pad * 2;
                return {
                    x: self.QfsClamp01((e.clientX - r.left - pad) / Math.max(1, w)),
                    y: self.QfsClamp01(1 - (e.clientY - r.top - pad) / Math.max(1, h)),
                    px: e.clientX - r.left, py: e.clientY - r.top
                };
            };
            const hitTest = (p) => {
                const pts = self.curvePoints(self._curveChan);
                const r = el.getBoundingClientRect();
                const pad = 8;
                const X = (v) => pad + v * (r.width - pad * 2);
                const Y = (v) => r.height - pad - v * (r.height - pad * 2);
                for (let i = 0; i < pts.length; i++) {
                    if (Math.abs(X(pts[i][0]) - p.px) <= HIT && Math.abs(Y(pts[i][1]) - p.py) <= HIT) return i;
                }
                return -1;
            };
            el.addEventListener('pointerdown', (e) => {
                const p = pos(e);
                let idx = hitTest(p);
                if (idx < 0) {
                    // 空白处按下 = 加一个点。必须立刻写回数据：
                    // 只改内存里的副本的话，这一下加的点在松手前并不存在，
                    // 随后的 pointermove 还会按旧索引去挪端点。
                    const pts = self.curvePoints(self._curveChan);
                    const nx = Math.max(0.01, Math.min(0.99, p.x));
                    pts.push([nx, p.y]);
                    pts.sort((a, b) => a[0] - b[0]);
                    self.setCurve(self._curveChan, pts);
                    // 写回后按 x 重新定位索引（sanitize 可能微调过坐标）
                    const after = self.curvePoints(self._curveChan);
                    let best = 0, bd = 1e9;
                    for (let i = 0; i < after.length; i++) {
                        const d = Math.abs(after[i][0] - nx);
                        if (d < bd) { bd = d; best = i; }
                    }
                    idx = best;
                }
                drag = idx;
                try { el.setPointerCapture(e.pointerId); } catch (_) { /* 老浏览器忽略 */ }
                self.drawCurve();
            });
            el.addEventListener('pointermove', (e) => {
                if (drag < 0) return;
                const p = pos(e);
                const pts = self.curvePoints(self._curveChan);
                const isFirst = drag === 0, isLast = drag === pts.length - 1;
                let x = p.x, y = p.y;
                // 端点 x 锁死在 0 / 1，中间点只能在前后两点之间滑动
                if (isFirst) x = 0;
                else if (isLast) x = 1;
                else {
                    const lo = pts[drag - 1][0] + 0.01;
                    const hi = pts[drag + 1][0] - 0.01;
                    x = Math.max(lo, Math.min(hi, x));
                }
                pts[drag] = [x, y];
                self.setCurve(self._curveChan, pts);
            });
            const up = () => {
                if (drag < 0) return;
                drag = -1;
                // 停手后补全分辨率 + 重画缩略图（与滑块的静置逻辑一致）
                const im = self.image;
                if (im) {
                    if (self.rebuildGrade) self.rebuildGrade('full');
                    if (self.renderFramedThumb) setTimeout(() => self.renderFramedThumb(im), 240);
                }
            };
            el.addEventListener('pointerup', up);
            el.addEventListener('pointercancel', up);
            el.addEventListener('dblclick', (e) => {
                const p = pos(e);
                const idx = hitTest(p);
                const pts = self.curvePoints(self._curveChan);
                // 两个端点不能删，否则曲线没有定义域
                if (idx > 0 && idx < pts.length - 1) {
                    pts.splice(idx, 1);
                    self.setCurve(self._curveChan, pts);
                }
            });
        },

        QfsClamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
    });
})();
