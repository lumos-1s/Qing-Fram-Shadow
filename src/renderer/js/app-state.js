// 状态模块：删除等多种条件的变更提交 / 撤销栈（上限 50 步）—— 从 app.js 拆分
window.App = Object.assign(window.App || {}, {
    /* ══ 四方法核心 ══ */
    // 高频修改(拖滑块/输入文字):仅同步 + 防抖渲染,不压撤销栈
    onSettingChanged() {
        this.syncModelFromUI();
        this.saveCurrentTemplate();
        this.scheduleRender();
        // 导出尺寸提示依赖当前相框样式,样式一变就得重算。
        // 这是高频路径(拖滑块每帧都调),但 updateExportSizeNote 只做几次整数运算 + 一次
        // textContent 赋值,且尺寸下拉框多数时候为「原图尺寸」会直接早退,成本可忽略。
        this.updateExportSizeNote();
        this._autoSaveTimer && clearTimeout(this._autoSaveTimer);
        this._autoSaveTimer = setTimeout(() => this.autoSaveState(), 800);
    },

    autoSaveState() {
        try {
            if (!this.template) return;
            const s = {
                presetName: this.currentPresetName || '',
                photoFrameStyle: this.template.photoFrameStyle || '',
                userSignature: this.template.userSignature || '',
                signFont: this.template.signFont || '',
                signColor: this.template.signColor || '',
                signIncludeModel: this.template.signIncludeModel || 0,
                creditMode: this.template.creditMode || 0,
                avatarScale: this.template.avatarScale || 0.85,
                avatarShow: this.template.avatarShow === undefined ? 1 : this.template.avatarShow,
                signSize: this.template.signSize || 1,
                signBgBlur: this.template.signBgBlur || 0,
                paramColor: this.template.paramColor || 'auto',
                cornerRadiusAll: (this.template.cornerConfig || {}).cornerRadiusAll || 0,
                borderRadius: this.template.borderRadius || 0,
                paramFontSize: this.template.paramFontSize || 33,
                brandSize: this.template.brandSize || 1,
                brandLogo: this.template.brandLogo || 0,
                paramScale: this.template.paramScale || 1,
            };
            localStorage.setItem('qfs_last_state', JSON.stringify(s));
        } catch (_) {}
    },

    // 一次性提交(切换/勾选/按钮/change):压撤销栈 -> 清重做 -> 同步 -> 立即渲染
    // 若处于手势中(滑块/文本框已压过快照),则不重复压栈
    onSettingCommit() {
        if (!this._gesture) this.pushUndo();
        this._commit();
    },

    // 手势开始:滑块 pointerdown / 文本框 focus / 数值框首次输入时压入手势前快照
    beginGesture() {
        if (this._gesture || !this.template || !this.image) return;
        this._gesture = true;
        this._gesturePushed = true;
        // pushUndo 会清空重做栈；先留一份，Esc 取消时原样还回去。
        this._gestureRedo = this.redoStack.slice();
        this.pushUndo();
        // 拖拽/拖动滑块期间用 900px 低分辨率即时渲染,松手后恢复全分辨率,桌面交互更流畅
        if (this._gesturePrevMax == null) {
            this._gesturePrevMax = this.displayMax !== undefined ? this.displayMax : 1800;
            this.displayMax = 900;
        }
    },
    // 手势结束:pointerup / blur
    endGesture() {
        if (this._gesture) this._gesture = false;
        this._gesturePushed = false;
        this._gestureRedo = null;
        if (this._gesturePrevMax != null) {
            this.displayMax = this._gesturePrevMax;
            this._gesturePrevMax = null;
            this.scheduleRender(true);
        }
    },
    // 放弃手势(Esc 取消输入):丢弃 beginGesture 刚压入的快照,并恢复正常分辨率。
    // 只应在调用方确认这项手势是自己刚开启的时候使用。
    cancelGesture() {
        if (!this._gesture) return false;
        if (this._gesturePushed && this.undoStack.length) {
            this.undoStack.pop();
            this.updateHistoryButtons();
        }
        this._gesture = false;
        this._gesturePushed = false;
        if (this._gestureRedo) {
            this.redoStack = this._gestureRedo;
            this._gestureRedo = null;
            this.updateHistoryButtons();
        }
        if (this._gesturePrevMax != null) {
            this.displayMax = this._gesturePrevMax;
            this._gesturePrevMax = null;
            this.scheduleRender(true);
        }
        return true;
    },
    // 提交但不压栈(手势快照已在上一步压入)
    commitNoPush() { this._commit(); },
    _commit() {
        this.syncModelFromUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
    },
    /* ══ 撤销 / 重做 ══ */
    // 无条件压栈(离散操作/手势开始调用);连续手势的快照由 beginGesture 去重
    MAX_UNDO: 50,
    pushUndo() {
        this.undoStack.push(this.cloneTemplate());
        if (this.undoStack.length > this.MAX_UNDO) this.undoStack.shift();
        this.redoStack = [];
        this.updateHistoryButtons();
    },

    undo() {
        if (!this.undoStack.length) { this.setStatus('没有可撤销的操作'); return; }
        const hadPuzzle = !!(this.template && this.template.puzzle && this.template.puzzle.enabled);
        this.redoStack.push(this.cloneTemplate());
        this.template = this.undoStack.pop();
        this.normalizeTemplate();
        this.selectedEls = [];
        this.saveCurrentTemplate();
        this.refreshUI();
        this.scheduleRender(true);
        // 撤销把拼图整个撤掉时特别提示可重做救回:saveCurrentTemplate 会立刻把这份快照写回当前图,
        // 只有马上 Ctrl+Y 能恢复,过会儿再想起来就没了
        const nowPuzzle = !!(this.template && this.template.puzzle && this.template.puzzle.enabled);
        if (hadPuzzle && !nowPuzzle) this.setStatus('已撤销：拼图已撤掉，按 Ctrl+Y 可恢复');
        else this.setStatus('已撤销');
    },

    redo() {
        if (!this.redoStack.length) { this.setStatus('没有可重做的操作'); return; }
        this.undoStack.push(this.cloneTemplate());
        if (this.undoStack.length > this.MAX_UNDO) this.undoStack.shift();
        this.template = this.redoStack.pop();
        this.normalizeTemplate();
        this.selectedEls = [];
        this.saveCurrentTemplate();
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus('已重做');
    },

    updateHistoryButtons() {
        if (!this.dom.btnUndo) return;
        this.dom.btnUndo.disabled = !this.undoStack.length;
        this.dom.btnRedo.disabled = !this.redoStack.length;
    },

    cloneTemplate() {
        const t = JSON.parse(JSON.stringify(this.template || null));
        if (t && t._draftText) delete t._draftText;
        return t;
    },

    /* ══ 每图模板唯一存取口 ══ */
    // 每图模板有两处存储:imageTemplates Map(缩略图/切换恢复/草稿)与 im.customSettings
    // (.qfs 序列化/导出/对比原图)。历史上两处分散读写,出现过「同步只写 Map、导出仍取旧
    // customSettings」的 bug(0.1.12 修复)。新代码一律只走这三个方法:两处恒为同一对象。
    // getTpl 兼容旧会话里只写过单一侧的图片(按 Map → customSettings 回退)。
    getTpl(im) {
        if (!im) return null;
        return (this.imageTemplates && this.imageTemplates.get(im)) || im.customSettings || null;
    },
    // 深拷贝后写入两处(同一份);调用方持有原对象后续再改写不会牵连存储
    setTpl(im, snap) {
        if (!im) return null;
        if (snap == null) { this.clearTpl(im); return null; }
        const t = JSON.parse(JSON.stringify(snap));
        im.customSettings = t;
        this.imageTemplates.set(im, t);
        return t;
    },
    clearTpl(im) {
        if (!im) return;
        if (this.imageTemplates) this.imageTemplates.delete(im);
        delete im.customSettings;
    }
});
