'use strict';
/* 混色器：8 色相带 × 色相/饱和度/明亮度（对齐 LR 的 HSL 面板），外加
 * 「细节」「校准」两组滑块的 UI 绑定（渲染本体在 app-grade.js）。
 *
 * 设计取舍
 * ─────────────────────────────────────────────────────────────
 * 1) 混色器是「按色相选区」的调整 —— 权重取决于每个像素自己的色相，
 *    本质是三维操作，逐通道 256 项 LUT 表达不了；SVG 掩膜近似每带要
 *    十几个滤镜原语 × 8 带，软件渲染烘焙会慢一个数量级。所以这一步
 *    用 WebGL 单 pass 着色器（RGB↔HSV + 带权重平滑混合），
 *    1600px 预览一次 <2ms，全分辨率也在个位数毫秒。
 * 2) WebGL 只是烘焙管线的**前置级**：原图 → GL(混色) → ctx.filter(其余全部)。
 *    GL 不可用/上下文丢失/着色器异常时 pass() 返回 null，bake 自动
 *    退回原图，混色器 UI 标记为不可用，其余功能完全不受影响。
 * 3) 带权重用 smoothstep 过渡、跨带重叠取加权平均而不是叠加，
 *    避免相邻带（红/橙只差 30°）同时拉满时颜色串台。
 */
