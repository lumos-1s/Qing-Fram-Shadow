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
        'vec3 rgb2hsv(vec3 c){',
        '  vec4 K=vec4(0.0,-1.0/3.0,2.0/3.0,-1.0);',
        '  vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g));',
        '  vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r));',
        '  float d=q.x-min(q.w,q.y);',
        '  return vec3(abs(q.z+(q.w-q.y)/(6.0*d+1e-10)),d/(q.x+1e-10),q.x);',
        '}',
        'vec3 hsv2rgb(vec3 c){',
        '  vec4 K=vec4(1.0,2.0/3.0,1.0/3.0,3.0);',
        '  vec3 p=abs(fract(c.xxx+K.xyz)*6.0-K.www);',
        '  return c.z*mix(K.xxx,clamp(p-K.xxx,0.0,1.0),c.y);',
        '}',
        'void main(){',
        '  vec3 c=texture2D(uT,vUV).rgb;',
        '  vec3 hsv=rgb2hsv(c);',
        '  float wsum=0.0,dh=0.0,ds=0.0,dl=0.0;',
        '  for(int i=0;i<8;i++){',
        '    float d=abs(hsv.x*360.0-uHc[i]);',
        '    d=min(d,360.0-d);',
        '    float w=clamp(1.0-d/uHw[i],0.0,1.0);',
        '    w=w*w*(3.0-2.0*w);',
        '    wsum+=w;dh+=w*uDh[i];ds+=w*uDs[i];dl+=w*uDl[i];',
        '  }',
        '  if(wsum>0.001&&hsv.y>0.003){',
        '    hsv.x=fract(hsv.x+dh/wsum*0.1111);',
        '    hsv.y=clamp(hsv.y*(1.0+ds/wsum),0.0,1.0);',
        '    hsv.z=clamp(hsv.z*(1.0+0.55*dl/wsum),0.0,1.0);',
        '  }',
        '  gl_FragColor=vec4(hsv2rgb(hsv),1.0);',
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

    Object.assign(window.App || (window.App = {}), {
        _mixMetric: 'h',

        initGradeExtra() {
            const $ = (id) => document.getElementById(id);
            this._gradeExtra = { det: {}, cal: {}, mix: {} };
            const bind = (inp, lbl, apply) => {
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
                    clearTimeout(settle);
                    settle = setTimeout(() => { this.rebuildGrade('full'); thumb(); }, 220);
                });
                inp.addEventListener('change', () => {
                    clearTimeout(settle);
                    apply(Number(inp.value) || 0);
                    this.rebuildGrade('full');
                    thumb();
                });
                void lbl;
            };
            // 细节 / 校准：扁平参数组，patch 进 grade.det / grade.cal
            const bindGroup = (spec, key) => {
                for (const it of spec) {
                    const inp = $('sl' + it.id), lbl = $('lbl' + it.id);
                    if (inp) {
                        this._gradeExtra[key][it.k] = { inp, lbl };
                        bind(inp, lbl, (v) => {
                            const cur = this.gradeOf(this.image);
                            const g = Object.assign({}, cur[key] || {}, { [it.k]: v });
                            this.setGrade({ [key]: g });
                        });
                    }
                }
            };
            bindGroup(this.DET_FIELDS.map((f) => ({ k: f.k, id: 'Det' + f.k.charAt(0).toUpperCase() + f.k.slice(1) })), 'det');
            bindGroup(this.CAL_FIELDS.map((f) => ({ k: f.k, id: 'Cal' + f.k.toUpperCase() })), 'cal');
            // 混色器：24 个滑块（8 带 × 3 项），patch 进 grade.mix
            for (const b of this.MIX_BANDS) {
                for (const mt of this.MIX_METRICS) {
                    const id = 'Mix' + b.k.toUpperCase() + mt.k.toUpperCase();
                    const inp = $('sl' + id), lbl = $('lbl' + id);
                    if (inp) {
                        inp.style.setProperty('--h', String(b.hue));
                        this._gradeExtra.mix[b.k + '.' + mt.k] = { inp, lbl };
                        bind(inp, lbl, (v) => {
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
            // WebGL 不可用：混色器整组禁用并说明原因，其余功能照常
            const grpMix = $('grpMix');
            if (grpMix && window.QfsMix && !window.QfsMix.available()) {
                grpMix.classList.add('mix-na');
            }
        },

        syncGradeExtraUI(p) {
            const ex = this._gradeExtra;
            if (!ex) return;
            const setOne = (rec, v) => {
                if (!rec) return;
                rec.inp.value = String(v);
                const text = fmt(v);
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
