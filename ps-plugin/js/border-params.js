'use strict';
/* PS 插件的边框参数面板：直接改 template 上的既有字段，渲染仍交给桌面引擎。 */
(function () {
    let t = null;
    const GROUPS = [['basic', '基础'], ['fill', '填充'], ['stroke', '描边'],
        ['corner', '圆角'], ['shadow', '阴影 / 发光']];

    function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
    function hex(v, d) { const s = String(v || '').replace('#', ''); return /^[0-9a-f]{6}$/i.test(s) ? '#' + s : d; }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c])); }

    function applyGlobalMargin(scale) {
        const m = t.baseMargin || (t.baseMargin = {});
        if (m.refTop == null) {
            m.refTop = m.marginTop != null ? m.marginTop : 80;
            m.refBottom = m.marginBottom != null ? m.marginBottom : 120;
            m.refLeft = m.marginLeft != null ? m.marginLeft : 80;
            m.refRight = m.marginRight != null ? m.marginRight : 80;
        }
        m.marginTop = Math.round((m.refTop || 0) * scale);
        m.marginBottom = Math.round((m.refBottom || 0) * scale);
        m.marginLeft = Math.round((m.refLeft || 0) * scale);
        m.marginRight = Math.round((m.refRight || 0) * scale);
        m.globalMargin = scale;
    }

    function layerOf() {
        const list = t.layerList || (t.layerList = []);
        let l = list.find((x) => x && x.visible !== false);
        if (!l) { l = list[0] || {}; list[0] = l; }
        return l;
    }

    function defs() {
        const m = t.baseMargin || (t.baseMargin = {});
        const l = layerOf();
        const f = l.fillConfig || (l.fillConfig = {});
        const s = l.strokeConfig || (l.strokeConfig = {});
        const lc = l.cornerConfig || (l.cornerConfig = {});
        const sg = l.shadowGlowConfig || (l.shadowGlowConfig = {});
        const cc = t.cornerConfig || (t.cornerConfig = {});
        const set = (fn) => (v) => fn(v);
        return [
            { g: 'basic', label: '边距', type: 'range', min: 0, max: 200, step: 5, unit: '%',
              value: Math.round((m.globalMargin == null ? 1 : m.globalMargin) * 100), set: set(applyGlobalMargin) },
            { g: 'basic', label: '照片缩放', type: 'range', min: 50, max: 200, step: 5, unit: '%',
              value: Math.round((m.imgScale == null ? 1 : m.imgScale) * 100),
              set: set((v) => { m.imgScale = v / 100; }) },
            { g: 'basic', label: '照片圆角', type: 'range', min: 0, max: 200, step: 2, unit: '',
              value: Math.round(num(cc.cornerRadiusAll, 0)),
              set: set((v) => { cc.cornerRadiusAll = v; cc.cornerRadiusTL = cc.cornerRadiusTR = cc.cornerRadiusBL = cc.cornerRadiusBR = v; }) },

            { g: 'fill', label: '填充', type: 'select', value: f.fillType || 'transparent',
              options: [['transparent', '透明'], ['solid', '纯色'], ['gradient', '渐变'], ['texture', '纹理']],
              set: set((v) => { f.fillType = v; }) },
            { g: 'fill', label: '颜色', type: 'color', value: hex(f.fillHex, '#eeeeee'),
              set: set((v) => { f.fillHex = v.replace('#', ''); }) },
            { g: 'fill', label: '透明度', type: 'range', min: 0, max: 100, step: 1, unit: '%',
              value: Math.round(num(f.fillOpacity, 100)), set: set((v) => { f.fillOpacity = v; }) },
            { g: 'fill', label: '渐变角度', type: 'range', min: 0, max: 360, step: 5, unit: '°',
              value: Math.round(num(f.gradientAngle, 45)), set: set((v) => { f.gradientAngle = v; }) },

            { g: 'stroke', label: '宽度', type: 'range', min: 0, max: 80, step: 1, unit: '',
              value: Math.round(num(s.strokeWidth, 0)), set: set((v) => { s.strokeWidth = v; }) },
            { g: 'stroke', label: '位置', type: 'select', value: s.strokePos || 'inside',
              options: [['inside', '内侧'], ['center', '居中'], ['outside', '外侧']],
              set: set((v) => { s.strokePos = v; }) },
            { g: 'stroke', label: '颜色', type: 'color', value: hex(s.strokeColorHex, '#000000'),
              set: set((v) => { s.strokeColorHex = v.replace('#', ''); }) },
            { g: 'stroke', label: '透明度', type: 'range', min: 0, max: 100, step: 1, unit: '%',
              value: Math.round(num(s.strokeOpacity, 100)), set: set((v) => { s.strokeOpacity = v; }) },

            { g: 'corner', label: '边框圆角', type: 'range', min: 0, max: 200, step: 2, unit: '',
              value: Math.round(num(lc.cornerRadiusAll, 0)),
              set: set((v) => { lc.cornerRadiusAll = v; lc.cornerRadiusTL = lc.cornerRadiusTR = lc.cornerRadiusBL = lc.cornerRadiusBR = v; }) },

            { g: 'shadow', label: '阴影强度', type: 'range', min: 0, max: 100, step: 1, unit: '%',
              value: Math.round(num(sg.shadowOpacity, 35)),
              set: set((v) => { sg.shadowOpacity = v; sg.shadowEnable = v > 0 ? 1 : 0; }) },
            { g: 'shadow', label: '阴影颜色', type: 'color', value: hex(sg.shadowColorHex, '#000000'),
              set: set((v) => { sg.shadowColorHex = v.replace('#', ''); }) },
            { g: 'shadow', label: '模糊', type: 'range', min: 0, max: 100, step: 2, unit: '',
              value: Math.round(num(sg.shadowBlur, 20)), set: set((v) => { sg.shadowBlur = v; }) },
            { g: 'shadow', label: 'X 偏移', type: 'range', min: -60, max: 60, step: 2, unit: '',
              value: Math.round(num(sg.shadowOffsetX, 0)), set: set((v) => { sg.shadowOffsetX = v; }) },
            { g: 'shadow', label: 'Y 偏移', type: 'range', min: -60, max: 60, step: 2, unit: '',
              value: Math.round(num(sg.shadowOffsetY, 8)), set: set((v) => { sg.shadowOffsetY = v; }) },
            { g: 'shadow', label: '发光强度', type: 'range', min: 0, max: 100, step: 1, unit: '%',
              value: Math.round(num(sg.glowOpacity, 60)),
              set: set((v) => { sg.glowOpacity = v; sg.glowEnable = v > 0 ? 1 : 0; }) }
        ];
    }

    function row(c, id) {
        let input;
        if (c.type === 'range') {
            const shown = (Number(c.value) === 0) ? '0' : c.value + (c.unit || '');
            input = `<input type="range" data-bp="${id}" min="${c.min}" max="${c.max}" step="${c.step}" value="${c.value}">`
                + `<output data-out="${id}">${shown}</output>`;
        } else if (c.type === 'select') {
            input = `<select data-bp="${id}">` + c.options.map(([v, l]) =>
                `<option value="${v}"${v === c.value ? ' selected' : ''}>${l}</option>`).join('') + '</select>';
        } else {
            input = `<input type="color" data-bp="${id}" value="${c.value}">`;
        }
        return `<div class="ctl-row"><label>${esc(c.label)}</label>${input}</div>`;
    }

    function render() {
        const host = document.getElementById('borderParams');
        if (!host || !t) return;
        const list = defs();
        let out = '';
        GROUPS.forEach(([key, title], gi) => {
            const rows = list.filter((c) => c.g === key);
            if (!rows.length) return;
            const body = rows.map((c) => {
                const id = `${key}-${c.label}`;
                c._id = id;
                return row(c, id);
            }).join('');
            out += `<details${gi === 0 ? ' open' : ''}><summary>${title}</summary>${body}</details>`;
        });

        // 风格私有参数：缺省不写字段，改了才写进 styleParams
        const P = window.StyleParams;
        const style = String(t.photoFrameStyle || '').toUpperCase();
        const params = P && P.forStyle ? P.forStyle(style) : [];
        if (params.length) {
            const body = params.map((p) => {
                const id = `style-${p.key}`;
                const v = P.get(t, style, p);
                list.push({ _id: id, type: 'range', min: p.min, max: p.max, step: p.step,
                    set: (val) => P.set(t, style, p, val) });
                return row({ type: 'range', label: p.label, value: v, min: p.min, max: p.max, step: p.step, unit: p.unit || '%' }, id);
            }).join('');
            out += `<details><summary>样式参数</summary>${body}</details>`;
        }

        host.innerHTML = out;
        const byId = new Map(list.map((c) => [c._id, c]));
        host.querySelectorAll('[data-bp]').forEach((el) => {
            const c = byId.get(el.dataset.bp);
            if (!c) return;
            const ev = c.type === 'select' ? 'change' : 'input';
            el.addEventListener(ev, () => {
                const v = c.type === 'range' ? Number(el.value) : el.value;
                c.set(v);
                const o = host.querySelector(`[data-out="${el.dataset.bp}"]`);
                if (o) o.textContent = v + (c.unit || '');
            });
        });
    }

    window.QF_BorderParams = {
        setTemplate(x) { t = x; render(); },
        current() { return t; },
        render
    };
})();
