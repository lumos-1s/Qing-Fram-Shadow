// 启动页面:填充加载进度文案,三路资源(预设/标志/纹理)就绪后淡出
window.App = Object.assign(window.App || {}, {
    // 由 init() 调用一次,注入开始文案并兜底 8 秒强制放行(避免加载异常时卡死)
    initSplash() {
        this._splashDone = false;
        this._splashEl = document.getElementById('splash');
        const st = document.getElementById('splashStatus');
        this._splashStatusEl = st;
        if (st) st.textContent = '正在启动…';
        // 加载兜底:8 秒内无论如何都撤掉启动页
        this._splashFailSafe = setTimeout(() => this.teardownSplash(), 8000);
    },

    // 更新启动页状态文案(用于各加载阶段)
    splashStatus(msg) {
        if (this._splashStatusEl && msg != null) this._splashStatusEl.textContent = msg;
    },

    // 追加一个"启动页要等它"的任务(例如预设墙封面解码)。
    // 默认仍是 3 路(预设/标志/纹理),加了任务就多等一个,避免"资源没齐就放行"。
    splashExpect(n) {
        this._splashNeed = (this._splashNeed || 3) + (n == null ? 1 : n);
    },

    // 真实进度(0..1):切到确定态进度条,不再用来回滑动的装饰动画
    splashProgress(p) {
        const bar = this._splashEl && this._splashEl.querySelector('.splash-bar');
        if (!bar) return;
        const v = Math.max(0, Math.min(1, Number(p) || 0));
        bar.classList.add('det');
        bar.style.width = (v * 100).toFixed(1) + '%';
    },

    // 每个异步加载任务完成时调用一次;全部就绪后收起启动页
    splashTick() {
        this._splashTasks = (this._splashTasks || 0) + 1;
        if (this._splashTasks >= (this._splashNeed || 3)) this.teardownSplash();
    },

    // 全部资源就绪后调用:淡出并移除启动页
    teardownSplash() {
        if (this._splashDone) return;
        this._splashDone = true;
        clearTimeout(this._splashFailSafe);
        const el = this._splashEl;
        this._splashEl = null;
        if (!el || !el.parentNode) return;
        this.splashStatus('');
        el.classList.add('splash-hide');
        setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 400);
    }
});