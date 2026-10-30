'use strict';
/* 自然饱和度 + 颜色分级：像素自己的饱和度/亮度决定权重，逐通道 LUT 表达不了，
 * 所以放在基础调色、曲线之后做一次后置 pass。
 *
 * 1) 有 WebGL 时单 pass（1600px 预览 <2ms，全尺寸个位数毫秒）。
 * 2) WebGL 不可用/上下文丢失时退回 Canvas2D 逐像素兼容路径：拖动中的 1600px
 *    预览可接受，全尺寸只在松手/导出时烘焙一次。
 * 3) 颜色分级数据模型在 app-grade.js（CG_ZONES / sanitizeCg），这里只负责
 *    渲染和 UI 绑定；参数随 grade 一起存草稿。
 */
(function () {
    const VS = 'attribute vec2 aP;varying vec2 vUV;void main(){vUV=aP*0.5+0.5;gl_Position=vec4(aP,0.0,1.0);}';
    const FS = [
        // 三维 LUT 的切片纹理宽 33×33=1089，mediump 的小数精度（约 1/2048）不够
        // 定位到 1/1089 的纹素中心，会出现整片偏色；有 highp 就用 highp。
        '#ifdef GL_FRAGMENT_PRECISION_HIGH',
        'precision highp float;',
        '#else',
        'precision mediump float;',
        '#endif',
        'varying vec2 vUV;',
        'uniform sampler2D uT;',
        'uniform sampler2D uLut;',
        'uniform float uLutOn;',
        'uniform float uGrid;',
        'uniform float uVib;',
        'uniform float uCg[12];',
        'uniform float uCgBlend;',
        'uniform float uCgBalance;',
        'uniform float uBw[8];',
        'uniform float uBwOn;',
        'uniform float uHc[8];',
        'uniform float uHw[8];',
        'uniform float uAspect;',
        'uniform float uDistort;',
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
        'const vec3 LUMA=vec3(0.2126,0.7152,0.0722);',
        'vec3 applyZone(vec3 c,float hue,float sat,float lum,float w,float y){',
        '  float gate=smoothstep(0.0,0.06,y);',
        '  if(sat>0.0001){',
        '    vec3 t=hsv2rgb(vec3(hue,1.0,1.0));',
        '    float ty=dot(t,LUMA);',
        '    vec3 tv=t-vec3(ty);',
        '    c+=tv*(sat*0.40*w*gate);',
        '  }',
        '  if(abs(lum)>0.0001) c*=1.0+lum*0.5*w;',
        '  return c;',
        '}',
        // 三维 LUT：33 张切片横向排成 1089×33 的条带（WebGL1 没有 TEXTURE_3D）。
        // 蓝当下标选切片、红在切片内横向、绿纵向，三线性里的两次双线性手工做。
        // 采样点内缩半纹素（+0.5），这样 LINEAR 不会跨切片渗色。
        'vec3 lutLookup(vec3 c){',
        '  float g=uGrid;',
        '  float z=clamp(c.b,0.0,1.0)*(g-1.0);',
        '  float b0=floor(z);',
        '  float fb=z-b0;',
        '  b0=min(b0,g-2.0);',
        '  float rx=(clamp(c.r,0.0,1.0)*(g-1.0)+0.5)/g;',
        '  float gy=(clamp(c.g,0.0,1.0)*(g-1.0)+0.5)/g;',
        '  vec3 s0=texture2D(uLut,vec2((b0+rx)/g,gy)).rgb;',
        '  vec3 s1=texture2D(uLut,vec2((b0+1.0+rx)/g,gy)).rgb;',
        '  return mix(s0,s1,fb);',
        '}',
        'void main(){',
        // 镜头畸变：径向重采样（uDistort>0 拉直桶形、<0 拉直枕形）。
        // 必须在这里做而不是 Canvas2D —— 2D 逐像素重采样没有双线性插值，
        // 边缘会出现锯齿；GL 的 LINEAR 采样天然带插值。
        // 几何在校色之前：Compositor 也是先 geometry 再上颜色表。
        '  vec2 uv=vUV;',
        '  if(abs(uDistort)>0.0001){',
        '    vec2 pp=(uv-0.5)*vec2(uAspect,1.0);',
        '    float r2=dot(pp,pp);',
        '    pp*=1.0+uDistort*r2;',
        '    uv=clamp(0.5+pp/vec2(uAspect,1.0),vec2(0.0),vec2(1.0));',
        '  }',
        '  vec3 c=texture2D(uT,uv).rgb;',
        '  if(uLutOn>0.5){',
        // 实测表路径：校准 / 饱和度 / 自然饱和度 / 混色器 / 颜色分级 全在这一张
        // 三维表里（它们都是跨通道操作，逐通道 LUT 和手写公式都学不像）。
        '    c=lutLookup(c);',
        '  } else {',
        '    vec3 hsv=rgb2hsv(c);',
        '    float vib=uVib*(1.0-hsv.y);',
        '    hsv.y=clamp(hsv.y*(1.0+vib*1.2),0.0,1.0);',
        '    c=hsv2rgb(hsv);',
        '    float y=dot(c,LUMA);',
        '    float bal=uCgBalance*0.15;',
        '    float lo=0.34+bal;',
        '    float hi=0.66+bal;',
        '    float soft=mix(0.035,0.22,uCgBlend);',
        '    float wS=1.0-smoothstep(lo-soft,lo+soft,y);',
        '    float wH=smoothstep(hi-soft,hi+soft,y);',
        '    float wM=clamp(1.0-wS-wH,0.0,1.0);',
        '    float ws=wS+wM+wH;',
        '    if(ws>0.0001){wS/=ws;wM/=ws;wH/=ws;}',
        '    c=applyZone(c,uCg[0],uCg[1],uCg[2],wS,y);',
        '    c=applyZone(c,uCg[3],uCg[4],uCg[5],wM,y);',
        '    c=applyZone(c,uCg[6],uCg[7],uCg[8],wH,y);',
        '    c=applyZone(c,uCg[9],uCg[10],uCg[11],1.0,y);',
        '  }',
        // 黑白混色器：按色相带加权决定「这个颜色转灰后有多亮」。
        // 灰/近灰不参与（没有色相可言），否则整片灰底会被某个带误伤。
        '  if(uBwOn>0.5){',
        '    float y0=dot(c,LUMA);',
        '    vec3 bh=rgb2hsv(clamp(c,0.0,1.0));',
        '    float gate=smoothstep(0.0,0.08,bh.y);',
        '    float wsum=0.0,adj=0.0;',
        '    for(int i=0;i<8;i++){',
        '      float d=abs(bh.x*360.0-uHc[i]);',
        '      d=min(d,360.0-d);',
        '      float w=clamp(1.0-d/uHw[i],0.0,1.0);',
        '      w=w*w*(3.0-2.0*w);',
        '      wsum+=w;adj+=w*uBw[i];',
        '    }',
        '    float k=wsum>0.001?adj/wsum:0.0;',
        // 1.4：PS/LR 的黑白混色器给单个色相的权重能到 2~3 倍，
        // 系数太小时纯红拉满也只从 43 到 60，等于「有滑块但看不出变化」。
        '    float g=clamp(y0*(1.0+k*1.4*gate),0.0,1.0);',
        '    c=vec3(g);',
        '  }',
        '  gl_FragColor=vec4(clamp(c,0.0,1.0),1.0);',
        '}'
    ].join('\n');

    let gl = null, glc = null, prog = null, uni = null, quad = null, tex = null;
    let lutTex = null, lutKey = '';

    function initGL() {
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
                gl = null; prog = null; uni = null; tex = null;
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
            tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            // 三维 LUT 的条带纹理（33 张 33×33 切片横排），LINEAR 用于切片内插值
            lutTex = gl.createTexture();
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, lutTex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.activeTexture(gl.TEXTURE0);
            uni = {
                cg: gl.getUniformLocation(prog, 'uCg[0]'),
                blend: gl.getUniformLocation(prog, 'uCgBlend'),
                balance: gl.getUniformLocation(prog, 'uCgBalance'),
                vib: gl.getUniformLocation(prog, 'uVib'),
                bw: gl.getUniformLocation(prog, 'uBw[0]'),
                bwOn: gl.getUniformLocation(prog, 'uBwOn'),
                hc: gl.getUniformLocation(prog, 'uHc[0]'),
                hw: gl.getUniformLocation(prog, 'uHw[0]'),
                aspect: gl.getUniformLocation(prog, 'uAspect'),
                distort: gl.getUniformLocation(prog, 'uDistort'),
                lutOn: gl.getUniformLocation(prog, 'uLutOn'),
                grid: gl.getUniformLocation(prog, 'uGrid'),
                lut: gl.getUniformLocation(prog, 'uLut')
            };
            gl.uniform1i(gl.getUniformLocation(prog, 'uT'), 0);
            gl.uniform1i(uni.lut, 1);
            lutKey = '';
            return true;
        } catch (_) {
            gl = null; prog = null; uni = null; tex = null; lutTex = null;
            return false;
        }
    }

    function cgValues(p) {
        const cg = (p && p.cg) || null;
        const zones = (window.App && window.App.CG_ZONES) || [
            { k: 'shadow' }, { k: 'mid' }, { k: 'high' }, { k: 'global' }
        ];
        const out = [];
        for (const z of zones) {
            const v = (cg && cg[z.k]) || {};
            out.push((Number(v.h) || 0) / 360, (Number(v.s) || 0) / 100, (Number(v.l) || 0) / 100);
        }
        return out;
    }

    function passGL(src, p, w, h, lut) {
        if (!initGL()) return null;
        try {
            if (glc.width !== w || glc.height !== h) { glc.width = w; glc.height = h; }
            gl.viewport(0, 0, w, h);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
            // 实测三维表：校准 / 饱和度 / 自然饱和度 / 混色器 / 颜色分级 都在这里，
            // 于是这几项的手写公式必须让位（否则会叠加两次）。
            const lutOn = !!(lut && lut.rgba && lut.grid > 1);
            gl.uniform1f(uni.lutOn, lutOn ? 1 : 0);
            if (lutOn) {
                const key = lut.grid + '#' + lut.rgba.length + '#' + lut.token;
                if (key !== lutKey) {
                    gl.activeTexture(gl.TEXTURE1);
                    gl.bindTexture(gl.TEXTURE_2D, lutTex);
                    // UNPACK_FLIP_Y 是上下文级别的：源图上传需要翻转（画布 y 向下、
                    // 纹理 t 向上），但 LUT 条带一翻就把绿轴上下颠倒，必须临时关掉。
                    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lut.grid * lut.grid, lut.grid, 0,
                        gl.RGBA, gl.UNSIGNED_BYTE, lut.rgba);
                    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
                    gl.activeTexture(gl.TEXTURE0);
                    lutKey = key;
                }
                gl.uniform1f(uni.grid, lut.grid);
            }
            gl.uniform1f(uni.vib, lutOn ? 0 : (Number(p.vib) || 0) / 100);
            const cg = p.cg || {};
            gl.uniform1fv(uni.cg, new Float32Array(lutOn ? new Array(12).fill(0) : cgValues(p)));
            gl.uniform1f(uni.blend, Number.isFinite(Number(cg.blending)) ? Number(cg.blending) / 100 : 0.5);
            gl.uniform1f(uni.balance, (Number(cg.balance) || 0) / 100);
            const bw = p.bw || null;
            const bwOn = !!(bw && bw.on !== 0);
            const bwVals = [], hc = [], hw = [];
            const bands = (window.App && window.App.BW_BANDS) || [];
            for (const b of bands) {
                bwVals.push(bwOn ? (Number(bw[b.k]) || 0) / 100 : 0);
                hc.push(b.hue);
                hw.push(b.hw);
            }
            gl.uniform1f(uni.bwOn, bwOn ? 1 : 0);
            gl.uniform1fv(uni.bw, new Float32Array(bwVals));
            gl.uniform1fv(uni.hc, new Float32Array(hc));
            gl.uniform1fv(uni.hw, new Float32Array(hw));
            const lc = p.lc || null;
            gl.uniform1f(uni.aspect, w / Math.max(1, h));
            // 0.28：满档时边缘位移约 28%（大约相当于 ±15 的镜头畸变值）
            gl.uniform1f(uni.distort, lc ? (Number(lc.distort) || 0) / 100 * 0.28 : 0);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            return glc;
        } catch (_) {
            return null;
        }
    }

    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
    function smoothstep(a, b, x) {
        const t = clamp01((x - a) / Math.max(1e-6, b - a));
        return t * t * (3 - 2 * t);
    }
    function luma(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
    function rgb2hsv(r, g, b) {
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        let h = 0;
        if (d > 1e-9) {
            if (mx === r) h = ((g - b) / d) % 6;
            else if (mx === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h /= 6;
            if (h < 0) h += 1;
        }
        return [h, mx > 1e-9 ? d / mx : 0, mx];
    }
    function hsv2rgb(h, s, v) {
        const i = Math.floor(h * 6), f = h * 6 - i;
        const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
        switch (i % 6) {
            case 0: return [v, t, p];
            case 1: return [q, v, p];
            case 2: return [p, v, t];
            case 3: return [p, q, v];
            case 4: return [t, p, v];
            default: return [v, p, q];
        }
    }

    // 注意：2D 兜底**不做**镜头畸变（逐像素重采样无插值，边缘必然锯齿）。
    // 调用方在 GL 不可用时会提示「镜头校正需要 WebGL」，颜色部分照常生效。
    function pass2d(src, p, w, h) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        if (!g) return null;
        g.drawImage(src, 0, 0, w, h);
        let img;
        try { img = g.getImageData(0, 0, w, h); } catch (_) { return null; }
        const d = img.data;
        const zones = (window.App && window.App.CG_ZONES) || [
            { k: 'shadow' }, { k: 'mid' }, { k: 'high' }, { k: 'global' }
        ];
        const cg = p.cg || {};
        const zs = zones.map((z) => {
            const v = cg[z.k] || {};
            const hue = (Number(v.h) || 0) / 360;
            const sat = (Number(v.s) || 0) / 100;
            const lum = (Number(v.l) || 0) / 100;
            const t = hsv2rgb(hue, 1, 1);
            const ty = luma(t[0], t[1], t[2]);
            return { sat, lum, tr: t[0] - ty, tg: t[1] - ty, tb: t[2] - ty };
        });
        const blend = Number.isFinite(Number(cg.blending)) ? Math.max(0, Math.min(1, Number(cg.blending) / 100)) : 0.5;
        const bal = (Number(cg.balance) || 0) / 100 * 0.15;
        const soft = 0.035 + (0.22 - 0.035) * blend;
        const lo = 0.34 + bal, hi = 0.66 + bal;
        const vibN = (Number(p.vib) || 0) / 100;
        const bwOn = !!(p.bw && p.bw.on !== 0);
        const bwBands = (window.App && window.App.BW_BANDS) || [];
        for (let i = 0; i < d.length; i += 4) {
            let r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
            if (vibN) {
                const hsv = rgb2hsv(r, gg, b);
                const vib = vibN * (1 - hsv[1]);
                hsv[1] = clamp01(hsv[1] * (1 + vib * 1.2));
                const rgb = hsv2rgb(hsv[0], hsv[1], hsv[2]);
                r = rgb[0]; gg = rgb[1]; b = rgb[2];
            }
            const y = luma(r, gg, b);
            let wS = 1 - smoothstep(lo - soft, lo + soft, y);
            let wH = smoothstep(hi - soft, hi + soft, y);
            let wM = clamp01(1 - wS - wH);
            const ws = wS + wM + wH;
            if (ws > 1e-6) { wS /= ws; wM /= ws; wH /= ws; }
            const gate = smoothstep(0, 0.06, y);
            const weights = [wS, wM, wH, 1];
            for (let k = 0; k < 4; k++) {
                const z = zs[k], w = weights[k];
                if (!z || w <= 0) continue;
                if (z.sat > 0.0001) {
                    const a = z.sat * 0.40 * w * gate;
                    r += z.tr * a; gg += z.tg * a; b += z.tb * a;
                }
                if (Math.abs(z.lum) > 0.0001) {
                    const f = 1 + z.lum * 0.5 * w;
                    r *= f; gg *= f; b *= f;
                }
            }
            if (bwOn) {
                // 与 GL 路径同一套：按色相带加权决定该颜色转灰后的亮度
                const h2 = rgb2hsv(clamp01(r), clamp01(gg), clamp01(b));
                const gate = smoothstep(0, 0.08, h2[1]);
                let wsum = 0, adj = 0;
                for (const b0 of bwBands) {
                    let dd = Math.abs(h2[0] * 360 - b0.hue);
                    dd = Math.min(dd, 360 - dd);
                    let w = clamp01(1 - dd / b0.hw);
                    w = w * w * (3 - 2 * w);
                    wsum += w;
                    adj += w * ((Number(p.bw[b0.k]) || 0) / 100);
                }
                const kk = wsum > 1e-3 ? adj / wsum : 0;
                const y0 = luma(clamp01(r), clamp01(gg), clamp01(b));
                const g0 = clamp01(y0 * (1 + kk * 1.4 * gate));
                r = g0; gg = g0; b = g0;
            }
            d[i] = Math.round(clamp01(r) * 255);
            d[i + 1] = Math.round(clamp01(gg) * 255);
            d[i + 2] = Math.round(clamp01(b) * 255);
        }
        g.putImageData(img, 0, 0);
        return c;
    }

    window.QfsColor = {
        pass(src, p, w, h, lut) {
            const out = passGL(src, p, w, h, lut);
            return out || pass2d(src, p, w, h);
        },
        available() { return true; },
        usingGL() { return initGL(); }
    };

    // ── UI：黑白混色器（对齐 LR 的 Black & White / GrayMixer）──────
    function initBw() {
        const $ = (id) => document.getElementById(id);
        const chk = $('cbBwOn');
        if (!chk) return;
        const app = window.App;
        const ids = (app.BW_KEYS || []).map((k) => k.toUpperCase());
        const inputs = ids.map((K) => $('slBw' + K));
        let settle = 0;
        const commit = (patch) => {
            if (!app.image) return;
            const cur = app.gradeOf(app.image).bw || app.defaultBw();
            app.setGrade({ bw: Object.assign({}, cur, patch) });
            clearTimeout(settle);
            settle = setTimeout(() => app.rebuildGrade('full'), 220);
        };
        chk.addEventListener('change', () => {
            if (chk.checked) commit({ on: 1 });
            else { app.setGrade({ bw: null }); app.rebuildGrade('full'); }
        });
        inputs.forEach((inp, i) => {
            if (!inp) return;
            inp.addEventListener('input', () => commit({ [app.BW_KEYS[i]]: Number(inp.value) || 0 }));
            inp.addEventListener('change', () => {
                commit({ [app.BW_KEYS[i]]: Number(inp.value) || 0 });
                clearTimeout(settle);
                app.rebuildGrade('full');
            });
        });
    }

    function syncBwUI(p) {
        const $ = (id) => document.getElementById(id);
        const chk = $('cbBwOn');
        if (!chk) return;
        const app = window.App;
        const bw = p && p.bw;
        const on = !!(bw && bw.on !== 0);
        chk.checked = on;
        for (const k of (app.BW_KEYS || [])) {
            const K = k.toUpperCase();
            const inp = $('slBw' + K);
            const v = on ? (Number(bw[k]) || 0) : 0;
            if (inp) inp.value = String(v);
            const id = 'lblBw' + K;
            const text = v === 0 ? '0' : (v > 0 ? '+' + v : String(v));
            if (app.updateLabel) app.updateLabel(id, text);
            else { const el = $(id); if (el) el.textContent = text; }
        }
        const grp = $('grpBw');
        if (grp) grp.classList.toggle('grade-on', on);
    }

    Object.assign(window.App || (window.App = {}), { initBw, syncBwUI });

    // ── UI：颜色分级 ─────────────────────────────────────────────
    function fmt(v) { return v === 0 ? '0' : (v > 0 ? '+' + v : String(v)); }
    function cloneCg(cg) {
        return cg ? JSON.parse(JSON.stringify(cg)) : (window.App.defaultCg ? window.App.defaultCg() : null);
    }

    Object.assign(window.App || (window.App = {}), {
        _cgZone: 'shadow',

        initColorGrade() {
            const $ = (id) => document.getElementById(id);
            const grp = $('grpColorGrade');
            if (!grp) return;
            const q = (id) => $('slCg' + id);
            this._cgExtra = {
                hue: q('Hue'), sat: q('Sat'), lum: q('Lum'),
                blend: q('Blending'), balance: q('Balance'),
                labels: {
                    hue: $('lblCgHue'), sat: $('lblCgSat'), lum: $('lblCgLum'),
                    blend: $('lblCgBlending'), balance: $('lblCgBalance')
                }
            };
            const thumb = () => {
                const im = this.image;
                if (im && this.renderFramedThumb) {
                    clearTimeout(im._gradeThumbT);
                    im._gradeThumbT = setTimeout(() => this.renderFramedThumb(im), 260);
                }
            };
            const bind = (inp, apply) => {
                if (!inp) return;
                let settle = 0;
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
            };
            const edit = (key, v) => {
                if (!this.image) return;
                const cg = cloneCg(this.gradeOf(this.image).cg);
                if (key === 'blending' || key === 'balance') cg[key] = v;
                else {
                    const zone = this._cgZone || 'shadow';
                    cg[zone] = Object.assign({ h: 0, s: 0, l: 0 }, cg[zone] || {}, { [key]: v });
                }
                this.setGrade({ cg });
            };
            bind(this._cgExtra.hue, (v) => edit('h', v));
            bind(this._cgExtra.sat, (v) => edit('s', v));
            bind(this._cgExtra.lum, (v) => edit('l', v));
            bind(this._cgExtra.blend, (v) => edit('blending', v));
            bind(this._cgExtra.balance, (v) => edit('balance', v));

            const tabs = $('cgZones');
            if (tabs) {
                const btns = Array.prototype.slice.call(tabs.querySelectorAll('.curve-chan'));
                btns.forEach((btn) => {
                    btn.addEventListener('click', () => {
                        this._cgZone = btn.dataset.cg || 'shadow';
                        this.syncColorGradeUI(this.gradeOf(this.image));
                    });
                });
            }
            const reset = $('btnCgReset');
            if (reset) {
                reset.addEventListener('click', () => {
                    this.setGrade({ cg: null });
                    this.setStatus('已重置颜色分级');
                });
            }
        },

        syncColorGradeUI(p) {
            const ex = this._cgExtra;
            if (!ex) return;
            const cg = (p && p.cg) || (this.defaultCg ? this.defaultCg() : null);
            if (!cg) return;
            const zoneKey = this._cgZone || 'shadow';
            const z = cg[zoneKey] || { h: 0, s: 0, l: 0 };
            const setOne = (inp, lbl, v, text) => {
                if (inp) inp.value = String(v);
                if (lbl) {
                    if (lbl.id && typeof this.updateLabel === 'function') this.updateLabel(lbl.id, text);
                    else lbl.textContent = text;
                }
            };
            setOne(ex.hue, ex.labels.hue, z.h || 0, String(Math.round(z.h || 0)));
            setOne(ex.sat, ex.labels.sat, z.s || 0, String(Math.round(z.s || 0)));
            setOne(ex.lum, ex.labels.lum, z.l || 0, fmt(Math.round(z.l || 0)));
            setOne(ex.blend, ex.labels.blend, cg.blending == null ? 50 : cg.blending,
                String(Math.round(cg.blending == null ? 50 : cg.blending)));
            setOne(ex.balance, ex.labels.balance, cg.balance || 0, fmt(Math.round(cg.balance || 0)));

            const tabs = document.getElementById('cgZones');
            if (tabs) {
                const btns = Array.prototype.slice.call(tabs.querySelectorAll('.curve-chan'));
                btns.forEach((btn) => {
                    const on = (btn.dataset.cg || 'shadow') === zoneKey;
                    btn.classList.toggle('active', on);
                    const zz = cg[btn.dataset.cg || 'shadow'] || {};
                    const s = Number(zz.s) || 0;
                    btn.style.setProperty('--cg-color', s > 0
                        ? 'hsl(' + (Number(zz.h) || 0) + ' 65% 52%)' : 'transparent');
                    btn.title = '色相 ' + Math.round(Number(zz.h) || 0) +
                        '° / 饱和 ' + Math.round(s) + ' / 明亮 ' + Math.round(Number(zz.l) || 0);
                });
            }
            const grp = document.getElementById('grpColorGrade');
            if (grp) grp.classList.toggle('grade-on', !!(this.isCgActive && this.isCgActive(p && p.cg)));
        }
    });
})();