(function () {
    // ── WebGL 烘焙前置级 ─────────────────────────────────────────
    const VS = 'attribute vec2 aP;varying vec2 vUV;void main(){vUV=aP*0.5+0.5;gl_Position=vec4(aP,0.0,1.0);}';
    const FS = [
        'precision mediump float;',
        'varying vec2 vUV;',
        'uniform sampler2D uT;',
        'uniform float uDh[8];uniform float uDs[8];uniform float uDl[8];',
        'uniform float uHc[8];uniform float uHw[8];',
        // LR 的「混色器」在 **HSL** 空间（色相/饱和度/明亮度），不是 HSV。
        // 用 HSV 的 V 当"明亮度"会出两个偏差：高饱和色 V 已经是 1，提亮完全提不动
        // （纯红 +24 明亮度在 LR 里会变亮变粉，我们纹丝不动）；低饱和色的 S 又偏高。
        // 实测同一组参数（饱和度 −13、明亮度 +24）两者最大单通道差 32 级。
        'vec3 rgb2hsl(vec3 c){',
        '  float mx=max(max(c.r,c.g),c.b);',
        '  float mn=min(min(c.r,c.g),c.b);',
        '  float d=mx-mn;',
        '  float l=(mx+mn)*0.5;',
        '  float s=0.0;',
        '  if(d>1e-6){ float den=1.0-abs(2.0*l-1.0); s=den>1e-4?d/den:0.0; }',
        '  float h=0.0;',
        '  if(d>1e-6){',
        '    if(mx==c.r) h=fract((c.g-c.b)/d+6.0)/6.0;',
        '    else if(mx==c.g) h=((c.b-c.r)/d+2.0)/6.0;',
        '    else h=((c.r-c.g)/d+4.0)/6.0;',
        '  }',
        '  return vec3(h,s,l);',
        '}',
        'vec3 hsl2rgb(vec3 c){',
        '  float h=c.x;float s=c.y;float l=c.z;',
        '  float C=(1.0-abs(2.0*l-1.0))*s;',
        '  float X=C*(1.0-abs(mod(h*6.0,2.0)-1.0));',
        '  float m=l-C*0.5;',
        '  vec3 rgb;',
        '  if(h<1.0/6.0) rgb=vec3(C,X,0.0);',
        '  else if(h<2.0/6.0) rgb=vec3(X,C,0.0);',
        '  else if(h<3.0/6.0) rgb=vec3(0.0,C,X);',
        '  else if(h<4.0/6.0) rgb=vec3(0.0,X,C);',
        '  else if(h<5.0/6.0) rgb=vec3(X,0.0,C);',
        '  else rgb=vec3(C,0.0,X);',
        '  return rgb+m;',
        '}',
        'void main(){',
        '  vec3 c=texture2D(uT,vUV).rgb;',
        '  vec3 hsl=rgb2hsl(c);',
        '  float wsum=0.0,dh=0.0,ds=0.0,dl=0.0;',
        '  for(int i=0;i<8;i++){',
        '    float d=abs(hsl.x*360.0-uHc[i]);',
        '    d=min(d,360.0-d);',
        '    float w=clamp(1.0-d/uHw[i],0.0,1.0);',
        '    w=w*w*(3.0-2.0*w);',
        '    wsum+=w;dh+=w*uDh[i];ds+=w*uDs[i];dl+=w*uDl[i];',
        '  }',
        // 灰/黑/白不参与（HSL 里纯黑的 S 无意义，纯白/纯黑的 L 调整也无意义）
        '  if(wsum>0.001&&hsl.y>0.003&&hsl.z>0.01&&hsl.z<0.99){',
        '    hsl.x=fract(hsl.x+dh/wsum*0.1111);',
        '    hsl.y=clamp(hsl.y*(1.0+ds/wsum),0.0,1.0);',
        // 明亮度直接加到 L：L 与感知亮度同构，不需要 HSV 那套"提亮抑制亮端"的补丁。
        // 0.42 是满档幅度，1−0.9L 让接近纯白时收力，避免整片糊成白。
        '    hsl.z=clamp(hsl.z+dl/wsum*0.42*(1.0-0.9*hsl.z),0.0,1.0);',
        '  }',
        '  gl_FragColor=vec4(hsl2rgb(hsl),1.0);',
        '}'
    ].join('\n');
    // 0.1111 = 40/360：滑块满档 ±100 → 色相 ±40°

    let gl = null, glc = null, prog = null, uni = null, quad = null;

    function init() {
        if (gl && prog) return true;
        if (!gl) {
            try {
                glc = document.createElement('canvas');
                gl = glc.getContext('webgl', { preserveDrawingBuffer: true, antialias: false })
                    || glc.getContext('experimental-webgl', { preserveDrawingBuffer: true, antialias: false });
            } catch (_) { gl = null; }
            if (!gl) return false;
            glc.addEventListener('webglcontextlost', (e) => {
                e.preventDefault();
                gl = null; prog = null; uni = null;
            });
        }
        try {
            const sh = (type, src) => {
                const s = gl.createShader(type);
                gl.shaderSource(s, src);
                gl.compileShader(s);
                if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
                return s;
            };
            prog = gl.createProgram();
            gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
            gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
            gl.useProgram(prog);
            quad = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, quad);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
            const loc = gl.getAttribLocation(prog, 'aP');
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            // 画布坐标 y 向下、纹理 t 向上：翻转上传，免得画出来是倒的
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            uni = {
                dh: gl.getUniformLocation(prog, 'uDh'),
                ds: gl.getUniformLocation(prog, 'uDs'),
                dl: gl.getUniformLocation(prog, 'uDl'),
                hc: gl.getUniformLocation(prog, 'uHc'),
                hw: gl.getUniformLocation(prog, 'uHw')
            };
            gl.uniform1i(gl.getUniformLocation(prog, 'uT'), 0);
            return true;
        } catch (_) {
            gl = null; prog = null; uni = null;
            return false;
        }
    }

    function pass(src, mix, w, h) {
        if (!init()) return null;
        try {
            if (glc.width !== w || glc.height !== h) { glc.width = w; glc.height = h; }
            gl.viewport(0, 0, w, h);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
            const bands = (window.App && window.App.MIX_BANDS) || [];
            const dh = [], ds = [], dl = [], hc = [], hw = [];
            for (const b of bands) {
                const v = mix[b.k] || {};
                dh.push((Number(v.h) || 0) / 100);
                ds.push((Number(v.s) || 0) / 100);
                dl.push((Number(v.l) || 0) / 100);
                hc.push(b.hue);
                hw.push(b.hw);
            }
            gl.uniform1fv(uni.dh, new Float32Array(dh));
            gl.uniform1fv(uni.ds, new Float32Array(ds));
            gl.uniform1fv(uni.dl, new Float32Array(dl));
            gl.uniform1fv(uni.hc, new Float32Array(hc));
            gl.uniform1fv(uni.hw, new Float32Array(hw));
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            return glc;
        } catch (_) {
            return null;
        }
    }

    window.QfsMix = {
        pass,
        available() { return init(); }
    };

    // ── UI：细节 / 校准 / 混色器三组滑块 ─────────────────────────
    function fmt(v) { return v === 0 ? '0' : (v > 0 ? '+' + v : String(v)); }
    // 「效果」段的纹理 / 清晰度 / 去除薄雾与同组晕影、颗粒对齐，用纯数字；
    // 其余（锐化 / 校准 / 混色器）沿用带符号整数或各自的 fmt。
    const PLAIN_DET_KEYS = new Set(['tex', 'clar', 'dhz']);
    const labelText = (rec, v) => {
        const n = Number(v) || 0;
        if (rec.fmt) return rec.fmt(n);
        return rec.plain ? String(n) : fmt(n);
    };

    Object.assign(window.App || (window.App = {}), {
        _mixMetric: 'h',

        initGradeExtra() {
            const $ = (id) => document.getElementById(id);
            this._gradeExtra = { det: {}, cal: {}, mix: {} };
            const showLabel = (rec) => {
                const lbl = rec && rec.lbl;
                if (!lbl) return;
                const text = labelText(rec, rec.inp.value);
                // 与 syncGradeExtraUI 一样走 updateLabel：它是数字框(.pval-num)的唯一同步入口。
                if (lbl.id && typeof this.updateLabel === 'function') this.updateLabel(lbl.id, text);
                else lbl.textContent = text;
            };
            const bind = (inp, rec, apply) => {
                if (!inp) return;
                let settle = 0;
                const thumb = () => {
                    const im = this.image;
                    if (im && this.renderFramedThumb) {
                        clearTimeout(im._gradeThumbT);
                        im._gradeThumbT = setTimeout(() => this.renderFramedThumb(im), 260);
                    }
                };
                inp.addEventListener('input', () => {
                    apply(Number(inp.value) || 0);
                    // 拖动时即时回填：只靠 syncGradeExtraUI（切图/撤销/套预设才跑）
                    // 会让标签在整个拖动过程里停在旧值，看上去像控件没反应。
                    showLabel(rec);
                    clearTimeout(settle);
                    settle = setTimeout(() => { this.rebuildGrade('full'); thumb(); }, 220);
                });
                inp.addEventListener('change', () => {
                    clearTimeout(settle);
                    apply(Number(inp.value) || 0);
                    showLabel(rec);
                    this.rebuildGrade('full');
                    thumb();
                });
                showLabel(rec);
            };
            // 细节 / 校准：扁平参数组，patch 进 grade.det / grade.cal
            const bindGroup = (spec, key) => {
                for (const it of spec) {
                    const inp = $('sl' + it.id), lbl = $('lbl' + it.id);
                    if (inp) {
                        // fmt：半径这类小数字段要自己决定显示（+0.5 不合适），
                        // 没有就用默认的「带符号整数」
                        const rec = { inp, lbl, fmt: it.fmt, plain: !!it.plain };
                        this._gradeExtra[key][it.k] = rec;
                        bind(inp, rec, (v) => {
                            const cur = this.gradeOf(this.image);
                            const g = Object.assign({}, cur[key] || {}, { [it.k]: v });
                            this.setGrade({ [key]: g });
                        });
                    }
                }
            };
            // fmt 要一起带过去：半径是小数，默认的「带符号整数」会显示成 +0.8
            bindGroup(this.DET_FIELDS.map((f) => ({
                k: f.k, id: 'Det' + f.k.charAt(0).toUpperCase() + f.k.slice(1), fmt: f.fmt,
                plain: PLAIN_DET_KEYS.has(f.k)
            })), 'det');
            bindGroup(this.CAL_FIELDS.map((f) => ({ k: f.k, id: 'Cal' + f.k.toUpperCase() })), 'cal');
            // 混色器：24 个滑块（8 带 × 3 项），patch 进 grade.mix
            for (const b of this.MIX_BANDS) {
                for (const mt of this.MIX_METRICS) {
                    const id = 'Mix' + b.k.toUpperCase() + mt.k.toUpperCase();
                    const inp = $('sl' + id), lbl = $('lbl' + id);
                    if (inp) {
                        inp.style.setProperty('--h', String(b.hue));
                        const rec = { inp, lbl };
                        this._gradeExtra.mix[b.k + '.' + mt.k] = rec;
                        bind(inp, rec, (v) => {
                            const cur = this.gradeOf(this.image);
                            const m = Object.assign({}, cur.mix || {});
                            m[b.k] = Object.assign({ h: 0, s: 0, l: 0 }, m[b.k] || {}, { [mt.k]: v });
                            this.setGrade({ mix: m });
                        });
                    }
                }
            }
            // 混色器「色相/饱和度/明亮度」子页
            const tabs = $('mixMetrics');
            if (tabs) {
                const btns = Array.prototype.slice.call(tabs.querySelectorAll('.curve-chan'));
                btns.forEach((btn) => {
                    btn.addEventListener('click', () => {
                        this._mixMetric = btn.dataset.m || 'h';
                        const grp = $('grpMix');
                        if (grp) grp.dataset.m = this._mixMetric;
                        btns.forEach((x) => x.classList.toggle('active', x === btn));
                    });
                });
                const grp = $('grpMix');
                if (grp) grp.dataset.m = this._mixMetric;
            }
            const mixReset = $('btnMixReset');
            if (mixReset) {
                mixReset.addEventListener('click', () => {
                    this.setGrade({ mix: null });
                    this.setStatus('已重置混色器');
                });
            }
            // 吸管取色（LR 的 TAT）：必须在混色器滑块绑定之后，
            // 它要读写 _mixMetric 与 _gradeExtra.mix 的那一套 id。
            this._initMixPicker();
            // WebGL 不可用：混色器整组禁用并说明原因，其余功能照常
            const grpMix = $('grpMix');
            if (grpMix && window.QfsMix && !window.QfsMix.available()) {
                grpMix.classList.add('mix-na');
            }
        },

        /* ── 吸管取色（对齐 LR 的目标调整工具 / TAT）────────────────────
         * LR 的 HSL 面板有个「在图上点一下就锁到那条色带」的工具：点一处颜色，
         * 它按该像素的色相判断属于哪条带，之后上下拖就只改这一条。
         *
         * 这里照同一套：① 取色从**当前烘焙结果**采样（所见即所得，调过色相
         * 之后仍点得中眼睛看到的那个色）；② 命中判定用与 GL 着色器**完全
         * 相同**的带权重公式（clamp(1-d/hw) 再 smoothstep），保证"点中的那条"
         * 就是"着色器认为权重最大的那条"；③ 拖动只写当前子页的指标
         * （色相/饱和度/明亮度），与面板状态一致。
         *
         * 事件全走 capture 阶段并 stopPropagation：否则按下会被画布的平移/
         * 元素拖动接走，吸管就成了"点一下画面就跳"。
         */
        _initMixPicker() {
            const btn = document.getElementById('btnMixPick');
            const cv = this.dom && this.dom.canvas;
            if (!btn || !cv) return;
            const ov = document.getElementById('maskOverlay');
            const pane = (this.dom && this.dom.canvasPane) || document.getElementById('canvasPane');
            // 1×1 采样画布：只读回一个像素，比 getImageData 整幅便宜一个数量级
            const tmp = document.createElement('canvas');
            tmp.width = 1; tmp.height = 1;
            const st = this._mixPick = {
                on: false, band: null, metric: 'h', y0: 0, v0: 0, hue: 0,
                moved: false, raf: 0, pending: 0,
                ctx: tmp.getContext('2d', { willReadFrequently: true })
            };
            const METRIC_LABEL = { h: '色相', s: '饱和度', l: '明亮度' };
            let lastHover = 0;

            const setOn = (on) => {
                st.on = !!on;
                btn.classList.toggle('active', st.on);
                btn.setAttribute('aria-pressed', st.on ? 'true' : 'false');
                if (pane) pane.classList.toggle('mix-picking', st.on);
                if (st.on) {
                    this.setStatus('吸管：在照片上点一下取色，再上下拖动单独调这条色带（Esc 退出）');
                } else {
                    st.band = null;
                    this._mixPickHot(null);
                }
            };

            const onDown = (e) => {
                if (!st.on || e.button !== 0) return;
                const s = this._mixPickSample(e);
                if (!s) {
                    e.preventDefault(); e.stopPropagation();
                    this.setStatus('点在照片范围内取色（这里落在画布或边框上）');
                    return;
                }
                e.preventDefault(); e.stopPropagation();
                st.band = s.band;
                st.metric = this._mixMetric || 'h';
                st.y0 = e.clientY;
                st.v0 = this._mixPickValue(s.band.k, st.metric);
                st.hue = s.hue;
                st.moved = false;
                st.pending = st.v0;
                this._mixPickHot(s.band, st.metric);
                this.setStatus('已锁定「' + s.band.label + '」· 上下拖动调' +
                    (METRIC_LABEL[st.metric] || '数值') +
                    (s.flat ? '（此处接近中性灰，幅度有限）' : ''));
                document.addEventListener('mousemove', onDrag, true);
                document.addEventListener('mouseup', onUp, true);
            };

            const onDrag = (e) => {
                if (!st.on || !st.band) return;
                e.preventDefault(); e.stopPropagation();
                const dy = st.y0 - e.clientY;
                // 3px 死区：单击（或手抖）不该改数值，只用来锁色带
                if (!st.moved && Math.abs(dy) < 3) return;
                st.moved = true;
                const val = Math.max(-100, Math.min(100, Math.round(st.v0 + dy * 0.5)));
                if (val === st.pending) return;
                st.pending = val;
                if (st.raf) return;
                // 一帧只烘一次：拖动时 mousemove 比 rAF 密得多，逐条 setGrade 会白烘好几遍
                st.raf = requestAnimationFrame(() => {
                    st.raf = 0;
                    const band = st.band;
                    if (!band || !st.on) return;
                    const cur = this.gradeOf(this.image);
                    const m = Object.assign({}, cur.mix || {});
                    m[band.k] = Object.assign({ h: 0, s: 0, l: 0 }, m[band.k] || {},
                        { [st.metric]: st.pending });
                    this.setGrade({ mix: m });
                    this.setStatus('「' + band.label + '」' + (METRIC_LABEL[st.metric] || '') +
                        ' ' + fmt(st.pending));
                });
            };

            const onUp = () => {
                document.removeEventListener('mousemove', onDrag, true);
                document.removeEventListener('mouseup', onUp, true);
                if (!st.on || !st.band) return;
                if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
                if (st.moved) {
                    // 松手补全分辨率：拖动期间只走 1600px 低档，停在半截预览上不好看
                    const band = st.band;
                    setTimeout(() => { if (this.image) this.rebuildGrade('full'); }, 0);
                    this.setStatus('「' + band.label + '」' + (METRIC_LABEL[st.metric] || '') +
                        ' ' + fmt(st.pending));
                } else {
                    this.setStatus('已选中「' + st.band.label + '」' + Math.round(st.hue) +
                        '° · 上下拖动即可单独调' + (METRIC_LABEL[st.metric] || ''));
                }
            };

            // 悬停先给反馈：高亮即将命中的那条，用户还没按下就知道会点到哪
            const onHover = (e) => {
                if (!st.on || st.band) return;
                const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
                if (now - lastHover < 40) return;   // 40ms 节流：采样+高亮不必每像素一次
                lastHover = now;
                const s = this._mixPickSample(e);
                this._mixPickHot(s ? s.band : null, this._mixMetric || 'h');
            };

            btn.addEventListener('click', () => setOn(!st.on));
            for (const el of [cv, ov]) {
                if (!el) continue;
                el.addEventListener('mousedown', onDown, true);
                el.addEventListener('mousemove', onHover, true);
            }
            cv.addEventListener('mouseleave', () => {
                if (st.on && !st.band) this._mixPickHot(null);
            });
            document.addEventListener('keydown', (e) => {
                if (st.on && e.key === 'Escape') { setOn(false); this.setStatus('已退出吸管'); }
            });
        },

        /* 屏幕坐标 → 照片像素 → 色相 → 命中的色带。
           坐标口径：画布视觉矩形 = 整幅画布；_photoRect 与 _baseSize() 都是
           「基准坐标」（与蒙版浮层同一套），不能拿 canvas.width 直接比。 */
        _mixPickSample(e) {
            const cv = this.dom && this.dom.canvas;
            const im = this.image;
            const st = this._mixPick;
            if (!cv || !im || !im.el || !st || !st.ctx) return null;
            const rect = cv.getBoundingClientRect();
            if (!rect.width || !rect.height) return null;
            const pr = this._photoRect;
            if (!pr || !(pr.w > 0) || !(pr.h > 0)) return null;
            const base = (typeof this._baseSize === 'function')
                ? this._baseSize() : { w: cv.width, h: cv.height };
            const bx = (e.clientX - rect.left) / rect.width * base.w;
            const by = (e.clientY - rect.top) / rect.height * base.h;
            const nx = (bx - pr.x) / pr.w, ny = (by - pr.y) / pr.h;
            if (!(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) return null;
            // 采样源优先用烘焙后的降采样画布：拖过参数之后还能点中眼睛看到的颜色
            const src = (im._grade && (im._grade.low || im._grade.canvas)) || im.el;
            const W = src.width || src.naturalWidth || 0;
            const H = src.height || src.naturalHeight || 0;
            if (!W || !H) return null;
            const sx = Math.max(0, Math.min(W - 1, Math.floor(nx * W)));
            const sy = Math.max(0, Math.min(H - 1, Math.floor(ny * H)));
            let px = null;
            try {
                st.ctx.clearRect(0, 0, 1, 1);
                st.ctx.drawImage(src, sx, sy, 1, 1, 0, 0, 1, 1);
                px = st.ctx.getImageData(0, 0, 1, 1).data;
            } catch (_) { px = null; }
            if (!px) return null;
            const r = px[0] / 255, g = px[1] / 255, b = px[2] / 255;
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
            const l = (mx + mn) * 0.5;
            const den = 1 - Math.abs(2 * l - 1);
            const sat = (d > 1e-6 && den > 1e-4) ? d / den : 0;
            let hue = 0;
            if (d > 1e-6) {
                if (mx === r) hue = ((g - b) / d + 6) % 6;
                else if (mx === g) hue = (b - r) / d + 2;
                else hue = (r - g) / d + 4;
                hue *= 60;
            }
            hue = ((hue % 360) + 360) % 360;
            // 与着色器同一条判据：灰/近黑/近白本来就不参与混色器
            const flat = sat <= 0.003 || l <= 0.01 || l >= 0.99;
            return { hue, sat, light: l, flat, band: this._mixPickBand(hue) };
        },

        /* 与 GL 着色器完全相同的带权重：w = clamp(1 - d/hw, 0, 1)，再 smoothstep。
           权重全为 0（落在带间空档）时退到角度最近的那条，保证点了总有反馈。 */
        _mixPickBand(hue) {
            const bands = this.MIX_BANDS || [];
            let best = null, bestW = 0, near = null, nearD = 1e9;
            for (const b of bands) {
                let dd = Math.abs(hue - b.hue);
                dd = Math.min(dd, 360 - dd);
                if (dd < nearD) { nearD = dd; near = b; }
                const w = Math.max(0, 1 - dd / b.hw);
                const ww = w * w * (3 - 2 * w);
                if (ww > bestW) { bestW = ww; best = b; }
            }
            return bestW > 1e-4 ? best : near;
        },

        _mixPickValue(k, metric) {
            const g = this.gradeOf(this.image);
            const v = g && g.mix && g.mix[k];
            return v ? Math.round(Number(v[metric]) || 0) : 0;
        },

        /* 高亮命中的色带行：按 id 找行（slMix + 带 + 指标），不依赖 DOM 顺序 */
        _mixPickHot(band, metric) {
            const rows = document.querySelectorAll('#mixRows .mix-row');
            for (const r of rows) r.classList.remove('mix-hot');
            if (!band) return;
            const id = 'slMix' + band.k.toUpperCase() + (metric || this._mixMetric || 'h').toUpperCase();
            const inp = document.getElementById(id);
            const row = (inp && inp.closest) ? inp.closest('.param-row') : null;
            if (row) row.classList.add('mix-hot');
        },

        syncGradeExtraUI(p) {
            const ex = this._gradeExtra;
            if (!ex) return;
            const setOne = (rec, v) => {
                if (!rec) return;
                rec.inp.value = String(v);
                const text = labelText(rec, v);
                const id = rec.lbl ? rec.lbl.id : null;
                if (id && typeof this.updateLabel === 'function') this.updateLabel(id, text);
                else if (rec.lbl) rec.lbl.textContent = text;
            };
            for (const f of this.DET_FIELDS) setOne(ex.det[f.k], (p.det && p.det[f.k]) || 0);
            for (const f of this.CAL_FIELDS) setOne(ex.cal[f.k], (p.cal && p.cal[f.k]) || 0);
            for (const b of this.MIX_BANDS) {
                for (const mt of this.MIX_METRICS) {
                    const v = (p.mix && p.mix[b.k] && p.mix[b.k][mt.k]) || 0;
                    setOne(ex.mix[b.k + '.' + mt.k], v);
                }
            }
            const det = document.getElementById('grpDet'),
                cal = document.getElementById('grpCal'),
                mix = document.getElementById('grpMix');
            if (det) det.classList.toggle('grade-on', this.isDetActive(p.det));
            if (cal) cal.classList.toggle('grade-on', this.isCalActive(p.cal));
            if (mix) mix.classList.toggle('grade-on', this.isMixActive(p.mix));
        }
    });
})();
