// .qfs 模块:自包含工程文件(单文件 JSON:bundle 模板 + 源照片 base64 + 每图模板)
window.App = Object.assign(window.App || {}, {
    // 能不能直接拿 im.el 当编码源?仅当它是一块尺寸与 im.w/im.h 完全一致的 canvas ——
    // 也就是 applyOrientation 旋转后的产物(app.js:1302 建的 canvas,内容来自 JPEG 解码,必然不透明)。
    // 那种情况下"新建同尺寸画布 + 铺白底 + 1:1 blit"整步都是空操作,直接对原 canvas 编码得到的是
    // **逐字节相同**的 JPEG,却省掉一整块全分辨率画布(24MP ≈ 96MB)和一次全分辨率 blit。
    // 返回 null 表示必须走建画布的老路:源是 <img>,可能有 alpha,需要白底。
    qfsReusableSource(im) {
        const el = im && im.el;
        if (!el || el.tagName !== 'CANVAS') return null;
        if (el.width !== im.w || el.height !== im.h) return null;
        if (typeof el.toDataURL !== 'function') return null;
        return el;
    },

    // 把照片对象渲染进离屏画布,取 base64(仅导出时调用,限定内存开销)
    imageToQfsBase64(im, mime, quality) {
        // 工程文件要存调色后的成品：先补出全分辨率烘焙，再拿它当编码源
        if (window.ensureFullGrade) window.ensureFullGrade(im);
        const gradedCanvas = (im._grade && !im._grade.neutral && im._grade.canvas) ? im._grade.canvas : null;
        const reuse = gradedCanvas ? null : this.qfsReusableSource(im);
        if (reuse) return reuse.toDataURL(mime, quality).split(',')[1];
        const imSrc = gradedCanvas || im.el;
        const c = document.createElement('canvas');
        c.width = im.w; c.height = im.h;
        const cx = c.getContext('2d');
        if (mime === 'image/jpeg') {
            cx.fillStyle = '#ffffff';
            cx.fillRect(0, 0, c.width, c.height);
        }
        cx.drawImage(imSrc, 0, 0);
        const b64 = c.toDataURL(mime, quality).split(',')[1];
        // 显式释放后备缓冲:一张 24MP 画布约 96MB,不等 GC 能显著压低多图工程的峰值
        c.width = 0; c.height = 0;
        return b64;
    },

    // 工程里单张照片的描述。customSettings **刻意不再深拷贝**:单一存取口取出的就是存储本体,
    // 紧接着被 IPC 结构化克隆给主进程,中间没有任何代码改写它,多一次 JSON.parse(JSON.stringify())
    // 只是把带 base64 的模板(每个 logo 的 dataUrl 都在里面,量级 MB)白白搬一遍。
    qfsImageEntry(im, data) {
        return {
            name: im.name || 'photo',
            w: im.w, h: im.h,
            exif: im.exif || {},
            customSettings: this.getTpl(im) || null,
            data
        };
    },

    // .qfs 是不可信输入:名字会参与导出路径,模板会直接进渲染器。
    // 这里做最小但硬性的类型/长度校验,坏文件给可读错误而不是白屏。
    sanitizeImageName(name) {
        let s = String(name == null ? '' : name);
        // eslint-disable-next-line no-control-regex
        s = s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '').trim();
        if (!s) s = 'photo';
        return s.slice(0, 180);
    },

    validateQfsBundle(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) return '工程内容不是对象';
        const images = Array.isArray(data.images) ? data.images : [];
        if (images.length > 200) return '工程里的照片超过 200 张';
        let total = 0;
        for (const m of images) {
            if (!m || typeof m !== 'object') return '照片条目格式错误';
            if (typeof m.data !== 'string' || !m.data) return '照片缺少图像数据';
            if (m.data.length > 96 * 1024 * 1024) return '单张照片数据超过 96MB';
            if (!/^data:image\//i.test(m.data) && !/^[A-Za-z0-9+/=]+$/.test(m.data)) return '照片数据不是有效的 base64';
            total += m.data.length;
            if (total > 512 * 1024 * 1024) return '工程照片总大小超过 512MB';
            m.name = this.sanitizeImageName(m.name);
            m.w = Number.isFinite(+m.w) ? Math.min(Math.max(1, +m.w), 100000) : 1;
            m.h = Number.isFinite(+m.h) ? Math.min(Math.max(1, +m.h), 100000) : 1;
            if (m.customSettings != null && (typeof m.customSettings !== 'object' || Array.isArray(m.customSettings))) {
                m.customSettings = null;
            }
        }
        if (data.template != null && (typeof data.template !== 'object' || Array.isArray(data.template))) {
            data.template = null;
        }
        return '';
    },

    // 导出当前会话为 .qfs 工程(含所有照片 + 每图模板);无照片时退回纯模板 JSON
    async exportQFS() {
        if (!this.images || !this.images.length) { this.setStatus('请先导入照片再导出工程'); return; }
        this.syncModelFromUI();
        const name = (this.$('tfTemplateName') && this.$('tfTemplateName').value.trim()) || '未命名工程';
        let started;
        try {
            started = await window.qingframe.qfsBeginExport({
                name,
                session: { currentIdx: this.currentIdx },
                template: this.cloneTemplate()
            });
        } catch (e) {
            this.setStatus('导出失败：' + (e && e.message || e));
            return;
        }
        if (!started || started.canceled) { this.setStatus('已取消导出'); return; }
        if (!started.ok) { this.setStatus('导出失败：' + (started.error || '无法创建工程文件')); return; }
        // 逐张编码/写临时文件:任意时刻只驻留一张 base64,不再把整个工程堆进内存。
        let done = 0;
        try {
            for (const im of this.images) {
                let data = null;
                try { data = this.imageToQfsBase64(im, 'image/jpeg', 0.92); } catch (e) { data = null; }
                if (!data) throw new Error('照片编码失败：' + (im.name || '未知照片'));
                const entry = this.qfsImageEntry(im, null);
                delete entry.data;
                const r = await window.qingframe.qfsAddImage({ id: started.id, entry, data });
                if (!r || !r.ok) throw new Error(r && r.error || '写入工程失败');
                done++;
                this.setStatus(`正在写入工程 ${done}/${this.images.length}…`);
            }
            const r = await window.qingframe.qfsFinishExport(started.id);
            if (!r || !r.ok) throw new Error(r && r.error || '写入工程失败');
            this.setStatus(`工程已导出为「${name}.qfs」`);
        } catch (e) {
            try { await window.qingframe.qfsCancelExport(started.id); } catch (_) { /* ignore */ }
            this.setStatus('导出失败：' + (e && e.message || e));
        }
    },

    // 导入 .qfs 工程(自包含)或旧版裸模板 JSON(自动识别)
    async importQFS() {
        try {
            const r = await window.qingframe.openQfs();
            if (!r.ok) { this.setStatus(r.canceled ? '已取消' : '导入失败：' + (r.error || '')); return; }
            const data = r.data;
            if (!data || typeof data !== 'object') { this.setStatus('导入失败：文件内容无法识别'); return; }
            const bad = this.validateQfsBundle(data);
            if (bad) { this.setStatus('导入失败：' + bad); return; }
            if (Array.isArray(data.images) && data.images.length) {
                await this.restoreQfsProject(data, this.sanitizeImageName(r.name));
            } else {
                // 兼容旧版 .json 裸模板
                this.onSettingCommit();
                this.template = this.coerceTemplate(JSON.parse(JSON.stringify(data)));
                this.saveCurrentTemplate();
                this.refreshUI();
                this.scheduleRender(true);
                this.setStatus(`已导入模板「${r.name}」`);
            }
            this.refreshTemplates();
        } catch (e) {
            console.warn('[qfs] 导入失败:', e && e.message);
            this.setStatus('导入失败：工程文件损坏或格式不兼容');
        }
    },

    // 用 .qfs 内容重建会话(替换当前工作区)
    async restoreQfsProject(bundle, name) {
        const ims = [];
        const metas = bundle.images || [];
        for (const m of metas) {
            if (!m.data) continue;
            const img = new Image();
            const src = String(m.data).indexOf('data:') === 0 ? m.data : 'data:image/jpeg;base64,' + m.data;
            await new Promise(res => { img.onload = res; img.onerror = res; img.src = src; });
            if (!img.naturalWidth) continue;
            // 工程文件里的宽高元数据不可信;真实解码后再兜一次,防止解压炸弹直接 OOM。
            if (img.naturalWidth * img.naturalHeight > 200 * 1000 * 1000) {
                img.src = '';
                continue;
            }
            const exif = (m.exif && typeof m.exif === 'object') ? m.exif : {};
            const oriented = await this.applyOrientation(img, exif.orientation);
            const useEl = oriented ? oriented.el : img;
            const im = {
                el: useEl,
                name: m.name || 'photo',
                w: oriented ? oriented.w : img.naturalWidth,
                h: oriented ? oriented.h : img.naturalHeight,
                exif,
                customSettings: null
            };
            if (m.customSettings) {
                this.setTpl(im, this.coerceTemplate(JSON.parse(JSON.stringify(m.customSettings))));
            }
            this.queueThumb(im);
            ims.push(im);
        }
        if (!ims.length) { this.setStatus('导入失败：工程里没有可恢复的照片'); return; }
        this.onSettingCommit();
        this.images = ims;
        this.selectedIdx = [];
        this.batchSel = [];
        const ci = Math.min(Math.max(0, (bundle.session && bundle.session.currentIdx) || 0), ims.length - 1);
        this.currentIdx = ci;
        this.image = ims[ci];
        const savedTpl = this.getTpl(this.image);
        this.template = this.coerceTemplate(savedTpl
            ? JSON.parse(JSON.stringify(savedTpl))
            : (bundle.template ? JSON.parse(JSON.stringify(bundle.template)) : this.defaultTemplate()));
        this.invalidateStyleCaches();
        this.buildThumbnails();
        this.afterImageSelect();
        this.refreshUI();
        this.scheduleRender(true);
        this.saveDraftNow();
        this.setStatus(`已打开工程「${name}」（${ims.length} 张照片）`);
    }
});