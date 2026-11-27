'use strict';
/* 预设可编辑文字：文字行 / 署名 / 风格自带文案。字段与桌面模板完全一致。 */
(function () {
    let t = null;
    let onChange = null;
    let ctls = [];

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }
    function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
    function hex(v, d) { const s = String(v || '').replace('#', ''); return /^[0-9a-f]{6}$/i.test(s) ? '#' + s : d; }
    function setPath(path, v) {
        let node = t;
        for (let i = 0; i < path.length - 1; i++) {
            const k = path[i];
            if (!node[k] || typeof node[k] !== 'object') node[k] = {};
            node = node[k];
        }
        node[path[path.length - 1]] = v;
    }
    function getPath(path, d) {
        let node = t;
        for (const k of path) {
            if (!node || typeof node !== 'object') return d;
            node = node[k];
        }
        return node == null ? d : node;
    }
    function ctl(type, label, value, setter, extra) {
        const id = ctls.length;
        ctls.push({ id, label, setter, type, unit: (extra && extra.unit) || '' });
        let input;
        if (type === 'range') {
            input = `<input type="range" data-tp="${id}" min="${extra.min}" max="${extra.max}" step="${extra.step}" value="${value}">`
                + `<output data-out="${id}">${value}${extra.unit || ''}</output>`;
        } else if (type === 'select') {
            input = `<select data-tp="${id}">` + extra.options.map(([v, l]) =>
                `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('') + '</select>';
        } else if (type === 'color') {
            input = `<input type="color" data-tp="${id}" value="${value}">`;
        } else {
            input = `<input type="text" data-tp="${id}" value="${esc(value)}">`;
        }
        return `<div class="exif-row"><label>${esc(label)}</label>${input}</div>`;
    }

    const CAPTIONS = [
        [['polaroidCaption'], '拍立得文案'],
        [['hassyCaption'], '哈苏文案'],
        [['appleCard', 'dateText'], '苹果卡日期'],
        [['xmLeica', 'brandText'], '联名品牌'],
        [['xmLeica', 'line1'], '联名第一行'],
        [['xmLeica', 'line2'], '联名第二行'],
        [['xmLeica', 'partnerBrand'], '联名合作方']
    ];

    function render() {
        const host = document.getElementById('textParams');
        if (!host || !t) return;
        ctls = [];
        const decor = t.decorConfig || (t.decorConfig = {});
        const lines = decor.textLines || (decor.textLines = []);
        let out = '';

        out += '<details open><summary>文字行</summary>';
        out += '<div class="text-acts"><button id="btnAddLine" type="button">＋ 添加文字</button></div>';
        lines.forEach((line, i) => {
            out += `<div class="line-head">第 ${i + 1} 行 <button class="line-del" data-del="${i}" type="button">删除</button></div>`;
            out += ctl('text', '内容', line.text || '', (v) => { line.text = v; });
            out += ctl('range', '字号', num(line.fontSize, 40), (v) => { line.fontSize = v; },
                { min: 8, max: 240, step: 1, unit: '' });
            out += ctl('color', '颜色', hex(line.colorHex, '#ffffff'), (v) => { line.colorHex = v; });
            out += ctl('select', '位置', line.align || 'bottom', (v) => { line.align = v; }, {
                options: [['free', '自由'], ['bottom', '底部'], ['top', '顶部'], ['exif', '参数条'], ['center', '居中']]
            });
            out += ctl('range', '透明度', num(line.opacity, 100), (v) => { line.opacity = v; },
                { min: 0, max: 100, step: 1, unit: '%' });
        });
        out += '</details>';

        out += '<details><summary>署名</summary>'
            + ctl('text', '内容', t.userSignature || '', (v) => { t.userSignature = v; })
            + ctl('range', '大小', num(t.signSize, 1), (v) => { t.signSize = v; },
                { min: 0.5, max: 2, step: 0.05, unit: '' })
            + ctl('color', '颜色', hex(t.signColor, '#555555'), (v) => { t.signColor = v; })
            + '</details>';

        const caps = CAPTIONS.filter(([path]) => getPath(path, null) != null);
        if (caps.length) {
            out += '<details><summary>风格文案</summary>' + caps.map(([path, label]) =>
                ctl('text', label, String(getPath(path, '')), (v) => setPath(path, v))
            ).join('') + '</details>';
        }

        host.innerHTML = out;
        host.querySelectorAll('[data-tp]').forEach((el) => {
            const c = ctls[Number(el.dataset.tp)];
            if (!c) return;
            const ev = c.type === 'select' ? 'change' : 'input';
            el.addEventListener(ev, () => {
                const v = c.type === 'range' ? Number(el.value) : el.value;
                c.setter(v);
                const o = host.querySelector(`[data-out="${c.id}"]`);
                if (o) o.textContent = v + c.unit;
                if (onChange) onChange();
            });
        });
        const add = host.querySelector('#btnAddLine');
        if (add) add.addEventListener('click', () => {
            const w = Number(t.__qfDocW) || 1000, h = Number(t.__qfDocH) || 1000;
            lines.push({
                text: '新文字', align: 'free', x: Math.round(w / 2), y: Math.round(h / 2),
                fontFamily: 'Microsoft YaHei', fontSize: Math.max(16, Math.round(Math.min(w, h) * 0.04)),
                fontWeight: 400, letterSpacing: 0, colorHex: '#ffffff', opacity: 100, rotation: 0
            });
            if (onChange) onChange();
            render();
        });
        host.querySelectorAll('[data-del]').forEach((b) => {
            b.addEventListener('click', () => {
                lines.splice(Number(b.dataset.del), 1);
                if (onChange) onChange();
                render();
            });
        });
    }

    window.QF_TextParams = {
        setTemplate(x) { t = x; render(); },
        current() { return t; },
        onChange(fn) { onChange = fn; },
        render
    };
})();
