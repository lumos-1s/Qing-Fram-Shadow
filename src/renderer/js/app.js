// 清框影 App 控制器 —— 依据 Java 版 MainController 交互逻辑重写
// 核心:onSettingChanged(高频防抖)/onSettingCommit(提交压栈)/scheduleRender(防抖渲染)/refreshUI(回显)
// 撤销/重做栈 + 每图独立模板(imageTemplates) + 画布元素(logo/贴纸/文字)管理
window.App = {
    image: null,          // 当前图片 {el, name, w, h, exif, customSettings}
    images: [],
    selectedIdx: [],
    batchSel: [],         // 胶片条勾选的照片索引(批量放图数据源)
    currentIdx: 0,
    template: null,       // 当前模板 JSON
    imageTemplates: new Map(), // 每图独立模板(深拷贝快照)
    presets: [],
    zoom: 1,
    panX: 0, panY: 0,
    _pan: null,
    renderToken: 0,        // 帧计数(诊断用:观察实际合成次数)
    _renderRaf: 0,        // 已排队的帧回调句柄(0=未排)
    _renderDirty: false,  // 队列里有待处理的渲染请求
    _renderUrgent: false, // 本轮需跳过的手势降频(滑块拖动中降频,提交/导出时清零)
    _renderSkip: 0,       // 剩余跳帧数:>0 表示本帧只让位、不合成
    _renderFlushResolvers: [], // flushRender 等待者(该帧真正画完后统一兑现)
    _comparePending: false,  // 本帧是否为「对比原图」旁路帧(见 setCompare)
    undoStack: [],
    redoStack: [],
    _gesture: false,
    isUpdating: false,
    draggingCompare: false,
    logos: [],
    logoImgCache: {},
    textures: [],
    curatedFonts: ['Microsoft YaHei', 'SimSun', 'SimHei', 'KaiTi', 'FangSong', 'Arial', 'Arial Black', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Segoe UI', 'PingFang SC',
        // 中文艺术字/印章体
        '华文彩云', '华文琥珀', '华文行楷', '华文新魏', '幼圆', '隶书', '方正舒体', '方正姚体', '方正报宋', '汉仪雪峰体', '汉仪旗黑',
        // 西文艺术字
        'Segoe Script', 'Brush Script MT', 'Comic Sans MS', 'Impact', 'Papyrus', 'Ravie', 'Gigi', 'Chiller', 'Edwardian Script ITC', 'Monotype Corsiva', 'Snap ITC', 'Lucida Handwriting', 'Trebuchet MS', 'Copperplate Gothic Bold', 'Book Antiqua', 'Informal Roman', 'Bodoni MT'],
    _lastTplName: '',
    _firstRenderDone: false,
    selectedEls: [],      // 画布元素选中集(引用自模板数组)
    _elClip: null,        // 复制的元素快照 {kind, el}
    _puzzleSlot: '',         // 拼图当前选中项('s0'..槽位 / 'v0'/'h0'..间隙);空 = 未选中
    _editingGap: null,       // 正在编辑的字幕门牌号('H0'/'V1'/'S2'),无则收起编辑器
    _activePuzzleSlot: null, // 画布选中槽位(蓝框 + 滚轮/拖拽/单图滑块);null = 控制整个拼图
    _puzzlePick: null,       // 拖拽抓取预览 {mode:'target'|'float',...}
    _puzzleDropTarget: null, // 拖拽互换预备目标格
    _skipPuzzleCapture: false,

    restoreLastState() {
        try {
            const raw = localStorage.getItem('qfs_last_state');
            if (!raw) return;
            const s = JSON.parse(raw);
            // 找到对应预设并选中
            if (s.presetName && this.presets) {
                const p = this.presets.find(x => x.name === s.presetName);
                if (p) { this.selectPreset(p); return; }
            }
            // 没找到预设就只恢复关键字段
            if (s.photoFrameStyle && this.template) {
                this.template.photoFrameStyle = s.photoFrameStyle;
                if (s.userSignature) this.template.userSignature = s.userSignature;
                if (s.signFont) this.template.signFont = s.signFont;
                if (s.signColor) this.template.signColor = s.signColor;
                if (s.signIncludeModel != null) this.template.signIncludeModel = s.signIncludeModel;
                if (s.avatarScale) this.template.avatarScale = s.avatarScale;
                if (s.signSize) this.template.signSize = s.signSize;
                if (s.avatarShow !== undefined) this.template.avatarShow = s.avatarShow;
                if (s.signBgBlur != null) this.template.signBgBlur = s.signBgBlur;
                if (s.paramColor) this.template.paramColor = s.paramColor;
                if (s.paramFontSize) this.template.paramFontSize = s.paramFontSize;
                if (s.brandSize) this.template.brandSize = s.brandSize;
                if (s.brandLogo != null) this.template.brandLogo = s.brandLogo;
                if (s.paramScale) this.template.paramScale = s.paramScale;
                this.refreshUI();
                this.scheduleRender();
            }
        } catch (_) {}
    },

    init() {
        this.initSplash();
        this.cacheDom();
        this.bind();
        this.loadPrefs();
        this.loadPresets();
        this.restoreLastState();
        this.loadLogos();
        this.loadTextures();
        this.populateFonts();
        this.setupShortcuts();
        this.setupPanelInteractions();
        // 工具栏按钮tooltip
        const tips = {
            btnUndo: '撤销 (Ctrl+Z)', btnRedo: '重做 (Ctrl+Y)',
            btnReset: '重置', btnRandom: '随机预设',
            btnFit: '适应窗口', btnOpen: '导入照片',
        };
        Object.entries(tips).forEach(([id, tip]) => {
            const el = document.getElementById(id);
            if (el) el.title = tip;
        });
        document.querySelectorAll('.pg-title.collapsible').forEach(t => {
            if (t._bound) return;
            t._bound = true;
            t.addEventListener('click', () => {
                const g = t.parentElement;
                if (g) g.classList.toggle('collapsed');
            });
        });
        const tplSearch = document.getElementById('tfTemplateSearch');
        if (tplSearch) tplSearch.addEventListener('input', () => this._applyTplFilter());
        this.updateHistoryButtons();
        this.initLogin();
        this.initDraft();
        // 首帧预设:启动页撤掉、恢复草稿跑完后,在空闲回调里选中第一个预设。
        // 用模板引用判断「没人碰过」:restoreLastState 恢复草稿 / 用户手动点预设都会
        // 替换 this.template,此时引用不再等于启动时的引用,选择被安全跳过。
        const bootTpl = this.template;
        const pickFirst = () => {
            if (this.presets && this.presets.length && this.template === bootTpl) this.selectPreset(this.presets[0]);
            this.updateEmptyState();
        };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(pickFirst, { timeout: 1500 });
        else setTimeout(pickFirst, 1000);
        // 新手引导:比首帧预设选择更晚触发,界面就绪后弹出,不抢首帧
        const showIntro = () => this.showIntroIfNeeded();
        if (typeof requestIdleCallback === 'function') requestIdleCallback(showIntro, { timeout: 4000 });
        else setTimeout(showIntro, 3000);
    },

    // 恢复上次的界面偏好(导出质量 / 拍摄信息开关)
    async loadPrefs() {
        try {
            const p = await window.qingframe.getPrefs();
            if (p && p.exportQuality && this.dom.slExportQuality) {
                this.dom.slExportQuality.value = p.exportQuality;
            }
            if (p && typeof p.keepExif === 'boolean' && this.dom.chkKeepExif) this.dom.chkKeepExif.checked = p.keepExif;
            if (p && typeof p.keepGps === 'boolean' && this.dom.chkKeepGps) this.dom.chkKeepGps.checked = p.keepGps;
            if (this.dom.chkKeepGps) this.dom.chkKeepGps.disabled = !(this.dom.chkKeepExif && this.dom.chkKeepExif.checked);
        } catch (_) {}
    },

    // 导出偏好三项一起存:save-prefs 在主进程是**整对象替换**(saveState({prefs})),
    // 分开发的每一次都会把另外两项抹掉 —— 存的时候必须全量提交
    _saveExportPrefs() {
        const d = this.dom || {};
        if (!window.qingframe || !window.qingframe.savePrefs) return;
        // 异步调用,静默忽略失败(旧主进程无该 handler 时不报未处理错误)
        window.qingframe.savePrefs({
            exportQuality: d.slExportQuality ? d.slExportQuality.value : undefined,
            keepExif: !!(d.chkKeepExif && d.chkKeepExif.checked),
            keepGps: !!(d.chkKeepGps && d.chkKeepGps.checked)
        }).catch(() => {});
    },

    cacheDom() {
        const $ = id => document.getElementById(id);
        this.dom = {
            btnOpen: $('btnOpen'), btnSave: $('btnSave'), selFormat: $('selFormat'), selExportSize: $('selExportSize'),
            slExportQuality: $('slExportQuality'), exportSizeNote: $('exportSizeNote'),
            chkKeepExif: $('chkKeepExif'), chkKeepGps: $('chkKeepGps'),
            btnExportSettings: $('btnExportSettings'), exportPop: $('exportPop'),
            btnSyncSel: $('btnSyncSel'), btnUndo: $('btnUndo'), btnRedo: $('btnRedo'),
            btnReset: $('btnReset'), btnRandom: $('btnRandom'), btnFit: $('btnFit'),
            zoomInput: $('zoomInput'), zoomRange: $('zoomRange'), btnTheme: $('btnTheme'),
            presetTree: $('presetTree'), presetSearch: $('presetSearch'),
            canvas: $('previewCanvas'), canvasPane: $('canvasPane'), placeholder: $('placeholder'), inspector: $('inspector'),
            stage: document.querySelector('.stage'),
            thumbStrip: $('thumbStrip'), dropOverlay: $('dropOverlay'),
            importProgress: $('importProgress'), importProgressFill: $('importProgressFill'), importProgressText: $('importProgressText'),
            tabs: $('inspTabs'), panels: Array.from(document.querySelectorAll('.tab-panel')),
            stRes: $('stRes'), stInfo: $('stInfo'), stCanvas: $('stCanvas'),
            btnCompare: $('btnCompare'),
            loginStatus: $('loginStatus'),
            loginModal: $('loginModal'),
            loginModalClose: $('loginModalClose'),
            loginUsername: $('loginUsername'),
            loginNickname: $('loginNickname'),
            loginSubmit: $('loginSubmit'),
            loginLogout: $('loginLogout'),
            loginFormView: $('loginFormView'),
            loginProfileView: $('loginProfileView'),
            loginAvatar: $('loginAvatar'),
            loginDisplayName: $('loginDisplayName'),
            loginUsernameDisplay: $('loginUsernameDisplay'),
        };
    },

    $(id) { return document.getElementById(id); },

    bind() {
        const d = this.dom;
        d.btnOpen.addEventListener('click', () => this.openImages());
        d.btnSave.addEventListener('click', () => this.doExport());
        if (d.btnExportSettings && d.exportPop) {
            d.btnExportSettings.addEventListener('click', (e) => {
                e.stopPropagation();
                const open = d.exportPop.style.display !== 'block';
                d.exportPop.style.display = open ? 'block' : 'none';
                // 提示只在弹窗可见时才有意义。挂在这里而不是每处照片/样式载入点,
                // 是因为导入、切图、恢复草稿、导入模板的赋值点分散在 6+ 处,逐个挂必漏;
                // 而弹窗打开这一个时机就能保证「看到提示时它一定是对的」。
                if (open) this.updateExportSizeNote();
            });
            document.addEventListener('click', (ev) => {
                // 用 contains 而不是 !==:箭头按钮里现在有 SVG,点的 target 是 <path> 不是按钮本身
                if (d.exportPop.style.display === 'block' && !d.btnExportSettings.contains(ev.target) && !d.exportPop.contains(ev.target)) {
                    d.exportPop.style.display = 'none';
                }
            });
        }
        if (d.slExportQuality) d.slExportQuality.addEventListener('change', () => this._saveExportPrefs());
        if (d.chkKeepExif) {
            d.chkKeepExif.addEventListener('change', () => {
                // 总开关关掉时 GPS 选项失去意义,置灰但保留状态(重新打开总开关时恢复)
                if (d.chkKeepGps) d.chkKeepGps.disabled = !d.chkKeepExif.checked;
                this._saveExportPrefs();
            });
        }
        if (d.chkKeepGps) d.chkKeepGps.addEventListener('change', () => this._saveExportPrefs());
        // 尺寸提示依赖「所选档位 × 当前照片 × 当前相框样式」,三者任一变化都要重算
        if (d.selExportSize) d.selExportSize.addEventListener('change', () => this.updateExportSizeNote());
        d.btnSyncSel.addEventListener('click', () => this.syncToSelected());
        d.btnUndo.addEventListener('click', () => this.undo());
        d.btnRedo.addEventListener('click', () => this.redo());
        d.btnReset.addEventListener('click', () => this.resetParams());
        d.btnRandom.addEventListener('click', () => this.randomBorder());
        d.btnFit.addEventListener('click', () => this.fitZoom());
        // 窗口尺寸变化:视图停在「适应」时自动重算缩放。
        // 否则窄窗会把画布裁掉(画布区 overflow:hidden,没有滚动条),宽窗又只占中间一小块。
        // 手动缩放/平移会退出跟随(setZoom / 画布平移处置 false),不打扰用户已经调好的视角。
        if (typeof ResizeObserver === 'function' && d.stage) {
            const ro = new ResizeObserver(() => {
                clearTimeout(this._fitResizeT);
                this._fitResizeT = setTimeout(() => {
                    if (!this._followFit || !this.image || this.uiDprOverride === 1) return;
                    this.fitZoom();
                }, 140);
            });
            ro.observe(d.stage);
            this._fitResizeRO = ro;
        }
        d.btnTheme.addEventListener('click', () => this.toggleTheme());
        d.zoomRange.addEventListener('input', e => this.setZoom(parseInt(e.target.value, 10) / 100));
        d.zoomInput.addEventListener('change', e => {
            const v = parseFloat(String(e.target.value).replace('%', ''));
            if (!isNaN(v)) this.setZoom(Math.min(3, Math.max(0.1, v / 100)));
        });
        d.presetSearch.addEventListener('input', () => this.filterTree(d.presetSearch.value.trim()));
        d.tabs.addEventListener('click', e => {
            const btn = e.target.closest('.tab');
            if (btn) this.switchTab(btn.dataset.tab);
        });
        // 对比原图:Pointer 统一鼠标/触屏;另支持 空格 按住短按。
        // (不用 Alt:窗口是 autoHideMenuBar,Windows 上 Alt 会唤出菜单栏并抢走按键)
        d.btnCompare.addEventListener('pointerdown', e => { e.preventDefault(); this.setCompare(true); });
        d.btnCompare.addEventListener('pointerup', () => this.setCompare(false));
        d.btnCompare.addEventListener('pointercancel', () => this.setCompare(false));
        d.btnCompare.addEventListener('pointerleave', () => this.setCompare(false));
        document.addEventListener('keydown', e => {
            if (e.code !== 'Space' || e.ctrlKey || e.altKey || e.metaKey) return;
            const el = document.activeElement;
            const tag = (el && el.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return;
            e.preventDefault();
            this.setCompare(true);
        });
        document.addEventListener('keyup', e => { if (e.code === 'Space') this.setCompare(false); });
        window.addEventListener('blur', () => { if (this.draggingCompare) this.setCompare(false); });
        const btnCancel = document.getElementById('btnExportCancel');
        if (btnCancel) btnCancel.addEventListener('click', () => { this._exportAbort = true; });
        this.updateTopBar();
            d.loginStatus.addEventListener('click', () => this.openLoginModal());
        d.loginModalClose.addEventListener('click', () => this.closeLoginModal());
        d.loginModal.addEventListener('mousedown', e => { if (e.target === d.loginModal) this.closeLoginModal(); });
        d.loginSubmit.addEventListener('click', () => this.doLogin());
        d.loginLogout.addEventListener('click', () => this.doLogout());
        d.loginUsername.addEventListener('keydown', e => { if (e.key === 'Enter') this.doLogin(); });
        d.loginNickname.addEventListener('keydown', e => { if (e.key === 'Enter') this.doLogin(); });
        this.loadUserAvatar();
        this.setupDragDrop();
        // 签名输入
        const inpSig = document.getElementById('inpSignature');
        if (inpSig) inpSig.addEventListener('input', () => { this.template.userSignature = inpSig.value; this.onSettingChanged(); });
        const cbF = document.getElementById('cbSignFont');
        if (cbF) cbF.addEventListener('change', () => { this.template.signFont = cbF.value; this.onSettingChanged(); });
        const cbC = document.getElementById('cbSignColor');
        if (cbC) cbC.addEventListener('change', () => { this.template.signColor = cbC.value; this.onSettingChanged(); });
        const chkSM = document.getElementById('chkSignModel');
        if (chkSM) chkSM.addEventListener('change', () => { this.template.signIncludeModel = chkSM.checked ? 1 : 0; this.onSettingChanged(); });
        const chkBL = document.getElementById('chkBrandLogo');
        if (chkBL) chkBL.addEventListener('change', () => { this.template.brandLogo = Number(chkBL.value) || 0; this.onSettingChanged(); });
        const chkAS = document.getElementById('chkAvatarShow');
        if (chkAS) chkAS.addEventListener('change', () => {
            this.template.avatarShow = chkAS.checked ? 1 : 0;
            this.onSettingChanged();
        });
        const rgAS = document.getElementById('rgAvatarScale');
        if (rgAS) rgAS.addEventListener('input', () => {
            this.template.avatarScale = Number(rgAS.value) / 100;
            const v = document.getElementById('valAvatarScale');
            if (v) v.textContent = rgAS.value + '%';
            this.onSettingChanged();
        });
        const rgSS = document.getElementById('rgSignSize');
        if (rgSS) rgSS.addEventListener('input', () => {
            this.template.signSize = Number(rgSS.value) / 100;
            const v = document.getElementById('valSignSize');
            if (v) v.textContent = rgSS.value + '%';
            this.onSettingChanged();
        });
        const chkBB = document.getElementById('chkBgBlur');
        if (chkBB) chkBB.addEventListener('change', () => {
            this.template.signBgBlur = chkBB.checked ? 1 : 0;
            const rowBI = document.getElementById('rowBgBlurInt');
            if (rowBI) rowBI.style.display = chkBB.checked ? '' : 'none';
            this.syncEmptyGroups();
            this.onSettingChanged();
        });
        const slBI = document.getElementById('slBgBlurInt');
        if (slBI) {
            this.updateLabel('lblBgBlurInt', slBI.value + '%');
            slBI.addEventListener('input', () => {
                this.template.blurIntensity = Number(slBI.value);
                this.updateLabel('lblBgBlurInt', slBI.value + '%');
                this.onSettingChanged();
            });
        }
        const cbPC = document.getElementById('cbParamColor');
        if (cbPC) cbPC.addEventListener('change', () => {
            this.template.paramColor = cbPC.value;
            this.onSettingChanged();
        });
        // 角饰:关着时下面两项禁用;打开时若类型是「无」自动切到「直角」,否则勾了也不出效果。
        // 这个监听要早于 bindInteractive 里的通用 change,先把 select 值改对再走提交。
        const cbDecor = document.getElementById('cbCornerDecor');
        if (cbDecor) {
            cbDecor.addEventListener('change', () => {
                const sel = document.getElementById('cbCornerDecorType');
                if (cbDecor.checked && sel && sel.value === 'none') sel.value = 'line';
                this.syncCornerDecorState();
            });
        }
        // 头像上传(存全局)
        const btnAv = document.getElementById('btnUploadAvatar'), fileAv = document.getElementById('fileAvatar');
        if (btnAv && fileAv) {
            btnAv.addEventListener('click', () => fileAv.click());
            fileAv.addEventListener('change', (e) => {
                const f = e.target.files[0]; if (!f) return;
                const reader = new FileReader();
                reader.onload = (ev) => this.saveUserAvatar(ev.target.result);
                reader.readAsDataURL(f);
            });
        }
        this.bindAvatarUpload();
        this.bindInteractive();
    },

    updateTopBar() {
        // 名字以本地用户资料为准;旧版 qfs_username/qfs_nickname 只作兜底。
        // 以前只读 localStorage:设置头像后 updateTopBar 会把顶栏名字刷回「未登录」。
        const u = this.user;
        const name = (u && (u.nickname || u.username)) || localStorage.getItem('qfs_username') || localStorage.getItem('qfs_nickname') || '';
        const topName = document.getElementById('topUserName');
        const topAv = document.getElementById('topAvatar');
        if (topName) topName.textContent = name || '设置用户';
        if (topAv) {
            const av = localStorage.getItem('qfs_user_avatar');
            if (av) { topAv.style.background = 'url(' + av + ') center/cover'; topAv.textContent = ''; }
            else {
                topAv.style.background = '#444';
                // 没头像:有名字用首字,没有就「＋」,和旁边的「设置用户」呼应
                topAv.style.display = 'flex';
                topAv.style.alignItems = 'center';
                topAv.style.justifyContent = 'center';
                topAv.style.fontSize = '12px';
                topAv.style.color = '#cfd6e4';
                topAv.textContent = name ? name.charAt(0) : '＋';
            }
        }
    },
    loadUserAvatar() {
        this.updateTopBar();
        // 「签名/头像行」默认关的风格(票根/电影票):预设里的空签名就是「本预设不带签名」,
        // 启动时别拿「— 昵称 —」把它变成非空、把整行又带出来。用户想带的话,
        // 面板里填一次签名即可(那是用户自己的值,优先级不变)。
        const sigOff = !!(window.StyleCaps && window.StyleCaps.sigRowDefaultOff && window.StyleCaps.sigRowDefaultOff(this.template && this.template.photoFrameStyle));
        if (this.template && !this.template.userSignature && !sigOff) {
            const un = (this.user && this.user.nickname) || localStorage.getItem('qfs_nickname') || localStorage.getItem('qfs_username') || '';
            if (un) this.template.userSignature = '— ' + un + ' —';
        }
        const saved = localStorage.getItem('qfs_user_avatar');
        if (saved) {
            const img = new Image();
            img.onload = () => { window.__qfsAvatarImg = img; this.onSettingChanged(); };
            img.src = saved;
        }
    },
    openAvatarCrop(dataUrl) {
        const modal = document.getElementById('avatarCropModal');
        const img = document.getElementById('cropImg');
        if (!modal || !img) { this.saveUserAvatar(dataUrl); return; }
        modal.style.display = 'flex'; modal.style.alignItems = 'center'; modal.style.justifyContent = 'center';
        img.src = dataUrl;
        this._cropScale = 1;
        this._cropX = 0;
        this._cropY = 0;
        const apply = () => {
            const wrap = img.parentElement;
            const w = wrap.clientWidth;
            // 图片按cover填,初始scale按宽度
            const iw = img.naturalWidth || 300;
            const ih = img.naturalHeight || 300;
            const s = Math.max(w / iw, w / ih);
            this._cropScale = s;
            this._cropX = 0; this._cropY = 0;
            img.style.width = iw * s + 'px';
            img.style.height = ih * s + 'px';
            img.style.left = (w - iw * s) / 2 + 'px';
            img.style.top = (w - ih * s) / 2 + 'px';
        };
        img.onload = apply;
        if (img.complete && img.naturalWidth) apply();
        // 拖动
        let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
        img.onmousedown = (e) => { dragging = true; sx = e.clientX; sy = e.clientY; ox = this._cropX; oy = this._cropY; e.preventDefault(); };
        window.onmousemove = (e) => { if (!dragging) return; this._cropX = ox + e.clientX - sx; this._cropY = oy + e.clientY - sy; img.style.left = this._cropX + 'px'; img.style.top = this._cropY + 'px'; };
        window.onmouseup = () => { dragging = false; };
        // 滚轮缩放
        img.onwheel = (e) => {
            e.preventDefault();
            const old = this._cropScale;
            this._cropScale *= (e.deltaY < 0 ? 1.1 : 0.9);
            this._cropScale = Math.max(old * 0.3, Math.min(this._cropScale, old * 5));
            const iw = img.naturalWidth, ih = img.naturalHeight;
            img.style.width = iw * this._cropScale + 'px';
            img.style.height = ih * this._cropScale + 'px';
        };
        // 确认
        document.getElementById('cropOk').onclick = () => {
            const wrap = img.parentElement;
            const c = document.createElement('canvas');
            c.width = 200; c.height = 200;
            const ctx = c.getContext('2d');
            // 从img位置映射到canvas
            const scale = this._cropScale;
            const imgX = -parseFloat(img.style.left) / scale;
            const imgY = -parseFloat(img.style.top) / scale;
            const cropSize = wrap.clientWidth / scale;
            ctx.drawImage(img, imgX, imgY, cropSize, cropSize, 0, 0, 200, 200);
            const out = c.toDataURL('image/jpeg', 0.85);
            modal.style.display = 'none';
            this.saveUserAvatar(out);
        };
        document.getElementById('cropCancel').onclick = () => { modal.style.display = 'none'; };
    },
    saveUserAvatar(dataUrl) {
        // 先压缩到200x200再存,避免localStorage配额超限
        const img = new Image();
        img.onload = () => {
            const c = document.createElement('canvas');
            const size = 200;
            c.width = size; c.height = size;
            const ctx = c.getContext('2d');
            // cover裁剪
            const s = Math.max(size / img.width, size / img.height);
            const dw = img.width * s, dh = img.height * s;
            ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
            const compressed = c.toDataURL('image/jpeg', 0.85);
            try {
                localStorage.setItem('qfs_user_avatar', compressed);
            } catch(e) { console.warn('头像存储失败:', e); }
            window.__qfsAvatarImg = img;
            this.onSettingChanged();
            const pv = document.getElementById('loginAvatarPreview');
            if (pv) { pv.style.background = 'url(' + compressed + ') center/cover'; pv.textContent = ''; }
            const la = document.getElementById('loginAvatar');
            if (la) { la.style.background = 'url(' + compressed + ') center/cover'; }
            this.updateTopBar();
        };
        img.src = dataUrl;
    },
    bindAvatarUpload() {
        const pick = document.getElementById('btnPickAvatar'), file1 = document.getElementById('fileLoginAvatar');
        const change = document.getElementById('btnChangeAvatar'), file2 = document.getElementById('fileChangeAvatar');
        const readFile = (f) => {
            if (!f) return;
            const reader = new FileReader();
            reader.onload = (ev) => this.openAvatarCrop(ev.target.result);
            reader.readAsDataURL(f);
        };
        if (pick && file1) { pick.addEventListener('click', () => file1.click()); file1.addEventListener('change', (e) => readFile(e.target.files[0])); }
        if (change && file2) { change.addEventListener('click', () => file2.click()); file2.addEventListener('change', (e) => readFile(e.target.files[0])); }
    },

    /* ══ 画布元素 / 缩放平移交互 ══ */
    bindInteractive() {
        const pane = this.dom.canvasPane, stage = this.dom.stage, canvas = this.dom.canvas;
        const hscrollWheel = (el) => {
            if (!el) return;
            el.addEventListener('wheel', e => {
                if (el.scrollWidth <= el.clientWidth) return;
                e.preventDefault();
                e.stopPropagation();
                el.scrollLeft += (e.deltaY || e.deltaX);
            }, { passive: false });
        };
        hscrollWheel(this.dom.thumbStrip);
        // 胶片条空闲淡出:它悬浮在画布底部正中,常显正好压住相框下边(参数文字/品牌行)。
        // 指针在条上时保持不透明,离开 2.2s 后淡到 45%(仍可点,只是让出画面)。
        const strip = this.dom.thumbStrip;
        if (strip) {
            const wake = () => { clearTimeout(this._stripIdleT); strip.classList.remove('strip-idle'); };
            const sleep = () => {
                clearTimeout(this._stripIdleT);
                this._stripIdleT = setTimeout(() => strip.classList.add('strip-idle'), 2200);
            };
            strip.addEventListener('pointerenter', wake);
            strip.addEventListener('pointerdown', wake);
            strip.addEventListener('pointerleave', sleep);
            sleep();
        }
        // 三个图标池(内置标记/品牌Logo/自定义图标)已改为网格+垂直滚动,
        // 滚轮原生垂直滑动;不能再劫持成水平滚动,否则会阻止原生滚动。
        // hscrollWheel(this.$('brandIconBox'));
        // hscrollWheel(this.$('customIconBox'));
        pane.addEventListener('wheel', e => {
            const pk = this.tplPuzzle();
            if (pk) {
                // 拼图模式:只有画布上"选中"了格子,滚轮才缩放该格图片(不再看鼠标悬停在哪一格)。
                // 未选中(刚进入拼图 / 点过图片以外)时滚轮缩放整个拼图视图,不依赖主图 this.image
                if (this._activePuzzleSlot != null) { e.preventDefault(); this.puzzleWheelSlot(this._activePuzzleSlot, e.deltaY < 0 ? 1.1 : 1 / 1.1); return; }
                if (this.image && stage.classList.contains('has-img')) { e.preventDefault(); this.zoomAt(e, stage, e.deltaY < 0 ? 1.1 : 1 / 1.1); }
                return;
            }
            if (!this.image || !stage.classList.contains('has-img')) return;
            e.preventDefault();
            const sel = this.selectedEls[0];
            if (sel && sel.kind) {
                // 元素操作:Ctrl+滚轮 旋转,普通滚轮 缩放
                const rot = e.ctrlKey || e.shiftKey;
                this.nudgeElement(sel, rot ? 'rot' : 'scale', e.deltaY < 0 ? 1 : -1);
                return;
            }
            this.zoomAt(e, stage, e.deltaY < 0 ? 1.1 : 1 / 1.1);
        }, { passive: false });
        canvas.addEventListener('mousedown', e => {
            const pk = this.tplPuzzle();
            if ((!this.image && !pk) || e.button !== 0) return;
            if (pk) {
                const hp = this.puzzleHitTest(e);
                if (hp) {
                    e.preventDefault();
                    this.selectedEls = [];
                    this.refreshElList();
                    // 拖拽分隔线调轴位;分隔线属于"图片以外",先把格子选中清掉(静默,避免调间距时刷提示)
                    if (hp.type === 'axis') {
                        this.clearActivePuzzleSlot(true);
                        // 记录按下点相对分隔线的偏移,拖动时线不会跳到指针中心
                        const pp = this.puzzlePx(e);
                        const raw = hp.dim === 'v' ? pp.x / canvas.width : pp.y / canvas.height;
                        this._dragPz = { type: 'axis', dim: hp.dim, idx: hp.idx, sx: e.screenX, sy: e.screenY, moved: false, grabOff: raw - hp.pos };
                        this._setPuzzleAxisHover(hp);
                        canvas.style.cursor = (hp.dim === 'v') ? 'col-resize' : 'row-resize';
                        return;
                    }
                    // 只有"已选中"的格图才能被移动:第一次点击仅选中(并清掉旧拖动态),
                    // 已经选中时按下才进入该格图片的移动
                    if (this._activePuzzleSlot !== hp.slot) {
                        this.setActivePuzzleSlot(hp.slot);
                        this._puzzlePick = null;
                        return;
                    }
                    this._dragPz = { type: 'slot', slot: hp.slot, sx: e.screenX, sy: e.screenY, x0: hp.x, y0: hp.y, moved: false, swap: null };
                    this.setActivePuzzleSlot(hp.slot);
                    this._dragPzInitOff = {};
                    this.ensurePuzzleSlotsCount(pk);
                    for (let si = 0; si < this.puzzleSlotCount(pk.layout || 'single'); si++) {
                        this._dragPzInitOff[si] = { x: pk.slots[si].offsetX || 0, y: pk.slots[si].offsetY || 0 };
                    }
                    this._puzzlePick = null;
                    canvas.style.cursor = 'move';
                    return;
                }
                // 背景板/格间空隙 = 图片以外:取消格子选中(蓝框消失),之后的滚轮/拖拽控制整个拼图
                this.clearActivePuzzleSlot();
            }
            const pt = this.screenToCanvas(e);
            const el = this.pickElement(pt);
            if (el) {
                e.preventDefault();
                this.selectedEls = this.hasEl(this.selectedEls, el) ? this.selectedEls : [el];
                this._dragEl = { kind: el.kind, ref: el.obj, sx: e.screenX, sy: e.screenY, x: el.x0, y: el.y0, moved: false };
                // 整帧渲染时排除被拖元素,使其余内容可作为静态背景缓存(见 renderPreview)
                this._skipUserEl = el.obj;
                this._dropDragBase();
                this._logoSnapV = null; this._logoSnapH = null;
                this._logoSnapEdgeV = null; this._logoSnapEdgeH = null;
                this.refreshElList();
                canvas.style.cursor = 'pointer';
                this.requestRender();
                return;
            }
            this.selectedEls = [];
            this.refreshElList();
            // 手动平移也退出跟随:否则窗口一变,视图会跳回居中、丢掉用户拖出来的视角
            this._followFit = false;
            this._pan = { sx: e.screenX, sy: e.screenY, px: this.panX, py: this.panY };
            canvas.style.cursor = 'grabbing';
        });
        // 悬停分隔线:换成 row/col-resize 光标 + 画布高亮线,让"可拖动"看得见
        canvas.addEventListener('mousemove', e => {
            if (this._dragPz || this._dragEl || this._pan) return;
            const pk = this.tplPuzzle();
            if (!pk) return;
            const p = this.puzzlePx(e);
            const ax = this.puzzleAxisAtPx(p.x, p.y);
            if (ax) {
                this._setPuzzleAxisHover(ax);
                const cur = ax.dim === 'v' ? 'col-resize' : 'row-resize';
                if (canvas.style.cursor !== cur) canvas.style.cursor = cur;
            } else {
                if (canvas.style.cursor === 'col-resize' || canvas.style.cursor === 'row-resize') canvas.style.cursor = '';
                this._setPuzzleAxisHover(null);
            }
        });
        canvas.addEventListener('mouseleave', () => {
            if (this._dragPz) return;
            if (canvas.style.cursor === 'col-resize' || canvas.style.cursor === 'row-resize') canvas.style.cursor = '';
            this._setPuzzleAxisHover(null);
        });
        // 拼图选中是"图片以外一律取消":点舞台灰底/工具栏/左侧预设/胶片条/其他面板都清掉蓝框。
        // 例外:画布本身(由上面的格子命中逻辑决定)和拼图面板(选择下拉/单图滑块/字幕编辑器要用当前选中)。
        document.addEventListener('mousedown', e => {
            if (this._activePuzzleSlot == null || e.button !== 0) return;
            const t = e.target;
            if (t && t.closest && t.closest('#previewCanvas, #panel-puzzle')) return;
            this.clearActivePuzzleSlot();
        }, true);
        window.addEventListener('mousemove', e => {
            if (this._dragPz) {
                const pk = this.tplPuzzle();
                if (pk) {
                    const dx = e.screenX - this._dragPz.sx, dy = e.screenY - this._dragPz.sy;
                    if (!this._dragPz.moved && this._dragPz.type === 'slot' && Math.abs(dx) + Math.abs(dy) > 4) { this._dragPz.moved = true; this.pushUndo(); }
                    if (this._dragPz.type === 'axis' && Math.abs(dx) + Math.abs(dy) > 1 && !this._dragPz.moved) { this._dragPz.moved = true; this.pushUndo(); }
                    this.puzzleDragMove(pk, this._dragPz, e);
                    this.scheduleRender();
                }
                return;
            }
            if (this._dragEl) {
                const dx = e.screenX - this._dragEl.sx, dy = e.screenY - this._dragEl.sy;
                if (Math.abs(dx) + Math.abs(dy) > 2) {
                    if (!this._dragEl.moved) { this._dragEl.moved = true; this.pushUndo(); }
                    const rect = canvas.getBoundingClientRect();
                    const kx = canvas.width / rect.width, ky = canvas.height / rect.height;
                    this.moveElement(this._dragEl, this._dragEl.x + dx * kx, this._dragEl.y + dy * ky);
                }
                return;
            }
            if (!this._pan) return;
            this.panX = this._pan.px + (e.screenX - this._pan.sx);
            this.panY = this._pan.py + (e.screenY - this._pan.sy);
            this.applyZoomStyle();
        });
        window.addEventListener('mouseup', () => {
            if (this._dragPz) {
                const d = this._dragPz;
                const pk = this.tplPuzzle();
                const moved = d.moved;
                // "放下即互换":松开时指针仍在目标格 → 执行互换
                if (pk && d.type === 'slot' && d.swap != null && d.swap !== d.slot) {
                    if (!moved) this.pushUndo();
                    this.swapSlotImages(pk, d.slot, d.swap);
                    if (this._dragPzInitOff) {
                        [d.slot, d.swap].forEach(i => {
                            if (this._dragPzInitOff[i]) {
                                const so = pk.slots[i] || (pk.slots[i] = {});
                                so.offsetX = this._dragPzInitOff[i].x;
                                so.offsetY = this._dragPzInitOff[i].y;
                            }
                        });
                    }
                    if (!moved) this.saveCurrentTemplate();
                }
                this._puzzlePick = null;
                this._dragPzInitOff = null;
                this._dragPz = null;
                if (moved) {
                    const pkNow = this.tplPuzzle();
                    // 记录拖动最终偏移(commit 会从滑块回写旧值,可能清成 0)
                    let saveOff = null, saveIdx = -1;
                    if (pkNow && d.type === 'slot' && typeof this._puzzleSlot === 'string' && this._puzzleSlot.charAt(0) === 's') {
                        const ai = parseInt(this._puzzleSlot.substring(1), 10);
                        if (!isNaN(ai) && pkNow.slots[ai]) { saveIdx = ai; saveOff = { x: pkNow.slots[ai].offsetX, y: pkNow.slots[ai].offsetY }; }
                    }
                    this.commitNoPush();
                    // 恢复拖动结果,避免模型被旧滑块值覆盖;随后滑块/UI 以模型为准刷新
                    if (saveOff) {
                        pkNow.slots[saveIdx].offsetX = saveOff.x;
                        pkNow.slots[saveIdx].offsetY = saveOff.y;
                        this.setSlotOffsetSliders(pkNow.slots[saveIdx]);
                    }
                    this.refreshPuzzleUI();
                    this.saveCurrentTemplate();
                }
                canvas.style.cursor = '';
                this._setPuzzleAxisHover(null);
            }
            if (this._dragEl) {
                const moved = this._dragEl.moved;
                this._dragEl = null;
                this._skipUserEl = null;
                this._dropDragBase();
                this._logoSnapV = null; this._logoSnapH = null;
                this._logoSnapEdgeV = null; this._logoSnapEdgeH = null;
                if (moved) this.commitNoPush();
            }
            if (this._pan) { this._pan = null; canvas.style.cursor = ''; }
        });
        // 鼠标移出窗口/窗口失焦时,强制清理所有拖动态(防止卡住)
        const cancelDrags = () => {
            if (canvas.style.cursor === 'col-resize' || canvas.style.cursor === 'row-resize') canvas.style.cursor = '';
            this._setPuzzleAxisHover(null);
            if (this._dragPz) {
                this._puzzlePick = null;
                this._dragPzInitOff = null;
                this._dragPz = null;
                canvas.style.cursor = '';
            }
            if (this._dragEl) { this._dragEl = null; this._skipUserEl = null; this._dropDragBase(); this._logoSnapV = null; this._logoSnapH = null; this._logoSnapEdgeV = null; this._logoSnapEdgeH = null; this._logoSnapPhotoV = null; this._logoSnapPhotoH = null; }
            if (this._pan) { this._pan = null; canvas.style.cursor = ''; }
        };
        window.addEventListener('blur', cancelDrags);
        // 拖拽中断只在「指针真正离开整个 stage」时才发生,不再监听 canvas 的 mouseleave。
        //
        // 旧实现(canvas 的 mouseleave → cancelDrags)是错的:canvas 只是 stage 里被缩放居中的一小块,
        // 鼠标从 canvas 挪到 stage 的空白处就会触发 mouseleave,把正在拖的 _dragEl 清掉。
        // 实测:2000×1600 的画布在 zoom=0.415 下只显示 415×332,贴右缘的 logo 往右拖 3px 就出界,
        // 表现为「按下能选中、一动就弹回原位,完全拖不动」。
        //
        // 为什么挪到 stage 的 mouseleave 才对:用户拖到画布外再拖回来是正常操作(把 logo 拖到边缘),
        // 只有指针彻底离开预览区(乃至离开窗口)才需要防卡住清理。stage 覆盖整个画布可视区域,
        // 它的 mouseleave 才等价于「用户不再在操作画布」。
        // stage 已在 bindInteractive 开头声明(与 canvas 同作用域),此处直接复用
        if (stage) stage.addEventListener('mouseleave', cancelDrags);
        else canvas.addEventListener('mouseleave', cancelDrags);
        canvas.addEventListener('dblclick', e => {
            const pk = this.tplPuzzle();
            if (!pk) return;
            // 双击分隔线:恢复这条线到布局默认比例(分隔线不可选中,不会和双击换图冲突)
            const pp = this.puzzlePx(e);
            const ax = this.puzzleAxisAtPx(pp.x, pp.y);
            if (ax) {
                e.preventDefault();
                this.resetPuzzleAxis(ax.dim, ax.idx);
                return;
            }
            const si = this.puzzleSlotAt(e);
            if (si == null) return;
            e.preventDefault();
            this.setActivePuzzleSlot(si);
            this.openSlotImage(si);
        });
        // 桌面右键菜单:拼图格子 / 画布空白处
        canvas.addEventListener('contextmenu', e => {
            const pk = this.tplPuzzle();
            if (pk) {
                const hp = this.puzzleHitTest(e);
                if (hp && hp.type === 'axis') {
                    e.preventDefault();
                    this.openCtx(e.clientX, e.clientY, [
                        ['恢复这条分隔线', () => this.resetPuzzleAxis(hp.dim, hp.idx)],
                        ['恢复全部默认比例', () => this.resetPuzzleAxes()],
                    ]);
                    return;
                }
                if (hp && hp.type === 'slot') {
                    e.preventDefault();
                    this.setActivePuzzleSlot(hp.slot);
                    this.openCtx(e.clientX, e.clientY, [
                        ['替换照片(打开图片)', () => this.openSlotImage(hp.slot)],
                        ['在此位置插入照片', () => this.insertImageFromPick(hp.slot)],
                        ['旋转 90°', () => this.rotatePuzzleSlot(hp.slot)],
                        ['重置本格', () => this.resetPuzzleSlot(hp.slot)],
                        ['清空该格', () => this.clearSlotImage(hp.slot)],
                    ]);
                    return;
                }
            }
            e.preventDefault();
            this.openCtx(e.clientX, e.clientY, [
                ['适应窗口', () => this.fitZoom && this.fitZoom()],
                ['1:1 实际大小', () => this.zoomActual && this.zoomActual()],
                ['对比原图 (空格按住)', () => this.toggleCompare && this.toggleCompare()],
                ['旋转 90°', () => this.rotateCurrentPhoto()],
                ['—', null],
                ['撤销 (Ctrl+Z)', () => this.undo()],
                ['重做 (Ctrl+Y)', () => this.redo()],
                ['—', null],
                ['导出图片', () => this.doExport && this.doExport()],
            ]);
        });
        document.addEventListener('mousedown', e => {
            if (this._ctx && !this._ctx.contains(e.target)) this.closeCtx();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') this.closeCtx();
        });
        document.addEventListener('click', e => {
            if (e.target === canvas) return;
            if (e.target.closest('#inspector') || e.target.closest('.tabs')) return;
            if (this.selectedEls.length && this._dragElMoved !== true) {
                // 画布外点击取消选中
            }
        });
    },

    /* ══ screenToCanvas(e) { … → app-elements.js ══ */

    /* ══ 默认模板 ══ */
    defaultTemplate() {
        return {
            templateName: '', templateTag: '', photoFrameStyle: '', canvasRatio: 'original',
            baseMargin: {
                marginLock: 1, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
                imgScale: 1, imgOffsetX: 0, imgOffsetY: 0,
                refTop: 0, refBottom: 0, refLeft: 0, refRight: 0, globalMargin: 1,
            },
            exportDpi: 300,
            layerList: [{
                visible: 1, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
                fillConfig: {
                    fillType: 'transparent', fillHex: 'eeeeee', fillOpacity: 100,
                    gradientType: 'linear', gradientAngle: 45,
                    gradientStops: [{ position: 0, color: 'eeeeee' }, { position: 1, color: 'bbbbbb' }],
                    gradientOpacity: 100,
                    textureSrc: '', textureScale: 1, textureOffsetX: 0, textureOffsetY: 0,
                    textureOpacity: 100, textureBlend: 'normal',
                },
                strokeConfig: {
                    strokeWidth: 0, strokePos: 'inside', strokeColorHex: '000000', strokeOpacity: 100,
                    strokeDashArray: [], strokeDashOffset: 0,
                },
                cornerConfig: {
                    cornerLock: 0, cornerRadiusAll: 0, cornerRadiusTL: 0, cornerRadiusTR: 0,
                    cornerRadiusBL: 0, cornerRadiusBR: 0,
                },
                shadowGlowConfig: {
                    shadowEnable: 0, shadowOffsetX: 0, shadowOffsetY: 8, shadowBlur: 20, shadowSpread: 0,
                    shadowColorHex: '000000', shadowOpacity: 35,
                    glowEnable: 0, glowColorHex: 'ffffff', glowBlur: 30, glowSpread: 0, glowOpacity: 60, glowType: 'center',
                },
            }],
            cornerConfig: {
                cornerLock: 0, cornerRadiusAll: 0, cornerRadiusTL: 0, cornerRadiusTR: 0,
                cornerRadiusBL: 0, cornerRadiusBR: 0, shapeType: 'rounded', customShapeSvg: '',
            },
            filmTearConfig: {
                tearEnable: 0, tearStrength: 50, tearDensity: 8,
                filmPerforationEnable: 0, filmPerforationType: 'square', filmPerforationSize: 20, filmPerforationSpacing: 20,
                dustScratchEnable: 0, dustScratchIntensity: 0, yellowingEnable: 0, yellowingStrength: 0,
            },
            lightEffect: {
                vignetteEnable: 0, vignetteStrength: 0, vignetteFeather: 50,
                lightLeakEnable: 0, lightLeakType: 'warm', lightLeakOpacity: 40, lightLeakAngle: 225,
                filmGrainEnable: 0, filmGrainIntensity: 0,
            },
            decorConfig: {
                exifAutoText: 0, textLines: [], stickers: [],
                cornerDecorEnable: 0, cornerDecorType: 'line', cornerDecorSize: 30,
            },
            logoElements: [],
            paramFontSize: 33, paramType: 0, paramPosition: 'CENTER',
            puzzle: {
                enabled: 0, layout: 'single', layoutType: 0, gap: 6, slotFill: 'cover', bgMode: 0,
                canvasRatio: 'auto', borderColor: 'ffffff', offsetX: 0, offsetY: 0, zoom: 100,
                slots: {}, axisVals: {}, captions: {}, gapCaptions: {},
            },
        };
    },


    syncModelFromUI() {
        if (this.isUpdating || !this.template || !this.image) return;
        const $ = this.$;
        const m = this.template.baseMargin || (this.template.baseMargin = {});
        const layer = this.currentLayer() || {};
        const fill = layer.fillConfig || (layer.fillConfig = {});
        const stroke = layer.strokeConfig || (layer.strokeConfig = {});
        const sg = layer.shadowGlowConfig || (layer.shadowGlowConfig = {});
        const cc = this.template.cornerConfig || (this.template.cornerConfig = {});
        const ft = this.template.filmTearConfig || (this.template.filmTearConfig = {});
        const le = this.template.lightEffect || (this.template.lightEffect = {});
        const decor = this.template.decorConfig || (this.template.decorConfig = {});

        this.template.canvasRatio = $('cbCanvasRatio') ? $('cbCanvasRatio').value : 'original';
        const gm = $('slGlobalMargin') ? parseInt($('slGlobalMargin').value, 10) / 100 : 1;
        m.globalMargin = gm;
        this.applyGlobalMargin(gm, false);

        m.imgScale = $('slImgScale') ? parseInt($('slImgScale').value, 10) / 100 : (m.imgScale || 1);
        m.imgOffsetX = num($('tfImgOffsetX'), m.imgOffsetX);
        m.imgOffsetY = num($('tfImgOffsetY'), m.imgOffsetY);

        if ($('cbCornerLock')) cc.cornerLock = $('cbCornerLock').checked ? 1 : 0;
        const r = $('slCornerRadius') ? parseInt($('slCornerRadius').value, 10) : (cc.cornerRadiusAll || 0);
        cc.cornerRadiusAll = r;
        cc.cornerRadiusTL = num($('slCornerTL'), r);
        cc.cornerRadiusTR = num($('slCornerTR'), r);
        cc.cornerRadiusBL = num($('slCornerBL'), r);
        cc.cornerRadiusBR = num($('slCornerBR'), r);

        this.template.paramPosition = $('cbParamPosition') ? $('cbParamPosition').value : 'CENTER';
        this.template.paramFontSize = $('slParamFontSize') ? parseInt($('slParamFontSize').value, 10) : 33;
        this.template.userSignature = $('inpSignature') ? $('inpSignature').value : '';
        this.template.paramType = $('cbParamType') ? parseInt($('cbParamType').value, 10) : 0;
        this.syncManualExif();

        if ($('cbLayerVisible')) layer.visible = $('cbLayerVisible').checked ? 1 : 0;

        fill.fillType = $('cbFillType') ? $('cbFillType').value : 'solid';
        fill.fillHex = $('cpFillColor') ? $('cpFillColor').value.replace('#', '') : 'eeeeee';
        fill.fillOpacity = $('slFillOpacity') ? parseInt($('slFillOpacity').value, 10) : 100;
        fill.gradientType = $('cbGradientType') ? $('cbGradientType').value : 'linear';
        fill.gradientAngle = $('slGradientAngle') ? parseInt($('slGradientAngle').value, 10) : 45;
        fill.textureSrc = fill.textureSrc || '';
        fill.textureScale = $('slTextureScale') ? parseInt($('slTextureScale').value, 10) / 100 : 1;
        fill.textureBlend = $('cbTextureBlend') ? $('cbTextureBlend').value : 'normal';

        stroke.strokeWidth = $('slStrokeWidth') ? parseInt($('slStrokeWidth').value, 10) : 0;
        stroke.strokePos = $('cbStrokePos') ? $('cbStrokePos').value : 'inside';
        stroke.strokeColorHex = $('cpStrokeColor') ? $('cpStrokeColor').value.replace('#', '') : '000000';
        stroke.strokeOpacity = $('slStrokeOpacity') ? parseInt($('slStrokeOpacity').value, 10) : 100;
        stroke.strokeDashArray = $('tfStrokeDash') ? dashToArray($('tfStrokeDash').value) : [];

        const lcc = layer.cornerConfig || (layer.cornerConfig = {});
        if ($('cbLayerCornerLock')) lcc.cornerLock = $('cbLayerCornerLock').checked ? 1 : 0;
        const lr = $('slLayerCornerRadius') ? parseInt($('slLayerCornerRadius').value, 10) : (lcc.cornerRadiusAll || 0);
        lcc.cornerRadiusAll = lr;
        lcc.cornerRadiusTL = num($('slLayerCornerTL'), lr);
        lcc.cornerRadiusTR = num($('slLayerCornerTR'), lr);
        lcc.cornerRadiusBL = num($('slLayerCornerBL'), lr);
        lcc.cornerRadiusBR = num($('slLayerCornerBR'), lr);

        sg.shadowEnable = ($('cbShadow') && $('cbShadow').checked) ? 1 : 0;
        sg.shadowOffsetX = $('slShadowX') ? parseInt($('slShadowX').value, 10) : 0;
        sg.shadowOffsetY = $('slShadowY') ? parseInt($('slShadowY').value, 10) : 8;
        sg.shadowBlur = $('slShadowBlur') ? parseInt($('slShadowBlur').value, 10) : 20;
        sg.shadowSpread = $('slShadowSpread') ? parseInt($('slShadowSpread').value, 10) : 0;
        sg.shadowColorHex = $('cpShadowColor') ? $('cpShadowColor').value.replace('#', '') : '000000';
        sg.shadowOpacity = $('slShadowOpacity') ? parseInt($('slShadowOpacity').value, 10) : 35;
        sg.glowEnable = ($('cbGlow') && $('cbGlow').checked) ? 1 : 0;
        sg.glowColorHex = $('cpGlowColor') ? $('cpGlowColor').value.replace('#', '') : 'ffffff';
        sg.glowBlur = $('slGlowBlur') ? parseInt($('slGlowBlur').value, 10) : 30;
        sg.glowOpacity = $('slGlowOpacity') ? parseInt($('slGlowOpacity').value, 10) : 60;

        ft.tearEnable = ($('cbTearEnable') && $('cbTearEnable').checked) ? 1 : 0;
        ft.tearStrength = $('slTearStrength') ? parseInt($('slTearStrength').value, 10) : 50;
        ft.tearDensity = $('slTearDensity') ? parseInt($('slTearDensity').value, 10) : 8;

        le.vignetteEnable = ($('cbVignette') && $('cbVignette').checked) ? 1 : 0;
        le.vignetteStrength = $('slVignetteStrength') ? parseInt($('slVignetteStrength').value, 10) : 0;
        le.vignetteFeather = $('slVignetteFeather') ? parseInt($('slVignetteFeather').value, 10) : 50;
        le.lightLeakEnable = ($('cbLightLeak') && $('cbLightLeak').checked) ? 1 : 0;
        le.lightLeakType = $('cbLeakType') ? $('cbLeakType').value : 'warm';
        le.lightLeakOpacity = $('slLeakOpacity') ? parseInt($('slLeakOpacity').value, 10) : 40;
        le.lightLeakAngle = $('slLeakAngle') ? parseInt($('slLeakAngle').value, 10) : 225;
        // 颗粒只有一个滑块,没有独立开关:强度 0 即"关闭"。
        // 这样面板少一行,而且不会出现"开关开着但强度是 0,看着像坏了"的组合。
        // filmGrainEnable 仍然写进模型 —— 8 个老预设(NOMO复古相机/胶片相机/黑金胶片/
        // 怀旧相机/富士写真胶片/拍立得滤镜/拍立得相纸/轻胶片电影感)早就带着
        // filmGrainEnable:1 + filmGrainIntensity:6~18,只是引擎从来没读过(见 engine.js
        // applyFilmGrain 上方注释)。引擎认这个 flag,所以从预设载入时必须保留它。
        const fgv = $('slFilmGrain') ? parseInt($('slFilmGrain').value, 10) : 0;
        le.filmGrainIntensity = fgv;
        if (fgv > 0) le.filmGrainEnable = 1;

        if ($('cbExifText')) decor.exifAutoText = $('cbExifText').checked ? 1 : 0;
        decor.cornerDecorEnable = ($('cbCornerDecor') && $('cbCornerDecor').checked) ? 1 : 0;
        decor.cornerDecorType = $('cbCornerDecorType') ? $('cbCornerDecorType').value : 'line';
        decor.cornerDecorSize = $('slCornerDecorSize') ? parseInt($('slCornerDecorSize').value, 10) : 30;

        this.syncPuzzleFromUI();
    },

    syncManualExif() {
        const $ = this.$;
        const efs = ['tfExifBrand', 'tfExifModel', 'tfExifFocal', 'tfExifAperture', 'tfExifIso', 'tfExifShutter'];
        const v = ['brand', 'model', 'focal', 'aperture', 'iso', 'shutter'].map((k, i) => {
            const inp = $(efs[i]);
            return [k, inp ? String(inp.value).trim() : ''];
        });
        const manual = {};
        v.forEach(([k, val]) => { if (val) manual[k] = val; });
        this.template.manualExif = Object.keys(manual).length ? manual : null;
        this.updateExifLine();
    },

    updateExifLine() {
        const $ = this.$;
        const m = this.template && this.template.manualExif;
        const el = $('exifLine'), txt = $('exifLineText');
        if (el && txt) {
            if (m && (m.brand || m.model || m.focal || m.aperture || m.iso || m.shutter)) {
                const parts = [m.brand && m.model ? `${m.brand} ${m.model}` : (m.brand || m.model), m.focal, m.aperture, m.iso, m.shutter].filter(Boolean);
                txt.textContent = parts.join(' · ');
                el.style.display = '';
            } else { el.style.display = 'none'; }
        }
        },

    // 全局边距:按参考值等比缩放四边
    applyGlobalMargin(scale, setSlider) {
        const m = this.template.baseMargin || {};
        if (m.refTop == null) { m.refTop = m.marginTop != null ? m.marginTop : 80; m.refBottom = m.marginBottom != null ? m.marginBottom : 120; m.refLeft = m.marginLeft != null ? m.marginLeft : 80; m.refRight = m.marginRight != null ? m.marginRight : 80; }
        m.marginTop = Math.round((m.refTop || 0) * scale);
        m.marginBottom = Math.round((m.refBottom || 0) * scale);
        m.marginLeft = Math.round((m.refLeft || 0) * scale);
        m.marginRight = Math.round((m.refRight || 0) * scale);
        m.globalMargin = scale;
        const $ = this.$;
        if (setSlider && $('slGlobalMargin')) $('slGlobalMargin').value = Math.round(scale * 100);
        if (this.image) this.refreshMarginFields();
        this.updateLabel('lblGlobalMargin', Math.round(scale * 100) + '%');
    },

    refreshMarginFields() {
        const $ = this.$;
        const m = this.template.baseMargin || {};
        if ($('slGlobalMargin')) { const g = m.globalMargin != null ? m.globalMargin : 1; $('slGlobalMargin').value = Math.round(g * 100); this.updateLabel('lblGlobalMargin', Math.round(g * 100) + '%'); }
    },

    // 面板行显隐:判定全部来自 style-caps.js(能力表)。
    // 五个数值滑块(参数字号/圆角/统一边距/图片缩放/背景模糊程度)按**实测**能力显示 ——
    // 即"该风格在引擎里真的读这个参数"才露出来,不再给用户拖了没反应的滑块。
    // 实测数据由 npm run gen:caps 从视觉回归基线生成,本函数不做任何名单判断。
    updatePersonalVisibility() {
        if (!this.template) return;
        const rows = window.StyleCaps.visibleRows(this.template.photoFrameStyle || '');
        for (const id in rows) {
            const el = document.getElementById(id);
            if (el) el.style.display = rows[id] ? '' : 'none';
        }
        this.syncEmptyGroups();
    },

    // 行全被能力表隐藏时,把整组一起收起 —— 否则右侧只剩一个光标题的空卡片。
    // 实测出现率:「品牌行」73/85、「背景模糊」71/85、「签名/头像」66/85、「照片」39/85、「参数文字」32/85,
    // 用户看到的就是"面板像没加载完"。
    // 只收起"我们自己收起的"组:组可能由别的逻辑管着(.ctl-grp-light 按模式、#vbCaptionEditor 按状态),
    // 所以用 data 标记记账 —— 不碰它们,也就不存在误恢复。
    // 判可见用 computedStyle 而不是 offsetParent:面板本身隐藏时,行/组的 display 仍是各自的值。
    syncEmptyGroups() {
        const groups = document.querySelectorAll('.insp-body .param-group');
        for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            const shown = (el) => window.getComputedStyle(el).display !== 'none';
            let content = false;
            const rows = g.querySelectorAll('.param-row');
            for (let k = 0; k < rows.length && !content; k++) if (shown(rows[k])) content = true;
            // 行之外的内容(按钮行/提示框/模板列表…)可见时,组也得留着
            for (let k = 0; k < g.children.length && !content; k++) {
                const el = g.children[k];
                if (el.classList.contains('pg-title') || el.classList.contains('param-row')) continue;
                if (shown(el)) content = true;
            }
            const collapsed = g.dataset.emptyCollapsed === '1';
            if (content) {
                if (collapsed) { g.style.display = ''; delete g.dataset.emptyCollapsed; }
            } else if (!collapsed && g.style.display !== 'none') {
                g.style.display = 'none';
                g.dataset.emptyCollapsed = '1';
            }
        }
    },

    // 角饰关着时,下面的「样式/大小」调了也不会画:直接禁用,避免"滑了没反应"。
    syncCornerDecorState() {
        const cb = document.getElementById('cbCornerDecor');
        const on = !!(cb && cb.checked);
        ['cbCornerDecorType', 'slCornerDecorSize'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = !on;
            const row = el && el.closest('.param-row');
            if (row) row.classList.toggle('row-disabled', !on);
        });
    },

    // 回显:模板 -> 控件
    refreshUI() {
        if (!this.template) return;
        this.isUpdating = true;
        try {
            const $ = this.$;
            const m = this.template.baseMargin || {};
            const layer = this.currentLayer() || {};
            const fill = layer.fillConfig || {};
            const stroke = layer.strokeConfig || {};
            const sg = layer.shadowGlowConfig || {};
            const cc = this.template.cornerConfig || {};
            const decor = this.template.decorConfig || {};

            if ($('cbCanvasRatio')) $('cbCanvasRatio').value = this.template.canvasRatio || 'original';
            this.refreshMarginFields();
            if ($('slImgScale')) $('slImgScale').value = Math.round((m.imgScale || 1) * 100);
            this.updateLabel('lblImgScale', Math.round((m.imgScale || 1) * 100) + '%');
            if ($('tfImgOffsetX')) $('tfImgOffsetX').value = m.imgOffsetX || 0;
            if ($('tfImgOffsetY')) $('tfImgOffsetY').value = m.imgOffsetY || 0;

            if ($('cbCornerLock')) $('cbCornerLock').checked = (cc.cornerLock || 0) === 1;
            const r = cc.cornerRadiusAll != null ? cc.cornerRadiusAll : 0;
            if ($('slCornerRadius')) $('slCornerRadius').value = r;
            this.updateLabel('lblCornerRadius', r);
            const br = this.template.borderRadius || 0;
            if ($('slBorderRadius')) $('slBorderRadius').value = br;
            this.updateLabel('lblBorderRadius', br);
            if ($('slCornerTL')) $('slCornerTL').value = cc.cornerRadiusTL || 0;
            if ($('slCornerTR')) $('slCornerTR').value = cc.cornerRadiusTR || 0;
            if ($('slCornerBL')) $('slCornerBL').value = cc.cornerRadiusBL || 0;
            if ($('slCornerBR')) $('slCornerBR').value = cc.cornerRadiusBR || 0;
            this.updateLabel('lblCornerTL', cc.cornerRadiusTL || 0); this.updateLabel('lblCornerTR', cc.cornerRadiusTR || 0);
            this.updateLabel('lblCornerBL', cc.cornerRadiusBL || 0); this.updateLabel('lblCornerBR', cc.cornerRadiusBR || 0);

            if ($('cbParamPosition')) $('cbParamPosition').value = this.template.paramPosition || 'CENTER';
            if ($('slParamFontSize')) $('slParamFontSize').value = this.template.paramFontSize != null ? this.template.paramFontSize : 33;
            if ($('slBrandSize')) {
                const bs = Math.round((this.template.brandSize != null ? this.template.brandSize : 1) * 100);
                $('slBrandSize').value = bs;
                this.updateLabel('lblBrandSize', bs + '%');
            }
            if ($('slParamScale')) {
                const psc = Math.round((this.template.paramScale != null ? this.template.paramScale : 1) * 100);
                $('slParamScale').value = psc;
                this.updateLabel('lblParamScale', psc + '%');
            }
            if ($('inpSignature')) $('inpSignature').value = this.template.userSignature || '';
            if ($('cbSignFont')) $('cbSignFont').value = this.template.signFont || 'cursive';
            if ($('cbSignColor')) $('cbSignColor').value = this.template.signColor || '#555';
            if ($('chkSignModel')) $('chkSignModel').checked = !!(this.template.signIncludeModel);
            if ($('chkBrandLogo')) $('chkBrandLogo').value = String(this.template.brandLogo || 0);
            if ($('chkAvatarShow')) $('chkAvatarShow').checked = this.template.avatarShow !== 0;
            if ($('rgAvatarScale')) { const v = Math.round((this.template.avatarScale || 0.85) * 100); $('rgAvatarScale').value = v; if ($('valAvatarScale')) $('valAvatarScale').textContent = v + '%'; }
            if ($('rgSignSize')) { const v2 = Math.round((this.template.signSize || 1) * 100); $('rgSignSize').value = v2; if ($('valSignSize')) $('valSignSize').textContent = v2 + '%'; }
            if ($('chkBgBlur')) $('chkBgBlur').checked = !!this.template.signBgBlur;
            const biV = this.template.blurIntensity != null ? this.template.blurIntensity : 50;
            if ($('slBgBlurInt')) $('slBgBlurInt').value = biV;
            this.updateLabel('lblBgBlurInt', biV + '%');
            const rowBI2 = document.getElementById('rowBgBlurInt');
            if (rowBI2) rowBI2.style.display = $('chkBgBlur') && $('chkBgBlur').checked ? '' : 'none';
            if ($('cbParamColor')) $('cbParamColor').value = this.template.paramColor || 'auto';
            this.updatePersonalVisibility();
            if (this.template.userAvatar) {
                const img = new Image();
                img.onload = () => { this.avatarImg = img; window.__qfsAvatarImg = img; this.renderPreview(); };
                img.src = this.template.userAvatar;
            }
            this.updateParamFontLabel();
            if ($('cbParamType')) $('cbParamType').value = String(this.template.paramType != null ? this.template.paramType : 0);

            // EXIF 输入框回填:手动(manualExif)优先,自动识别(image.exif)兜底
            const manExif = (this.template.manualExif && typeof this.template.manualExif === 'object') ? this.template.manualExif : {};
            const autoExif = this.camLibMatchExif((this.image && this.image.exif) || {});
            const exifMap = [
                ['tfExifBrand', 'brand', 'make'], ['tfExifModel', 'model', 'model'],
                ['tfExifFocal', 'focal', 'focal'], ['tfExifAperture', 'aperture', 'aperture'],
                ['tfExifIso', 'iso', 'iso'], ['tfExifShutter', 'shutter', 'shutter'],
            ];
            exifMap.forEach(([id, mk, ek]) => {
                const el = $(id);
                if (el) el.value = (manExif[mk] || '').trim() || (autoExif[ek] || '');
            });
            if ($('cbFillType')) $('cbFillType').value = fill.fillType || 'solid';
            if ($('cpFillColor')) $('cpFillColor').value = '#' + (fill.fillHex || 'eeeeee');
            if ($('slFillOpacity')) $('slFillOpacity').value = fill.fillOpacity != null ? fill.fillOpacity : 100;
            this.updateLabel('lblFillOpacity', (fill.fillOpacity != null ? fill.fillOpacity : 100) + '%');
            if ($('cbGradientType')) $('cbGradientType').value = fill.gradientType || 'linear';
            if ($('slGradientAngle')) $('slGradientAngle').value = fill.gradientAngle || 45;
            this.updateLabel('lblGradientAngle', fill.gradientAngle || 45);
            if ($('slTextureScale')) $('slTextureScale').value = Math.round((fill.textureScale || 1) * 100);
            this.updateLabel('lblTextureScale', Math.round((fill.textureScale || 1) * 100) + '%');
            if ($('cbTextureBlend')) $('cbTextureBlend').value = fill.textureBlend || 'normal';

            if ($('slStrokeWidth')) $('slStrokeWidth').value = stroke.strokeWidth || 0;
            this.updateLabel('lblStrokeWidth', stroke.strokeWidth || 0);
            if ($('cbStrokePos')) $('cbStrokePos').value = stroke.strokePos || 'inside';
            if ($('cpStrokeColor')) $('cpStrokeColor').value = '#' + (stroke.strokeColorHex || '000000');
            if ($('slStrokeOpacity')) $('slStrokeOpacity').value = stroke.strokeOpacity != null ? stroke.strokeOpacity : 100;
            this.updateLabel('lblStrokeOpacity', (stroke.strokeOpacity != null ? stroke.strokeOpacity : 100) + '%');
            if ($('tfStrokeDash')) $('tfStrokeDash').value = (stroke.strokeDashArray || []).join(',');

            const lcc = layer.cornerConfig || {};
            if ($('cbLayerCornerLock')) $('cbLayerCornerLock').checked = (lcc.cornerLock || 0) === 1;
            const lr = lcc.cornerRadiusAll != null ? lcc.cornerRadiusAll : 0;
            if ($('slLayerCornerRadius')) $('slLayerCornerRadius').value = lr;
            if ($('slLayerCornerTL')) $('slLayerCornerTL').value = lcc.cornerRadiusTL || 0;
            if ($('slLayerCornerTR')) $('slLayerCornerTR').value = lcc.cornerRadiusTR || 0;
            if ($('slLayerCornerBL')) $('slLayerCornerBL').value = lcc.cornerRadiusBL || 0;
            if ($('slLayerCornerBR')) $('slLayerCornerBR').value = lcc.cornerRadiusBR || 0;
            this.updateLabel('lblLayerCornerTL', lcc.cornerRadiusTL || 0); this.updateLabel('lblLayerCornerTR', lcc.cornerRadiusTR || 0);
            this.updateLabel('lblLayerCornerBL', lcc.cornerRadiusBL || 0); this.updateLabel('lblLayerCornerBR', lcc.cornerRadiusBR || 0);
            this.updateLabel('lblLayerCornerRadius', lr);

if ($('cbShadow')) $('cbShadow').checked = (sg.shadowEnable || 0) === 1;
            this.syncShadowL();

            if ($('cbGlow')) $('cbGlow').checked = (sg.glowEnable || 0) === 1;

            const ft = this.template.filmTearConfig || {};
            if ($('cbTearEnable')) $('cbTearEnable').checked = (ft.tearEnable || 0) === 1;
            if ($('slTearStrength')) $('slTearStrength').value = ft.tearStrength || 0;
            if ($('slTearDensity')) $('slTearDensity').value = ft.tearDensity || 8;
            this.updateLabel('lblTearStrength', ft.tearStrength || 0);
            this.updateLabel('lblTearDensity', ft.tearDensity || 8);

            const le = this.template.lightEffect || {};
            if ($('cbVignette')) $('cbVignette').checked = (le.vignetteEnable || 0) === 1;
            if ($('slVignetteStrength')) $('slVignetteStrength').value = le.vignetteStrength || 0;
            if ($('slVignetteFeather')) $('slVignetteFeather').value = le.vignetteFeather != null ? le.vignetteFeather : 50;
            this.updateLabel('lblVignetteStrength', (le.vignetteStrength || 0) + '%');
            this.updateLabel('lblVignetteFeather', le.vignetteFeather != null ? le.vignetteFeather : 50);
            if ($('cbLightLeak')) $('cbLightLeak').checked = (le.lightLeakEnable || 0) === 1;
            if ($('cbLeakType')) $('cbLeakType').value = le.lightLeakType || 'warm';
            if ($('slLeakOpacity')) $('slLeakOpacity').value = le.lightLeakOpacity != null ? le.lightLeakOpacity : 40;
            if ($('slLeakAngle')) $('slLeakAngle').value = le.lightLeakAngle != null ? le.lightLeakAngle : 225;
            this.updateLabel('lblLeakOpacity', (le.lightLeakOpacity != null ? le.lightLeakOpacity : 40) + '%');
            this.updateLabel('lblLeakAngle', (le.lightLeakAngle != null ? le.lightLeakAngle : 225) + '°');
            // 颗粒:以 enable 为准显示,而不是直接显示 intensity。
            // 绝大多数预设存的是 filmGrainEnable:0 + filmGrainIntensity:10(那个 10 是
            // 没人读过的历史遗留值)。若直接显示 intensity,滑块会显示 10% 而画面上
            // 一点颗粒都没有 —— 用户会以为控件坏了。
            const fgOn = le.filmGrainEnable === 1;
            const fgVal = fgOn ? (le.filmGrainIntensity || 0) : 0;
            if ($('slFilmGrain')) $('slFilmGrain').value = fgVal;
            this.updateLabel('lblFilmGrain', fgVal + '%');

            if ($('cbCornerDecor')) $('cbCornerDecor').checked = (decor.cornerDecorEnable || 0) === 1;
            if ($('cbCornerDecorType')) $('cbCornerDecorType').value = decor.cornerDecorType || 'line';
            if ($('slCornerDecorSize')) $('slCornerDecorSize').value = decor.cornerDecorSize || 30;
            this.updateLabel('lblCornerDecorSize', decor.cornerDecorSize || 30);
            this.syncCornerDecorState();

            if ($('cbExifText')) $('cbExifText').checked = (decor.exifAutoText || 0) === 1;

            this.refreshElList();
            this.refreshTemplateFields();
            this.refreshPuzzleUI();
            this.updateHistoryButtons();
            this.applyModeControls();
        } finally {
            this.isUpdating = false;
        }
    },

    // 面板联动:图层组只服务默认模板样式;光影组在相框样式下不生效,整页隐藏
    applyModeControls() {
        const t = this.template;
        if (!t) return;
        const pf = String(t.photoFrameStyle || '').toUpperCase();
        const frame = !!(pf && pf !== 'NONE');
        const card = !frame && (t.baseMargin || {}).bgBlurEnable === 1;
        const showLayers = !frame && !card;
        const showLight = !frame;
        const q = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));
        q('.ctl-grp-layers').forEach(el => { el.style.display = showLayers ? '' : 'none'; });
        q('.ctl-grp-light').forEach(el => { el.style.display = showLight ? '' : 'none'; });
        // 撕边(胶片齿孔掩膜)只在默认图层管线读 filmTearConfig;相框样式 / 卡片(模糊底)渲染不走该管线,整组隐藏
        const torn = document.getElementById('pbTornFilm');
        if (torn) torn.style.display = showLayers ? '' : 'none';
        const lightTab = document.querySelector('#inspTabs [data-tab="light"]');
        if (lightTab) lightTab.style.display = showLight ? '' : 'none';
        if (!showLight) {
            const active = document.querySelector('.tab.active');
            if (active && active.getAttribute('data-tab') === 'light') {
                const firstVis = document.querySelector('#inspTabs .tab:not([style*="display: none"])');
                if (firstVis) firstVis.click();
            }
        }
        // 当前样式条:把"现在走哪条渲染管线"显性化,解释为何部分控件消失
        const ms = document.getElementById('modeStatus');
        if (ms) {
            const frameName = String(t.photoFrameStyle || '').toUpperCase();
            const isFrame = !!(frameName && frameName !== 'NONE');
            const isCard = !isFrame && (t.baseMargin || {}).bgBlurEnable === 1;
            let kind, name;
            if (isFrame) {
                kind = '相框样式';
                const preset = this.presets.find(p => String(p.photoFrameStyle || '').toUpperCase() === frameName);
                name = preset ? (preset.templateName || frameName) : frameName;
            } else if (isCard) {
                kind = '卡片 / 模糊底';
                name = t.templateName || '';
            } else {
                kind = '图层模板';
                name = t.templateName || '';
            }
            ms.style.display = '';
            ms.textContent = '当前样式：' + kind + (name ? ' · ' + name : '');
        }
    },

    syncShadowL() {
        const $ = this.$;
        const layer = this.currentLayer() || {};
        const sg = layer.shadowGlowConfig || {};
        const map = [
            ['slShadowX', 'slShadowXL', 'lblShadowX', 'lblShadowXL', 'shadowOffsetX'],
            ['slShadowY', 'slShadowYL', 'lblShadowY', 'lblShadowYL', 'shadowOffsetY'],
            ['slShadowBlur', 'slShadowBlurL', 'lblShadowBlur', 'lblShadowBlurL', 'shadowBlur'],
            ['slShadowSpread', 'slShadowSpreadL', 'lblShadowSpread', 'lblShadowSpreadL', 'shadowSpread'],
        ];
        map.forEach(([a, b, la, lb, key]) => {
            const v = sg[key] != null ? sg[key] : 0;
            if ($(a)) $(a).value = v;
            if ($(b)) $(b).value = v;
            this.updateLabel(la, v);
            this.updateLabel(lb, v);
        });
        const c = sg.shadowColorHex || '000000', o = sg.shadowOpacity != null ? sg.shadowOpacity : 35;
        if ($('cpShadowColor')) $('cpShadowColor').value = '#' + c;
        if ($('cpShadowColorL')) $('cpShadowColorL').value = '#' + c;
        this.updateLabel('lblShadowOpacity', o + '%');
        this.updateLabel('lblShadowOpacityL', o + '%');
        const g = sg.glowBlur || 30, go = sg.glowOpacity != null ? sg.glowOpacity : 60;
        if ($('slGlowBlur')) $('slGlowBlur').value = g; if ($('slGlowBlurL')) $('slGlowBlurL').value = g;
        if ($('slGlowOpacity')) $('slGlowOpacity').value = go; if ($('slGlowOpacityL')) $('slGlowOpacityL').value = go;
        this.updateLabel('lblGlowBlur', g); this.updateLabel('lblGlowBlurL', g);
        this.updateLabel('lblGlowOpacity', go + '%'); this.updateLabel('lblGlowOpacityL', go + '%');
        if ($('cpGlowColor')) $('cpGlowColor').value = '#' + (sg.glowColorHex || 'ffffff');
        if ($('cpGlowColorL')) $('cpGlowColorL').value = '#' + (sg.glowColorHex || 'ffffff');
    },

    updateLabel(id, text) {
        const el = this.$(id);
        if (el) {
            // 高频路径(每帧的滑块/边距/EXIF 标签)会反复进来,值没变就不碰 DOM:
            // 同值写 textContent 虽不触发重排,但每次都要走字符串化与样式失效检查,累起来不划算。
            const s = String(text);
            if (el.textContent !== s) el.textContent = s;
        }
    },

    // 字号标签只报「档位」,不报像素。
    // 档位会按照片宽度缩放(autoExifSize = 档位 × clamp(iw/1200, 0.5, 8)),同一档位在
    // 1200px 与 4000px 宽的照片上能差 3 倍以上。所以这里若折算成 px,标签就是个会跳的
    // 假数字 —— 用户拖到 100 看到"333px",换张图又变 213px,正是"字号不跟随"的观感来源。
    // 自适应本身就是按图宽算的,报一个具体 px 只会让人误以为它是定值,故只报"自适应"。
    updateParamFontLabel() {
        const v = this.template.paramFontSize != null ? this.template.paramFontSize : 33;
        if (v <= 0) {
            this.updateLabel('lblParamFontSize', '自适应');
            this.updateLabel('lblParamFontNote', '');
        } else {
            this.updateLabel('lblParamFontSize', String(v));
            this.updateLabel('lblParamFontNote', '按图宽自适应');
        }
    },

    currentLayer() {
        if (!this.template || !this.template.layerList || !this.template.layerList.length) {
            if (this.template) this.template.layerList = [this.defaultTemplate().layerList[0]];
            return this.template.layerList[0];
        }
        const idx = clampNum(this.selectedLayer || 0, 0, this.template.layerList.length - 1);
        return this.template.layerList[idx];
    },

    /* ══ 渲染调度 / 帧合成 → app-render.js ══ */


    saveCurrentTemplate() {
        if (!this.image) return;
        // 单一存取口(见 app-state.js):Map 与 customSettings 恒为同一对象。
        // 写入的是 cloneTemplate 快照,this.template 本体引用不变,selectedEls 不受影响
        this.setTpl(this.image, this.cloneTemplate());
        this.queueThumb(this.image);
        if (typeof this.scheduleDraft === 'function') this.scheduleDraft();
    },

    /* ══ 图片选择 / 每图模板 ══ */
    afterImageSelect() {
        if (!this.image) return;
        this.dom.placeholder.style.display = 'none';
        this.dom.canvas.style.display = 'block';
        this.updateEmptyState();
        const btn = document.getElementById('btnRestoreDraft');
        if (btn) btn.style.display = 'none';
        const saved = this.getTpl(this.image);
        if (saved) this.template = saved;
        else this.normalizeTemplate();
        this.selectedEls = [];
        this.updateStatusBar();
        this.refreshUI();
        this.autoFit = true;
        this.scheduleRender(true);
    },

    selectImage(idx) {
        // 离开带拼图的照片时记下旧图:拼图只保存在旧图自己的预设里,切走会在状态栏提示去向
        const prevIm = this.image;
        const prevHadPuzzle = !!(prevIm && this.images[idx] !== prevIm && this.tplPuzzle && this.tplPuzzle());
        this.selectedIdx = [idx];
        // 普通单击/切换 = 单选:连批量勾选也一并取消,只保留当前这张
        this.batchSel = [idx];
        this.currentIdx = idx;
        this.image = this.images[idx];
        // 有独立预设的图恢复其自身模板;没有独立预设的以默认(原图)开始,画布显示原图
        const saved = this.getTpl(this.image);
        this.template = saved ? JSON.parse(JSON.stringify(saved)) : this.defaultTemplate();
        this.invalidateStyleCaches();
        this.buildThumbnails();
        this.afterImageSelect();
        if (prevHadPuzzle && !(this.tplPuzzle && this.tplPuzzle())) {
            this.setStatus('拼图保存在「' + (prevIm.name || '上一张') + '」上（点胶片条切回该照片可继续编辑）');
        }
    },

    // 主照片旋转 90°(顺时针):重新生成位图替换 image.el,渲染/导出/缩略图同步生效
    async rotateCurrentPhoto() {
        const im = this.image;
        if (!im || !im.el) { this.setStatus('请先导入照片'); return; }
        const img = im.el;
        const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
        if (!W || !H) return;
        const canvas = document.createElement('canvas');
        canvas.width = H;
        canvas.height = W;
        const ctx = canvas.getContext('2d');
        ctx.translate(H / 2, W / 2);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(img, -W / 2, -H / 2);
        const out = new Image();
        await new Promise(r => { out.onload = r; out.onerror = r; out.src = canvas.toDataURL('image/jpeg', 0.95); });
        if (!out.naturalWidth) { this.setStatus('旋转失败'); return; }
        im.el = out;
        im.w = canvas.width;
        im.h = canvas.height;
        im.rotate = ((im.rotate || 0) + 1) % 4;
        if (this.invalidateStyleCaches) this.invalidateStyleCaches();
        if (this.buildThumbnails) this.buildThumbnails();
        this.scheduleRender(true);
        this.setStatus('照片已旋转 90°(再次右键可继续旋转)');
    },

    /* ══ 照片导入(拖拽/多选共用) ══ */
    async addImageFiles(files) {
        const images = files.filter(f => /^image\//i.test(f.type) || /\.(jpe?g|png|webp|bmp)$/i.test(f.name));
        if (!images.length) { this.setStatus('不支持的文件格式'); return; }
        const skipped = files.length - images.length;
        const total = images.length;
        this.showImportProgress(total);
        let done = 0;
        const tick = (name) => { done++; this.setImportProgress(done, total, name); };
        try {
            // 载入任务按 3 并发池跑:旧写法 Promise.allSettled(images.map(...)) 会让几十张
            // 24MP 大图同时开跑,解码缓冲/像素位图同时驻留直接把内存顶爆(拖拽导入后卡死的来源之一)
            const results = new Array(images.length).fill(null);
            let next = 0;
            const loadOne = async (i) => {
                const r = await this.loadFile(images[i]);
                if (!r || !r.url) { tick(images[i].name); return null; }
                const img = new Image();
                const loadedOk = await new Promise(res => { img.onload = () => res(true); img.onerror = () => res(false); img.src = r.url; });
                if (!loadedOk || !img.naturalWidth) { tick(images[i].name); if (r.revoke) r.revoke(); return null; }
                const rawExif = (r.buffer && window.__parseExif) ? window.__parseExif(r.buffer) : {};
                const exif = window.__exifSummary ? window.__exifSummary(rawExif) : {};
                const oriented = await this.applyOrientation(img, exif.orientation);
                if (r.revoke) r.revoke();
                const useEl = oriented ? oriented.el : img;
                const w = oriented ? oriented.w : img.naturalWidth;
                const h = oriented ? oriented.h : img.naturalHeight;
                tick(images[i].name);
                return { el: useEl, name: images[i].name, w, h, exif, customSettings: null };
            };
            const worker = async () => {
                for (;;) {
                    const i = next++;
                    if (i >= images.length) return;
                    try { results[i] = await loadOne(i); }
                    catch (e) { results[i] = null; }
                }
            };
            await Promise.all(Array.from({ length: Math.min(3, images.length) }, worker));
            let loaded = 0;
            for (let i = 0; i < results.length; i++) {
                const im = results[i];
                if (!im) continue;
                this.images.push(im);
                this.queueThumb(im);
                loaded++;
            }
            if (loaded) {
                if (typeof this.scheduleDraft === 'function') this.scheduleDraft();
                this.buildThumbnails();
                const pk = this.tplPuzzle && this.tplPuzzle();
                if (pk && this.image) {
                    // 拼图进行中导入:保留当前主图与拼图模板(旧写法 defaultTemplate+selectImage 会把
                    // 画面瞬间打回单张照片,看起来就像"拼图丢了");新图先只进胶片条,想拼进来点「重拼」或拖进格子
                    this.saveCurrentTemplate();
                    this.scheduleRender(true);
                    this.setStatus(`已导入 ${loaded} 张图片，拼图保持在「${this.image.name || '当前照片'}」上（可点「重拼」把新图填进格子）`);
                } else {
                    this.template = this.defaultTemplate();
                    this.normalizeTemplate();
                    this.selectImage(this.images.length - loaded);
                    this.setStatus(`已导入 ${loaded} 张图片${skipped ? '，跳过 ' + skipped + ' 个不支持的文件' : ''}`);
                }
            } else if (skipped) this.setStatus('不支持的文件格式');
        } finally {
            this.finishImportProgress();
        }
    },

    // 导入进度条:total>0 显示;set 更新百分比/文案;finish 置满后淡出
    showImportProgress(total) {
        const prog = this.dom.importProgress;
        if (!prog) return;
        this._importTotal = total;
        this._importDone = 0;
        prog.style.display = 'flex';
        this.setImportProgress(0, total, null);
    },
    setImportProgress(done, total, name) {
        const prog = this.dom.importProgress;
        if (!prog) return;
        const pct = Math.max(0, Math.min(100, Math.round(done / Math.max(1, total || 1) * 100)));
        if (this.dom.importProgressFill) this.dom.importProgressFill.style.width = pct + '%';
        if (this.dom.importProgressText) this.dom.importProgressText.textContent = `正在导入 ${done}/${total}${name ? ' · ' + name : ''}`;
    },
    finishImportProgress() {
        const prog = this.dom.importProgress;
        if (!prog) return;
        if (this.dom.importProgressFill) this.dom.importProgressFill.style.width = '100%';
        if (this.dom.importProgressText) this.dom.importProgressText.textContent = '导入完成';
        setTimeout(() => { prog.style.display = 'none'; }, 420);
    },

    async loadFile(file) {
        // ObjectURL 直接引用磁盘(内存不再产生 base64 字符串);buffer 仅临时用于 EXIF 解析
        const url = URL.createObjectURL(file);
        const buf = await file.arrayBuffer().catch(() => null);
        return { url, buffer: buf, revoke: () => URL.revokeObjectURL(url) };
    },

    async applyOrientation(img, orientation) {
        if (!orientation || orientation === 1 || orientation === 0) return null;
        orientation = orientation | 0;
        const W = img.naturalWidth, H = img.naturalHeight;
        // 旋转类(3/6/8,含镜像的 5/7)需要交换宽高;纯翻转(2/4)保持宽高
        const swapsWH = (orientation === 6 || orientation === 8 || orientation === 5 || orientation === 7);
        const canvas = document.createElement('canvas');
        canvas.width = swapsWH ? H : W;
        canvas.height = swapsWH ? W : H;
        const ctx = canvas.getContext('2d');
        ctx.translate(canvas.width / 2, canvas.height / 2);
        switch (orientation) {
            case 2: ctx.scale(-1, 1); break;                  // 水平翻转
            case 3: ctx.rotate(Math.PI); break;               // 180°
            case 4: ctx.scale(1, -1); break;                  // 垂直翻转
            case 5: ctx.rotate(Math.PI / 2); ctx.scale(1, -1); break; // 转置+镜像
            case 6: ctx.rotate(Math.PI / 2); break;           // 90°
            case 7: ctx.rotate(-Math.PI / 2); ctx.scale(1, -1); break; // 横转+镜像
            case 8: ctx.rotate(-Math.PI / 2); break;          // 270°
            default: return null;
        }
        ctx.drawImage(img, -W / 2, -H / 2);
        const out = new Image();
        await new Promise(res => { out.onload = res; out.onerror = res; out.src = canvas.toDataURL('image/jpeg', 0.95); });
        if (!out.naturalWidth) return null;
        return { el: out, w: canvas.width, h: canvas.height };
    },

    // 本地照片引用 URL(经 qflocal: 协议由主进程直接流式读取,不产生 base64 副本)
    photoUrl(filePath) { return 'qflocal://img?p=' + encodeURIComponent(filePath); },

    // 把系统选择框返回的单个文件构造成胶片条照片对象(不插入)
    async imageFromPick(res) {
        if (!res) return null;
        if (!res.path) { this.setStatus('图片加载失败：缺少文件路径'); return null; }
        const img = new Image();
        const src = this.photoUrl(res.path);
        await new Promise(r => { img.onload = r; img.onerror = r; img.src = src; });
        if (!img.naturalWidth) return null;
        const exif = res.exif || {};
        const oriented = await this.applyOrientation(img, exif.orientation);
        const useEl = oriented ? oriented.el : img;
        const w = oriented ? oriented.w : img.naturalWidth;
        const h = oriented ? oriented.h : img.naturalHeight;
        const im = { el: useEl, name: res.name, path: res.path, w, h, exif, customSettings: null };
        this.queueThumb(im);
        return im;
    },

    // 把系统选择框返回的单个文件载入胶片条,返回其索引
    async appendImageFromPick(res) {
        const im = await this.imageFromPick(res);
        if (!im) return -1;
        this.images.push(im);
        return this.images.length - 1;
    },

    // 在胶片条指定位置插入新照片(打开系统选择框)。修改列表后只重新计算布局几何,
    // 保留已有格子图片与编辑状态(不自动重拼;需要完整复原请点「重拼(按序填满)」)
    async insertImageFromPick(k) {
        const res = await window.qingframe.openImage();
        if (!res) return;
        const im = await this.imageFromPick(res);
        if (!im) { this.setStatus('图片加载失败，未插入'); return; }
        const pos = Math.max(0, Math.min(k, this.images.length));
        this.images.splice(pos, 0, im);
        // 插入照片会右移列表索引:平移槽位/勾选/选中引用,保持已有格子内容与编辑状态对应正确
        const pik = this.template && this.template.puzzle;
        if (pik && pik.slots) {
            for (const si in pik.slots) {
                const sc = pik.slots[si];
                if (sc && sc.imageIndex != null && sc.imageIndex >= pos) sc.imageIndex++;
            }
        }
        this.batchSel = this.batchSel.map(x => (x >= pos ? x + 1 : x));
        this.selectedIdx = this.selectedIdx.map(x => (x >= pos ? x + 1 : x));
        this.buildThumbnails();
        const pk = this.tplPuzzle();
        if (pk) {
            this.ensurePuzzleSlotsCount(pk);
            this.saveCurrentTemplate();
            this.refreshPuzzleUI();
            this.scheduleRender(true);
            this.setStatus('已插入「' + res.name + '」，保留现有拼图编辑结果');
        } else {
            this.selectImage(pos);
        }
    },

    // 从胶片条移除某张照片:槽位 imageIndex 引用平移,不再自动重拼,
    // 只重算布局几何并保留剩余格子图片与编辑状态(需要复原请点「重拼」)
    // 单张删除即"只删一张"的批量删除,统一走 removeImages(逻辑只有一份)
    removeImage(i) {
        this.removeImages([i]);
    },

    // 批量移除照片(Ctrl+A 全选后右键删除 / 单张删除共用)。
    // 与旧 removeImage 的差别:
    //  - 一次处理一批索引,必须降序 splice,否则前面的删除会让后面的索引漂移;
    //  - 允许删到 0 张:删光是合法状态(启动时本来就没有照片),回到空状态而不是报
    //    「至少保留一张照片」——那正是"全选删除没反应"的第二个原因。
    removeImages(indices) {
        if (!this.images || !this.images.length) return;
        // 去重 + 只保留合法索引
        const list = Array.from(new Set((indices || []).filter(i => Number.isInteger(i) && i >= 0 && i < this.images.length)))
            .sort((a, b) => a - b);
        if (!list.length) return;
        const kill = new Set(list);
        const removed = list.map(i => this.images[i]);
        // 拼图槽位引用平移:指向被删图的槽位清空,位于其后的整体左移(按批一次算完)
        const pk = this.template && this.template.puzzle;
        if (pk && pk.slots) {
            for (const k in pk.slots) {
                const sc = pk.slots[k];
                if (!sc || sc.imageIndex == null) continue;
                if (kill.has(sc.imageIndex)) { sc.imageIndex = undefined; sc.imagePath = undefined; }
                else sc.imageIndex -= list.filter(j => j < sc.imageIndex).length;
            }
        }
        // 记住当前主图对象:删完索引会变,不能靠索引判断它是否被删
        const cur = this.image;
        for (let k = list.length - 1; k >= 0; k--) this.images.splice(list[k], 1);
        // 顺带清掉被删照片的每图模板(单一存取口),别让 Map 一直持有整张图的模板快照
        removed.forEach(im => this.clearTpl(im));
        if (typeof this.scheduleDraft === 'function') this.scheduleDraft();
        this.batchSel = [];
        this.selectedIdx = [];
        this.buildThumbnails();
        // ══ 全部删完:回到空状态(与启动时无照片一致)══
        if (!this.images.length) {
            this.image = null;
            this.template = null;
            this.selectedEls = [];
            this.currentIdx = 0;
            this.updateEmptyState();
            if (this.dom.stRes) this.dom.stRes.textContent = '';
            if (this.dom.stInfo) this.dom.stInfo.textContent = '';
            this.updateHistoryButtons();
            // 若草稿里还有上次会话,顺手把「继续上次会话」按钮亮出来 —— 删光后这是唯一的找回入口
            if (typeof this.checkDraftRestore === 'function') this.checkDraftRestore();
            this.setStatus('已删除全部 ' + removed.length + ' 张照片');
            return;
        }
        const curIdx = cur ? this.images.indexOf(cur) : -1;
        if (curIdx < 0) {
            // 当前主图被删掉了 → 就近选一张(selectImage 会重建模板/缩略图)
            this.selectImage(Math.min(this.currentIdx, this.images.length - 1));
        } else {
            this.currentIdx = curIdx;
            this.refreshUI();
            this.scheduleRender(true);
        }
        if (this.tplPuzzle()) {
            const pk2 = this.tplPuzzle();
            this.ensurePuzzleSlotsCount(pk2);
            this.saveCurrentTemplate();
            this.refreshPuzzleUI();
            this.scheduleRender(true);
            this.setStatus(removed.length > 1 ? '已删除 ' + removed.length + ' 张照片,保留剩余格子编辑结果' : '已移除「' + removed[0].name + '」,保留剩余格子编辑结果');
            return;
        }
        this.setStatus(removed.length > 1 ? '已删除 ' + removed.length + ' 张照片' : '已移除「' + removed[0].name + '」');
    },

    // 批量删除前确认(单张删除沿用旧行为,不弹窗)
    confirmRemoveImages(idxs) {
        const list = (idxs || []).filter(i => Number.isInteger(i) && i >= 0 && i < this.images.length);
        if (!list.length) return;
        if (list.length > 1 && !window.confirm('确定删除选中的 ' + list.length + ' 张照片吗?')) return;
        this.removeImages(list);
    },

    // 打开图片加入胶片条并设为当前图
    async openImage() {
        const res = await window.qingframe.openImage();
        if (!res) return;
        const idx = await this.appendImageFromPick(res);
        if (idx < 0) { this.setStatus('图片加载失败'); return; }
        this.buildThumbnails();
        this.selectImage(idx);
    },

    // 多选导入:第一张成为当前主图,其余按所选顺序追加进胶片条
    async openImages() {
        const res = await window.qingframe.openImages();
        if (!res || !res.length) return;
        this.showImportProgress(res.length);
        let loaded = 0;
        try {
            for (let i = 0; i < res.length; i++) {
                const idx = await this.appendImageFromPick(res[i]);
                if (idx >= 0) loaded++;
                this.setImportProgress(i + 1, res.length, res[i].name);
            }
        } finally {
            this.finishImportProgress();
        }
        if (!loaded) { this.setStatus('图片加载失败'); return; }
        if (typeof this.scheduleDraft === 'function') this.scheduleDraft();
        const pk = this.tplPuzzle && this.tplPuzzle();
        if (pk && this.image) {
            // 拼图进行中导入:同 addImageFiles,保留当前主图与拼图模板,不打回单图
            this.buildThumbnails();
            this.saveCurrentTemplate();
            this.scheduleRender(true);
            this.setStatus(`已导入 ${loaded} 张图片，拼图保持在「${this.image.name || '当前照片'}」上（可点「重拼」把新图填进格子）`);
            return;
        }
        this.selectImage(this.images.length - loaded);
        this.setStatus('已导入 ' + loaded + ' 张图片');
    },

    // 双击格子:系统文件选择框替换该格照片(自动加入胶片条并合成刷新)
    async openSlotImage(slotIdx) {
        const res = await window.qingframe.openImage();
        if (!res) return;
        const idx = await this.appendImageFromPick(res);
        if (idx < 0) { this.setStatus('图片加载失败，未替换'); return; }
        const pk = this.tplPuzzle();
        if (!pk) { this.buildThumbnails(); this.selectImage(idx); return; }
        this.onSettingCommit();
        this.ensurePuzzleSlotsCount(pk);
        const sc = pk.slots[slotIdx] || (pk.slots[slotIdx] = {});
        sc.imageIndex = idx;
        sc.imagePath = undefined;
        this.saveCurrentTemplate();
        this.buildThumbnails();
        this.refreshPuzzleUI();
        this.scheduleRender(true);
        this.setStatus(`槽位 ${slotIdx + 1} 已替换为「${res.name}」`);
    },

    // 指定槽位当前照片的文件名
    slotImageName(i) {
        const pk = this.template && this.template.puzzle;
        if (!pk || !pk.slots || !pk.slots[i]) return null;
        const sc = pk.slots[i];
        let idx = sc.imageIndex;
        if (idx == null && sc.imagePath != null) idx = this.images.findIndex(x => x.name === sc.imagePath);
        return (idx != null && idx >= 0 && this.images[idx]) ? this.images[idx].name : null;
    },

    /* ── 缩略图:异步原图占位 + 后台队列渲染"带边框成品预览" ── */
    // 入队生成该图的装框缩略图(先保持原图占位,不卡界面);已有缩略图时防抖 350ms 避免连续编辑反复重渲染
    queueThumb(im) {
        if (!im) return;
        if (im.thumb != null && Date.now() - (im._tqAt || 0) < 350) return;
        im._tqAt = Date.now();
        if (!this._thumbQueue) this._thumbQueue = [];
        if (this._thumbQueue.indexOf(im) >= 0) return;
        this._thumbQueue.push(im);
        this.startThumbTick();
    },

    startThumbTick() {
        if (this._thumbBusy) return;
        this._thumbBusy = true;
        setTimeout(() => {
            const im = (this._thumbQueue || []).shift();
            this._thumbBusy = false;
            if (!im) return;
            this.renderFramedThumb(im);
            if ((this._thumbQueue || []).length) setTimeout(() => this.startThumbTick(), 16);
        }, 16);
    },

    // 用该图自己的模板(没有则用当前模板快照)在 200px 离屏画布渲染装框成品,替换占位
    // 注意:无独立模板的图只显示边框效果,不继承当前图的 logo/贴纸/自由文字——
    // 这些元素是各图独立记忆的(见 app-sync.js 的同步语义注释),缩略图与主画布口径保持一致。
    renderFramedThumb(im) {
        if (!window.__render || !im) return;
        const prevCanvas = this.dom.canvas;
        const prevMax = this.displayMax;
        const prevImg = this.image;
        const prevTpl = this.template;
        const cv = document.createElement('canvas');
        cv.width = 1; cv.height = 1;
        cv.style.position = 'absolute'; cv.style.visibility = 'hidden';
        try {
            this.dom.canvas = cv;
            this.displayMax = 200;
            this.image = im;
            const saved = this.getTpl(im);
            this.template = saved ? JSON.parse(JSON.stringify(saved)) : (prevTpl ? JSON.parse(JSON.stringify(prevTpl)) : null);
            if (!this.template) return;
            // 无独立模板的图:剔除水印元素,避免当前图的 logo/贴纸/文字串到其它图缩略图上
            if (!saved) {
                delete this.template.logoElements;
                if (this.template.decorConfig) {
                    delete this.template.decorConfig.stickers;
                    delete this.template.decorConfig.textLines;
                }
            }
            window.__render(this, false);
            im.thumb = cv.toDataURL('image/jpeg', 0.8);
            // 直接按图对象取缩略图节点:原来每次都 querySelectorAll('img.thumb') 扫全条再逐个比对
            // dataset.idx,导入 50 张时是 O(n²)(2500 次节点访问 + 属性读)。
            // 映射缺失时(例如缩略图条还没建)回退到原来的扫描,行为不变。
            const hit = this._thumbEls && this._thumbEls.get(im);
            if (hit && hit.isConnected) {
                if (hit.src !== im.thumb) hit.src = im.thumb;
            } else {
                const strip = this.dom.thumbStrip ? this.dom.thumbStrip.querySelectorAll('img.thumb') : [];
                strip.forEach(t => {
                    const ti = t.dataset.idx != null ? parseInt(t.dataset.idx, 10) : -1;
                    if (ti >= 0 && this.images[ti] === im && t.src !== im.thumb) t.src = im.thumb;
                });
            }
        } catch (_) { /* 装框缩略图失败:保留原图占位 */ }
        finally {
            this.image = prevImg;
            this.template = prevTpl;
            if (this.dom.canvas === cv) this.dom.canvas = prevCanvas;
            if (prevMax === undefined) delete this.displayMax;
            else this.displayMax = prevMax;
        }
    },

    buildThumbnails() {
        const strip = this.dom.thumbStrip;
        strip.innerHTML = '';
        // 图对象 → 缩略图节点 的映射,供 renderFramedThumb 直接定位(见那里的注释)
        const elMap = new Map();
        this.images.forEach((im, i) => {
            const wrap = document.createElement('div');
            wrap.className = 'thumb-item';
            wrap.draggable = false;
            const t = document.createElement('img');
            const isSel = this.batchSel.includes(i);
            // 同步源 = 当前编辑中的照片(app-sync.js 同步语义):批量为多张时在源图上标注「源」
            const isSrc = this.batchSel.length > 1 && this.image === im;
            const cls = ['thumb'];
            if (isSel) cls.push('active');
            if (isSrc) cls.push('src');
            if (this.image && this.images.indexOf(this.image) === i) cls.push('main');
            t.className = cls.join(' ');
            t.draggable = false;
            // 同值不重赋:赋 src 会让浏览器重新解码同一张图
            const wantSrc = im.thumb || im.el.src;
            if (t.src !== wantSrc) t.src = wantSrc;
            t.dataset.idx = i;
            elMap.set(im, t);
            t.title = im.name;
            t.addEventListener('click', e => {
                // 单击 = 选中并切换为当前主图(恢复该图自己的边框模板);Ctrl/Shift+单击 = 追加/取消多选
                if (e.shiftKey || e.ctrlKey) { e.stopPropagation(); this.toggleSelect(i); return; }
                this.selectImage(i);
            });
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'thumb-check';
            cb.title = '勾选用于批量放图';
            cb.checked = isSel;
            cb.addEventListener('click', e => { e.stopPropagation(); this.toggleBatch(i, cb); });
            // 桌面右键菜单:同步边框 / 删除
            // 右键落在"已勾选"的缩略图上且勾了多张(Ctrl+A 全选)→ 对这一整批操作,
            // 否则只对右键的这一张操作(与旧行为一致)。
            const ctxI = i;
            wrap.addEventListener('contextmenu', e => {
                e.preventDefault();
                e.stopPropagation();
                const many = this.batchSel.length > 1 && this.batchSel.includes(ctxI);
                const targets = many ? this.batchSel.slice() : [ctxI];
                // 同步源 = 当前编辑图,不计入目标数(与 app-sync.js 的目标集口径一致)
                const syncN = many ? targets.filter(k => k !== this.currentIdx).length : 1;
                this.openCtx(e.clientX, e.clientY, [
                    [many ? `同步边框（${syncN} 张）` : '同步边框',
                        () => many ? this.applyBorderToSelected() : this.syncBorderTo(ctxI)],
                    [many ? `删除选中 ${targets.length} 张` : '删除',
                        () => many ? this.confirmRemoveImages(targets) : this.removeImage(ctxI)],
                ]);
            });
            wrap.appendChild(t);
            wrap.appendChild(cb);
            if (isSrc) {
                const tag = document.createElement('span');
                tag.className = 'thumb-src';
                tag.textContent = '源';
                tag.title = '同步源：当前编辑中的照片（同步时以它的边框为准）';
                wrap.appendChild(tag);
            }
            strip.appendChild(wrap);
        });
        this._thumbEls = elMap;
        strip.style.display = this.images.length > 1 ? 'flex' : 'none';
    },

    // 勾选切换(checkbox;与 Ctrl/Shift 多选同一份 batchSel,按勾选顺序排队)
    toggleBatch(i, cb) {
        const k = this.batchSel.indexOf(i);
        if (k >= 0) this.batchSel.splice(k, 1);
        else this.batchSel.push(i);
        if (cb) cb.checked = this.batchSel.includes(i);
        this.selectedIdx = this.batchSel.slice();
        this.buildThumbnails();
        this.setStatus(this.batchSel.length ? `已勾选 ${this.batchSel.length} 张照片，点布局按勾选顺序放入` : '已取消批量勾选');
    },

    toggleSelect(i) {
        const k = this.batchSel.indexOf(i);
        if (k >= 0) this.batchSel.splice(k, 1);
        else this.batchSel.push(i);
        this.selectedIdx = this.batchSel.slice();
        this.buildThumbnails();
        this.setStatus(this.batchSel.length ? `已框选 ${this.batchSel.length} 张照片，点布局按勾选顺序放入` : '已取消框选');
    },

    /* ══ 字体下拉填充(装饰文字/拼图字幕共用 curatedFonts) ══ */
    populateFonts() {
        ['cbCapFont1', 'cbCapFont2'].forEach(id => {
            const sel = this.$(id);
            if (!sel) return;
            sel.innerHTML = '';
            this.curatedFonts.forEach((f, i) => {
                const o = document.createElement('option');
                o.value = f;
                o.textContent = f;
                if (i === 0) o.selected = true;
                sel.appendChild(o);
            });
        });
    },

    /* ══ 静态控件绑定 ══ */
    setupPanelInteractions() {
        const $ = this.$;

        // 通用:range 拖拽时即时同步,change/pointerup 提交;select/checkbox 变更即提交
        this.bindRanges([
            'slGlobalMargin', 'slImgScale', 'slCornerTL', 'slCornerTR', 'slCornerBL', 'slCornerBR', 'slCornerRadius',
            'slParamFontSize', 'slBrandSize', 'slParamScale', 'slFillOpacity', 'slGradientAngle', 'slTextureScale', 'slStrokeWidth', 'slStrokeOpacity',
            'slShadowX', 'slShadowY', 'slShadowBlur', 'slShadowSpread', 'slShadowOpacity', 'slGlowBlur', 'slGlowOpacity',
            'slTearStrength', 'slTearDensity', 'slVignetteStrength', 'slVignetteFeather', 'slLeakOpacity', 'slLeakAngle', 'slFilmGrain',
            'slCornerDecorSize', 'slActiveIconOpacity', 'slElementRotation', 'slPuzzleGap', 'slPuzzleCorner',
            'slCapSize1', 'slCapSize2', 'slCapSpacing', 'slSlotOffsetX', 'slSlotOffsetY', 'slSlotZoom',
            'slLayerCornerTL', 'slLayerCornerTR', 'slLayerCornerBL', 'slLayerCornerBR', 'slLayerCornerRadius',
        ]);
        const onEdit = ['slGlobalMargin', 'slImgScale', 'slCornerTL', 'slCornerTR', 'slCornerBL', 'slCornerBR', 'slCornerRadius', 'slParamFontSize', 'slBrandSize', 'slParamScale',
            'slLayerCornerTL', 'slLayerCornerTR', 'slLayerCornerBL', 'slLayerCornerBR', 'slLayerCornerRadius'];
        (onEdit).forEach(id => {
            const el = $(id);
            if (el) el.addEventListener('input', () => this.onSliderCustom(id, parseInt(el.value, 10)));
        });

        // 参数字号:双击滑块回到默认档位(= 刚加完边框那一刻软件给的字号)。
        // 默认档在滑块中段(33/160),想回去得一路拖,太精细;双击给一条直达路径。
        // 走的是与拖动完全相同的 onSliderCustom 通路,标签刷新、重绘、撤销栈都不会分叉。
        // 只给这一个滑块加:其余 range 滑块(统一边距/图片缩放/参数缩放/品牌大小/背景模糊程度)
        // 全是 min>=10 的百分比区间,引擎侧没有"默认"档位,没有可回退的目标。
        //
        // 注意:目标不是档位 0。0 是 autoPf = clamp(round(min(iw,ih)/45), 20, 64)
        // (engine-styles.js buildState),与默认档是两条不同公式:小图上 0 档偏小约 1.7 倍,
        // 大图上因撞 64 档上限反而偏大 1.9 倍。所以双击回的是 defaultTemplate() 的那个值。
        const slPF = $('slParamFontSize');
        if (slPF) {
            slPF.title = '双击回到默认字号';
            slPF.addEventListener('dblclick', () => {
                const def = Number(this.defaultTemplate().paramFontSize) || 33;
                if (parseInt(slPF.value, 10) === def) return;  // 已在默认档,不做无谓重绘
                slPF.value = String(def);
                this.onSliderCustom('slParamFontSize', def);
            });
        }

        // 复选框 -> onSettingCommit
        const chks = ['cbCornerLock', 'cbShadow', 'cbGlow', 'cbTearEnable',
            'cbVignette', 'cbLightLeak', 'cbCornerDecor', 'cbCapBgBar', 'cbLayerCornerLock', 'cbExifText'];
        chks.forEach(id => {
            const el = $(id);
            if (el) el.addEventListener('change', () => this.onSettingCommit());
        });
        // 光照页签复制的阴影/发光已移除,统一收敛到「边框」页签

        // select 变更 -> commit
        const sels = ['cbCanvasRatio', 'cbParamPosition', 'cbParamType', 'cbFillType', 'cbGradientType', 'cbTextureBlend',
            'cbStrokePos', 'cbLeakType', 'cbCornerDecorType', 'cbPuzzleBg', 'cbPuzzleCanvas',
            'cbSlotFill', 'cbCapFont1', 'cbCapFont2'];
        sels.forEach(id => {
            const el = $(id);
            if (el) el.addEventListener('change', () => this.onSelectCustom(id));
        });

        // 数字/文本输入:input 即时同步(防抖),change 提交
        const nums = ['tfImgOffsetX', 'tfImgOffsetY'];
        nums.forEach(id => {
            const el = $(id);
            if (!el) return;
            el.addEventListener('focus', () => this.beginGesture());
            el.addEventListener('blur', () => this.endGesture());
            el.addEventListener('input', () => this.onSettingChanged());
            el.addEventListener('change', () => this.onSettingCommit());
        });
        const texts = ['tfExifBrand', 'tfExifModel', 'tfExifFocal', 'tfExifAperture', 'tfExifIso', 'tfExifShutter',
            'tfStrokeDash', 'tfTemplateName', 'tfTemplateTag', 'tfCapLine1', 'tfCapLine2'];
        texts.forEach(id => {
            const el = $(id);
            if (!el) return;
            el.addEventListener('focus', () => this.beginGesture());
            el.addEventListener('blur', () => this.endGesture());
            el.addEventListener('input', () => this.onTextCustom(id));
            el.addEventListener('change', () => this.onSettingCommit());
        });

        // 颜色选择器:input 即时预览,change 关闭取色器后提交压栈(与滑块同一套通路)。
        // 拼图的两个色要先补一次 syncPuzzleFromUI:字幕颜色挂在"当前编辑槽位"的模型上
        // (captureCaptionToModel 只在滑块/提交通路里被调),少了这步就是"取色后画面不动,
        // 动一下别的控件才补上";cpPuzzleBorder 同样要从 pk 模型读回。
        // 不含 cpT2iColor —— 它只在「文字转图片」按钮按下时读一次,不属于画布状态。
        const colors = ['cpFillColor', 'cpStrokeColor', 'cpShadowColor', 'cpGlowColor', 'cpCapColor', 'cpPuzzleBorder'];
        colors.forEach(id => {
            const el = $(id);
            if (!el) return;
            const sync = () => { if (id === 'cpCapColor' || id === 'cpPuzzleBorder') this.syncPuzzleFromUI(); };
            el.addEventListener('input', () => { sync(); this.onSettingChanged(); });
            el.addEventListener('change', () => { sync(); this.onSettingCommit(); });
        });

        // 图层按钮
        const bindBtn = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', () => fn()); };
        bindBtn('btnBuiltinTexture', () => this.pickBuiltinTexture());
        bindBtn('btnSelectTexture', () => this.pickTexture());
        bindBtn('btnAddCustomIcon', () => this.addCustomIcon());
        bindBtn('btnTextToImage', () => this.textToImage());
        const t2iInp = $('tfTextToImage');
        if (t2iInp) t2iInp.addEventListener('input', () => {
            const show = String(t2iInp.value).trim().length > 0;
            ['rowT2iStyle', 'rowT2iColor', 'rowT2iEffect'].forEach(id => { const el = $(id); if (el) el.style.display = show ? '' : 'none'; });
        });
        bindBtn('btnCopySelectedElement', () => this.copyElement());
        bindBtn('btnPasteClipboardElement', () => this.pasteElement());
        bindBtn('btnDeleteActiveIcon', () => this.deleteElement());
        bindBtn('btnClearAllIcons', () => this.clearElements());
        bindBtn('btnZOrderTop', () => this.moveZOrder(2));
        bindBtn('btnZOrderBottom', () => this.moveZOrder(-2));
        bindBtn('btnZOrderUp', () => this.moveZOrder(1));
        bindBtn('btnZOrderDown', () => this.moveZOrder(-1));
        // 元素对齐 / 均分 / 统一尺寸(需多选;列表中 Ctrl/Shift 点击即可多选)
        bindBtn('btnAlignLeft', () => this.alignSelectedEls('left'));
        bindBtn('btnAlignHCenter', () => this.alignSelectedEls('hcenter'));
        bindBtn('btnAlignRight', () => this.alignSelectedEls('right'));
        bindBtn('btnAlignTop', () => this.alignSelectedEls('top'));
        bindBtn('btnAlignVCenter', () => this.alignSelectedEls('vcenter'));
        bindBtn('btnAlignBottom', () => this.alignSelectedEls('bottom'));
        bindBtn('btnDistributeH', () => this.alignSelectedEls('distH'));
        bindBtn('btnDistributeV', () => this.alignSelectedEls('distV'));
        bindBtn('btnSameSize', () => this.alignSelectedEls('sameSize'));
        bindBtn('btnSaveTemplate', () => this.saveTemplate());
        bindBtn('btnExportTemplate', () => this.exportTemplate());
        bindBtn('btnImportTemplate', () => this.importTemplate());
        bindBtn('btnExportConfig', () => this.exportConfig());
        bindBtn('btnImportConfig', () => this.importConfig());
        bindBtn('btnCamLibSave', () => this.saveCurrentCamLib());
        bindBtn('btnCamLibRename', () => this.renameCamLibEntry());
        bindBtn('btnCamLibDel', () => this.deleteCamLibEntry());
        const camSel = $('cbCamLib');
        if (camSel) camSel.addEventListener('change', () => { if (camSel.value) this.applyCamLibEntry(camSel.value); else this.refreshCamLibSelect(); });
        bindBtn('btnQuickFilm', () => this.applyQuickPreset('film'));
        bindBtn('btnQuickIdCard', () => this.applyQuickPreset('idcard'));
        bindBtn('btnAutoColorBorder', () => this.autoColorBorder());
        bindBtn('btnEditGapCaption', () => this.addEditGapCaption());
        bindBtn('btnDeleteGapCaption', () => this.deleteCaption());
bindBtn('btnResetAllSlots', () => this.resetAllSlots());
                bindBtn('btnPuzzleClearSlots', () => this.clearPuzzleSlots());
        bindBtn('btnPuzzleDisable', () => this.disablePuzzle());
        bindBtn('btnExportPuzzle', () => this.exportPuzzle());
        bindBtn('btnGridPreview', () => this.renderGridPreview());
        bindBtn('btnGridExport', () => this.exportGridCrop());
        bindBtn('btnGridPreviewExport', () => this.exportGridCrop());
        bindBtn('btnGridPreviewCancel', () => this.hideGridPreview());
        bindBtn('gridPreviewClose', () => this.hideGridPreview());
        bindBtn('btnGridZoomBack', () => {
            const zoom = document.getElementById('gridPreviewZoom');
            if (zoom) zoom.style.display = 'none';
            const hint = document.getElementById('gridPreviewHint');
            if (hint) hint.style.display = '';
            const box = document.getElementById('gridPreviewGrid');
            if (box) box.style.display = '';
        });
        // 切图设置记忆
        if (typeof this.loadGridPrefs === 'function') this.loadGridPrefs();
        ['selGridSize', 'selGridRender'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', () => { if (typeof this.saveGridPrefs === 'function') this.saveGridPrefs(); });
        });
        const padEl = document.getElementById('slGridPad');
        if (padEl) padEl.addEventListener('input', () => {
            const lbl = document.getElementById('lblGridPad');
            if (lbl) lbl.textContent = padEl.value;
            if (typeof this.saveGridPrefs === 'function') this.saveGridPrefs();
        });
        const subEl = document.getElementById('cbGridSubdir');
        if (subEl) subEl.addEventListener('change', () => { if (typeof this.saveGridPrefs === 'function') this.saveGridPrefs(); });
        // 预览单块放大
        const gbox = document.getElementById('gridPreviewGrid');
        if (gbox) gbox.addEventListener('click', (e) => {
            const cell = e.target.closest('.grid-preview-cell');
            if (!cell || !cell._cv) return;
            const img = document.getElementById('gridPreviewZoomImg');
            img.src = cell._cv.toDataURL('image/jpeg', 0.92);
            const cap = document.getElementById('gridPreviewZoomCap');
            if (cap) cap.textContent = '第 ' + cell._idx + ' 块 · ' + cell._cv.width + '×' + cell._cv.height + 'px';
            const zoom = document.getElementById('gridPreviewZoom');
            if (zoom) zoom.style.display = 'block';
            const hint = document.getElementById('gridPreviewHint');
            if (hint) hint.style.display = 'none';
            gbox.style.display = 'none';
        });
        bindBtn('btnCheckUpdate', () => this.checkUpdates());
        bindBtn('btnAbout', () => this.openAbout());
        bindBtn('aboutClose', () => this.closeAbout());
        bindBtn('btnAboutCheck', () => { this.closeAbout(); this.checkUpdates(); });
        bindBtn('btnAboutIntro', () => { this.closeAbout(); this.showIntroAgain(); });
        const aboutModal = $('aboutModal');
        if (aboutModal) aboutModal.addEventListener('click', (e) => { if (e.target === aboutModal) this.closeAbout(); });
        bindBtn('btnIntroDone', () => this.closeIntro());
        const introModal = $('introModal');
        if (introModal) introModal.addEventListener('click', (e) => { if (e.target === introModal) this.closeIntro(); });
        bindBtn('btnUpdateAction', () => this.updateAction());
        bindBtn('btnUpdateClose', () => this.hideUpdateBanner());
        this.initUpdater();
        this.initDiag();
        bindBtn('btnPuzzleAddImg', () => this.openImage());
        bindBtn('btnPuzzleRepuzzle', () => this.rePuzzleFill());

        // 元素管理
        if ($('slActiveIconOpacity')) $('slActiveIconOpacity').addEventListener('input', () => {
            const v = parseInt($('slActiveIconOpacity').value, 10);
            this.updateLabel('lblActiveIconOpacity', v + '%');
            if ($('inpElOpacity')) $('inpElOpacity').value = v;
            this.applyToSelectedEls(el => { el.opacity = v; });
            this.batchElOps();
        });
        if ($('slElementRotation')) $('slElementRotation').addEventListener('input', () => {
            const v = parseInt($('slElementRotation').value, 10);
            this.updateLabel('lblElementRotation', v + '°');
            if ($('inpElRotation')) $('inpElRotation').value = v;
            this.applyToSelectedEls(el => { el.rotation = v; });
            this.batchElOps();
        });
        if ($('slElementSize')) $('slElementSize').addEventListener('input', () => {
            // 平方映射:滑块 0~1000 → 尺寸 16~10000(L 为滑块长度,平方项在低端更精细)
            const pos = parseInt($('slElementSize').value, 10);
            const k = pos / 1000;
            const v = Math.round(16 + (10000 - 16) * k * k);
            this.updateLabel('lblElementSize', v);
            if ($('inpElSize')) $('inpElSize').value = v;
            this.applyToSelectedEls((el, kind) => {
                if (kind === 'logo') el.size = v;
                else if (kind === 'sticker') el.scale = clampNum(v / 60, 0.02, 3);
            });
            this.batchElOps();
        });
        // 精确数值输入(借鉴 Compositor):输入框 change → 复用滑块通路,不另起渲染分支
        const bindNum = (id, fn) => { const el = $(id); if (el) el.addEventListener('change', fn); };
        bindNum('inpElX', () => {
            const v = parseFloat($('inpElX').value);
            if (isNaN(v) || !this.selectedEls.length) { this.syncElInputs(); return; }
            this.setElementCenter(this.selectedEls[0], v, this._elCenterY(this.selectedEls[0]));
            this.syncElInputs(); this.batchElOps();
        });
        bindNum('inpElY', () => {
            const v = parseFloat($('inpElY').value);
            if (isNaN(v) || !this.selectedEls.length) { this.syncElInputs(); return; }
            this.setElementCenter(this.selectedEls[0], this._elCenterX(this.selectedEls[0]), v);
            this.syncElInputs(); this.batchElOps();
        });
        bindNum('inpElOpacity', () => {
            const v = parseFloat($('inpElOpacity').value);
            if (isNaN(v)) return;
            const sl = $('slActiveIconOpacity');
            if (sl) { sl.value = Math.max(0, Math.min(100, v)); sl.dispatchEvent(new Event('input')); }
        });
        bindNum('inpElSize', () => {
            const v = parseFloat($('inpElSize').value);
            if (isNaN(v)) return;
            const c = Math.max(16, Math.min(10000, v));
            const sl = $('slElementSize');
            if (sl) { sl.value = Math.round(1000 * Math.sqrt((c - 16) / (10000 - 16))); sl.dispatchEvent(new Event('input')); }
        });
        bindNum('inpElRotation', () => {
            const v = parseFloat($('inpElRotation').value);
            if (isNaN(v)) return;
            const r = ((v % 360) + 360) % 360;
            const sl = $('slElementRotation');
            if (sl) { sl.value = r; sl.dispatchEvent(new Event('input')); }
        });

        // 拼图布局
        this.buildPuzzleLayoutBtns();

        // 槽位下拉:切换前先把当前编辑的字幕写入旧槽位,再加载新槽位
        if ($('cbPuzzleGapPick')) $('cbPuzzleGapPick').addEventListener('change', () => this.onPuzzleSlotChange());

        // 每个页签滚轮加速 x4(防冒泡影响画布)
        this.dom.panels.forEach(p => {
            p.addEventListener('wheel', e => {
                if (e.target && e.target.classList && e.target.classList.contains('ctl-rng')) return;
                const d = e.deltaY;
                if (p.scrollHeight > p.clientHeight) { p.scrollTop += d * 3; e.preventDefault(); }
            }, { passive: false });
        });
    },

    onSliderCustom(id, v) {
        switch (id) {
            case 'slGlobalMargin': this.applyGlobalMargin(v / 100, false); this.onSettingChanged(); break;
            case 'slImgScale': this.updateLabel('lblImgScale', v + '%'); this.onSettingChanged(); break;
            case 'slCornerTL': case 'slCornerTR': case 'slCornerBL': case 'slCornerBR': {
                const cc = this.template.cornerConfig || {};
                const key = 'slCornerTL' === id ? 'cornerRadiusTL' : 'slCornerTR' === id ? 'cornerRadiusTR' : 'slCornerBL' === id ? 'cornerRadiusBL' : 'cornerRadiusBR';
                cc[key] = v;
                this.updateLabel('lbl' + id.slice(2), v);
                if ((this.template.cornerConfig.cornerLock || 0) === 1) {
                    cc.cornerRadiusTL = v; cc.cornerRadiusTR = v; cc.cornerRadiusBL = v; cc.cornerRadiusBR = v;
                    ['slCornerTL', 'slCornerTR', 'slCornerBL', 'slCornerBR'].forEach(c => { const el = this.$(c); if (el) el.value = v; });
                }
                cc.cornerRadiusAll = v;
                if (this.$('slCornerRadius')) this.$('slCornerRadius').value = v;
                this.updateLabel('lblCornerRadius', v);
                this.onSettingChanged();
                break;
            }
            case 'slCornerRadius': {
                const cc = this.template.cornerConfig || {};
                cc.cornerRadiusAll = v;
                cc.cornerRadiusTL = v; cc.cornerRadiusTR = v; cc.cornerRadiusBL = v; cc.cornerRadiusBR = v;
                ['slCornerTL', 'slCornerTR', 'slCornerBL', 'slCornerBR'].forEach(c => { const el = this.$(c); if (el) el.value = v; });
                this.updateLabel('lblCornerRadius', v);
                if (this.$('lblCornerTL')) this.$('lblCornerTL').textContent = v;
                if (this.$('lblCornerTR')) this.$('lblCornerTR').textContent = v;
                if (this.$('lblCornerBL')) this.$('lblCornerBL').textContent = v;
                if (this.$('lblCornerBR')) this.$('lblCornerBR').textContent = v;
                this.onSettingChanged();
                break;
            }
            case 'slParamFontSize': {
                this.template.paramFontSize = v;
                this.updateParamFontLabel();
                this.onSettingChanged();
                break;
            }
            case 'slBrandSize': {
                this.template.brandSize = v / 100;
                this.updateLabel('lblBrandSize', v + '%');
                this.onSettingChanged();
                break;
            }
            case 'slParamScale': {
                this.template.paramScale = v / 100;
                this.updateLabel('lblParamScale', v + '%');
                this.onSettingChanged();
                break;
            }
            case 'slLayerCornerTL': case 'slLayerCornerTR': case 'slLayerCornerBL': case 'slLayerCornerBR': {
                const layer = this.currentLayer ? this.currentLayer() : null;
                if (!layer) break;
                const lcc = layer.cornerConfig || (layer.cornerConfig = {});
                const key = 'slLayerCornerTL' === id ? 'cornerRadiusTL' : 'slLayerCornerTR' === id ? 'cornerRadiusTR' : 'slLayerCornerBL' === id ? 'cornerRadiusBL' : 'cornerRadiusBR';
                lcc[key] = v;
                const lbl = 'lbl' + id.slice(2);
                this.updateLabel(lbl, v);
                this.updateLabel('lblLayerCornerRadius', v);
                if ((lcc.cornerLock || 0) === 1) {
                    lcc.cornerRadiusTL = v; lcc.cornerRadiusTR = v; lcc.cornerRadiusBL = v; lcc.cornerRadiusBR = v;
                    ['slLayerCornerTL', 'slLayerCornerTR', 'slLayerCornerBL', 'slLayerCornerBR'].forEach(c => { const el = this.$(c); if (el) el.value = v; });
                }
                lcc.cornerRadiusAll = v;
                if (this.$('slLayerCornerRadius')) this.$('slLayerCornerRadius').value = v;
                this.updateLabel('lblLayerCornerRadius', v);
                this.onSettingChanged();
                break;
            }
            case 'slLayerCornerRadius': {
                const layer = this.currentLayer ? this.currentLayer() : null;
                if (!layer) break;
                const lcc = layer.cornerConfig || (layer.cornerConfig = {});
                lcc.cornerRadiusAll = v;
                lcc.cornerRadiusTL = v; lcc.cornerRadiusTR = v; lcc.cornerRadiusBL = v; lcc.cornerRadiusBR = v;
                ['slLayerCornerTL', 'slLayerCornerTR', 'slLayerCornerBL', 'slLayerCornerBR'].forEach(c => { const el = this.$(c); if (el) el.value = v; });
                this.updateLabel('lblLayerCornerRadius', v);
                this.updateLabel('lblLayerCornerTL', v); this.updateLabel('lblLayerCornerTR', v);
                this.updateLabel('lblLayerCornerBL', v); this.updateLabel('lblLayerCornerBR', v);
                this.updateLabel('lblLayerCornerRadius', v);
                this.onSettingChanged();
                break;
            }
            default: break;
        }
    },

    onSelectCustom() {
        this.onSettingCommit();
    },

    onTextCustom() {
        this.onSettingChanged();
    },

    bindRanges(ids) {
        const $ = this.$;
        ids.forEach(id => {
            const el = $(id);
            if (!el) return;
            let v = parseInt(el.value, 10);
            el.addEventListener('pointerdown', () => this.beginGesture());
            el.addEventListener('input', () => {
                v = parseInt(el.value, 10);
                this.sliderLiveLabel(id, v);
                this.onSliderLive(id, v);
            });
            el.addEventListener('pointerup', () => {
                this.endGesture();
                this.commitNoPush();
            });
        });
    },

    sliderLiveLabel(id, v) {
        const map = {
            slFillOpacity: ['lblFillOpacity', v + '%'], slGradientAngle: ['lblGradientAngle', v], slTextureScale: ['lblTextureScale', v + '%'],
            slStrokeWidth: ['lblStrokeWidth', v], slStrokeOpacity: ['lblStrokeOpacity', v + '%'],
            slShadowBlur: ['lblShadowBlur', v], slShadowSpread: ['lblShadowSpread', v], slShadowOpacity: ['lblShadowOpacity', v + '%'],
            slGlowBlur: ['lblGlowBlur', v], slGlowOpacity: ['lblGlowOpacity', v + '%'],
            slTearStrength: ['lblTearStrength', v], slTearDensity: ['lblTearDensity', v],
            slVignetteStrength: ['lblVignetteStrength', v + '%'], slVignetteFeather: ['lblVignetteFeather', v],
            slBrandSize: ['lblBrandSize', v + '%'], slParamScale: ['lblParamScale', v + '%'],
            slLeakOpacity: ['lblLeakOpacity', v + '%'], slLeakAngle: ['lblLeakAngle', v + '°'],
            slFilmGrain: ['lblFilmGrain', v + '%'],
            slCornerDecorSize: ['lblCornerDecorSize', v],
            slPuzzleGap: ['lblPuzzleGap', v], slPuzzleCorner: ['lblPuzzleCorner', v + '%'], slCapSize1: ['lblCapSize1', v], slCapSize2: ['lblCapSize2', v],
            slCapSpacing: ['lblCapSpacing', v + '%'], slSlotOffsetX: ['lblSlotOffsetX', v], slSlotOffsetY: ['lblSlotOffsetY', v],
            slSlotZoom: ['lblSlotZoom', v + '%'],
        };
        const entry = map[id];
        if (entry) this.updateLabel(entry[0], entry[1]);
    },

    onSliderLive(id) {
        if (['slGlobalMargin', 'slImgScale', 'slCornerTL', 'slCornerTR', 'slCornerBL', 'slCornerBR', 'slCornerRadius', 'slParamFontSize', 'slBrandSize', 'slParamScale',
            'slLayerCornerTL', 'slLayerCornerTR', 'slLayerCornerBL', 'slLayerCornerBR', 'slLayerCornerRadius'].includes(id)) return; // 由 onSliderCustom 处理
        if (id === 'slPuzzleGap' || id === 'slPuzzleCorner' || id === 'slCapSize1' || id === 'slCapSize2' || id === 'slCapSpacing' || id === 'slSlotOffsetX' || id === 'slSlotOffsetY' || id === 'slSlotZoom') {
            this.syncPuzzleFromUI(); this.onSettingChanged(); return;
        }
        this.onSettingChanged();
    },

    /* ══ 纹理 ══ */
    async pickBuiltinTexture() {
        const builtin = ['denim', 'frost', 'grain', 'kraft', 'leather', 'linen', 'metal', 'paper', 'watercolor', 'wood'];
        const opts = builtin.map(n => `${n} 内置`).join('\n');
        const choice = await this.promptText('选择内置纹理:\n' + opts + '\n(输入名称,留空取消)', 'denim');
        if (!choice) return;
        const name = choice.trim().split(' ')[0];
        this.setLayerTexture(name);
    },

    async pickTexture() {
        if (!this.textures.length) { this.setStatus('纹理库未加载'); return; }
        const opts = this.textures.map((t, i) => `${i + 1}. ${t.name}`).join('\n');
        const choice = await this.promptText('选择纹理(输入序号或名称,留空取消):\n' + opts, '1');
        if (!choice) return;
        const idx = parseInt(choice, 10) - 1;
        const t = this.textures[idx];
        if (!t) { this.setStatus('未找到该纹理'); return; }
        this.setLayerTexture(t.name);
    },

    setLayerTexture(name) {
        this.onSettingCommit();
        const layer = this.currentLayer();
        layer.fillConfig.fillType = 'texture';
        layer.fillConfig.textureSrc = name;
        if (this.$('cbFillType')) this.$('cbFillType').value = 'texture';
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus(`已应用纹理 ${name}`);
    },

    _brandRank(n) {
        const ranking = {"APPLE":100,"SAMSUNG":95,"XIAOMI":90,"VIVO":80,"OPPO":78,"HONOR":72,"HUAWEI":70,"GOOGLE":65,"ONEPLUS":62,"REALME":58,"MOTOROLA":55,"LENOVO":50,"ASUS":48,"NOTHING":45,"NUBIA":42,"REDMI":88,"REDMAGIC":38,"IQOO":52,"TECNO":38,"INFINIX":35,"ITEL":33,"DOOGEE":25,"ULEFONE":22,"BLACKSHARK":30,"VERTU":20,"NOKIA":48,"LG":45,"HTC":40,"MEIZU":35,"CANON":98,"SONY":92,"FUJIFILM":85,"NIKON":80,"PANASONIC":60,"RICOH":45,"OLYMPUS":42,"PENTAX":38,"SIGMA":40,"LEICA":55,"HASSELBLAD":48,"POLAROID":50,"GOPRO":52,"DJI":58,"INSTA360":50,"RED":35,"CONTAX":25,"ALPA":15,"LINHOF":12,"MAMIYA":18,"ROLLEI":20,"PHASEONE":25,"HORSEMAN":10,"TOYO":8,"VOIGTLÄNDER":15,"SEAGULL":20,"TAMRON":30,"AGFA":18,"KODAK":45,"LUMIX":40,"LOMO":30,"BLACKMAGIC":42,"ZEISS":50,"CASIO":25,"CAT":5,"SONYALPHA":52,"OSMO":56};
        // 变体名(如 Apple_Black / Meizu-White / SONY_White)去掉后缀后按品牌热度排名
        const base = (n||'').replace(/\.png$/i,'').replace(/_(WHITE|BLACK|COLOR)$/i,'').replace(/-(WHITE|BLACK)$/i,'').toUpperCase();
        return ranking[base] ?? 5;
    },
    /* ══ Logo 页签 ══ */
    renderLogoPools() {
        const $ = this.$;
        // 三个池子:内置标记(随包自绘,开箱即有)/ 品牌 Logo(用户导入)/ 自定义图标
        const pools = ['markIconBox', 'brandIconBox', 'customIconBox'];
        const cats = { markIconBox: [], brandIconBox: [], customIconBox: [] };
        cats.markIconBox = this.marks || [];
        this.logos.forEach(l => {
            // 自定义图标归到自定义图标池
            if (l.custom) { cats.customIconBox.push(l); return; }
            // 其余品牌logo归到品牌Logo池,按市场热度排序
            cats.brandIconBox.push(l);
        });
        cats.brandIconBox.sort((a,b) => this._brandRank(b.name) - this._brandRank(a.name));
        // 图标池内容没变、DOM 也还在 → 直接返回。
        // 本方法每次切到「Logo」页签都会被调(app-view.js:51),而重建要造上百个 div + img,
        // 给 img 赋 src 还会触发一次解码。三个池子的来源只在启动加载与导入/删除/重命名时才变,
        // 那几处都会改到签名(数量/名称/体积),所以这里跳过不会漏更新。
        const sigOf = (arr) => arr.length + '|' + arr.map(l => (l.name || '') + ':' + (l.dataUrl ? l.dataUrl.length : 0)).join('\u0000');
        const poolSig = sigOf(cats.markIconBox) + '#' + sigOf(this.logos);
        const markBox = $('markIconBox'), brandBox = $('brandIconBox'), customBox = $('customIconBox');
        const poolDomIntact = markBox && brandBox && customBox
            && markBox.children.length === cats.markIconBox.length
            && brandBox.children.length === cats.brandIconBox.length
            && customBox.children.length === cats.customIconBox.length;
        if (this._logoPoolSig === poolSig && poolDomIntact) return;
        this._logoPoolSig = poolSig;
        // 发行版不再内置品牌 Logo 包,新用户进这个页签会看到"整组被隐藏、只剩一个按钮"。
        // 空池时给出引导,说明可以自己导入、以及文件名按品牌命名可自动匹配。
        const hint = $('logoPoolHint');
        if (hint) hint.style.display = this.logos.length ? 'none' : '';
        pools.forEach((boxId) => {
            const box = $(boxId);
            if (!box) return;
            box.innerHTML = '';
            const list = cats[boxId];
            if (!list.length) {
                // 内置标记是随包分发的:它空了就说明打包漏了 / 主进程是旧的 / 目录读不到 ——
                // 不能像另外两个池子那样整组藏起来,否则界面看起来和"根本没有这个功能"一模一样,
                // 排查时完全看不出是哪一层的问题(这次就踩了)。给一格明确的"缺失"。
                if (boxId === 'markIconBox') {
                    const title = box.previousElementSibling;
                    if (title) title.style.display = '';
                    box.style.display = '';
                    const cell = document.createElement('div');
                    cell.className = 'icon-cell empty';
                    cell.textContent = '内置标记缺失';
                    cell.title = 'shared/marks 读不到。若刚改过 src/main 或 preload,请完全退出应用后重启。';
                    box.appendChild(cell);
                    // 把原因写到标题后面:截图/一眼就能看出是"preload 未提供"、"调用失败"
                    // 还是"主进程返回空" —— 这三种要修的地方完全不同。
                    const cntEl = this.$('markCnt');
                    if (cntEl) cntEl.textContent = this._marksDiag ? '(' + this._marksDiag + ')' : '';
                    return;
                }
                // 空池隐藏整个组
                const title = box.previousElementSibling;
                if (title) title.style.display = 'none';
                box.style.display = 'none';
                return;
            }
            // 有数据则显示
            const title = box.previousElementSibling;
            if (title) title.style.display = '';
            box.style.display = '';
            list.forEach(l => {
                const c = document.createElement('div');
                c.className = 'icon-cell';
                c.title = l.custom ? (l.name + '(点×删除)') : l.name;
                const img = document.createElement('img');
                img.src = l.dataUrl;
                c.appendChild(img);
                // 池子图标:拖拽放置。单击(未拖动)不添加,避免误触;拖到画布松手才放到该位置。
                c.addEventListener('mousedown', (ev) => {
                    if (ev.button !== 0) return;
                    ev.preventDefault();
                    const sx = ev.screenX, sy = ev.screenY;
                    let dragging = false;
                    const ghost = document.createElement('img');
                    ghost.src = l.dataUrl;
                    ghost.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;opacity:0.85;width:56px;height:56px;object-fit:contain;left:0;top:0;';
                    const onMove = (me) => {
                        if (!dragging && Math.abs(me.screenX - sx) + Math.abs(me.screenY - sy) > 5) {
                            dragging = true;
                            document.body.appendChild(ghost);
                        }
                        if (dragging) { ghost.style.left = (me.clientX - 28) + 'px'; ghost.style.top = (me.clientY - 28) + 'px'; }
                    };
                    const onUp = (ue) => {
                        window.removeEventListener('mousemove', onMove);
                        window.removeEventListener('mouseup', onUp);
                        if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
                        if (!dragging) return; // 单击不添加
                        const canvas = this.dom.canvas;
                        if (!canvas || !canvas.width) { this.setStatus('画布不可用,已取消放置'); return; }
                        const rect = canvas.getBoundingClientRect();
                        const inCanvas = ue.clientX >= rect.left && ue.clientX <= rect.right && ue.clientY >= rect.top && ue.clientY <= rect.bottom;
                        if (!inCanvas) { this.setStatus('已取消放置(拖到画布外)'); return; }
                        const pt = this.screenToCanvas(ue);
                        this.addLogoElement(l, pt.x, pt.y).catch(() => {});
                        this.setStatus('已放置「' + l.name + '」');
                    };
                    window.addEventListener('mousemove', onMove);
                    window.addEventListener('mouseup', onUp);
                });
                // 自定义图标右上角加×删除按钮
                // 自定义图标双击可重命名
                if (l.custom) {
                    c.addEventListener('dblclick', async (ev) => {
                        ev.stopPropagation();
                        const nn = await this.promptText('重命名自定义图标', l.name);
                        if (!nn || !nn.trim() || nn.trim() === l.name) return;
                        l.name = nn.trim();
                        try {
                            let saved = JSON.parse(localStorage.getItem('qfs_custom_icons') || '[]');
                            saved.forEach(s => { if (s.dataUrl === l.dataUrl) s.name = l.name; });
                            localStorage.setItem('qfs_custom_icons', JSON.stringify(saved));
                        } catch(e) {}
                        // 初始库条目同步改名,否则重启还原。写盘失败必须说出来 ——
                        // 界面上已经叫新名字了,不报的话重启就悄悄变回去。
                        let renameOk = true;
                        try {
                            if (window.qingframe && typeof window.qingframe.renameCustomIcon === 'function') {
                                const rr = await window.qingframe.renameCustomIcon(l.dataUrl, l.name) || {};
                                renameOk = rr.ok !== false;
                            }
                        } catch(e) { renameOk = false; }
                        this.renderLogoPools();
                        this.setStatus(renameOk ? '已重命名' : '已改名,但未能写盘(重启后会还原)');
                    });
                }
                if (l.custom) {
                    const del = document.createElement('span');
                    del.textContent = '×';
                    del.style.cssText = 'position:absolute;top:2px;right:4px;font-size:14px;line-height:1;color:#ea6668;cursor:pointer;font-weight:bold;';
                    del.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        if (confirm('删除自定义图标「' + l.name + '」?')) {
                            const r = await this.deleteCustomIcon(l);
                            // 写盘失败时不要把它从列表里抹掉 —— 那样等于骗用户,
                            // 重启后图标原样回来,看起来就是"删不掉"。
                            if (r && r.ok === false) {
                                this.setStatus('删除失败(未能写盘):' + (r.error || '未知原因'));
                                return;
                            }
                            this.logos = this.logos.filter(x => x !== l);
                            this.renderLogoPools();
                            this.setStatus('已删除');
                        }
                    });
                    c.style.position = 'relative';
                    c.appendChild(del);
                }
                box.appendChild(c);
            });
            const cnt = this.$({ markIconBox: 'markCnt', brandIconBox: 'brandCnt', customIconBox: 'customIconCnt' }[boxId]);
            if (cnt) cnt.textContent = `(${list.length})`;
        });
    },

    // 打开"关于"弹窗并填充版本信息
    async openAbout() {
        const api = window.qingframe;
        let info = {};
        try { if (api && api.getAppInfo) info = (await api.getAppInfo()) || {}; } catch (e) {}
        const el = this.$('aboutInfo');
        if (el) el.textContent = '版本 ' + (info.version || '?')
            + ' · Electron ' + (info.electron || '?')
            + ' · Chrome ' + (info.chrome || '?')
            + ' · ' + (info.platform || '') + ' ' + (info.arch || '')
            + (info.packaged ? '' : ' (开发模式)');
        const m = this.$('aboutModal');
        if (m) m.style.display = 'flex';
    },
    closeAbout() {
        const m = this.$('aboutModal');
        if (m) m.style.display = 'none';
    },

    // 新手引导:首次启动展示 3 步上手,点"开始使用"后记 localStorage,不再弹出
    showIntroIfNeeded() {
        try { if (localStorage.getItem('qfs_intro_done') === '1') return; } catch (e) {}
        const m = this.$('introModal');
        if (m) m.style.display = 'flex';
    },
    closeIntro() {
        const m = this.$('introModal');
        if (m) m.style.display = 'none';
        try { localStorage.setItem('qfs_intro_done', '1'); } catch (e) {}
    },
    // 从"关于"重新查看新手引导:先清标记再弹出,下次重启仍按首次逻辑判断
    showIntroAgain() {
        try { localStorage.removeItem('qfs_intro_done'); } catch (e) {}
        const m = this.$('introModal');
        if (m) m.style.display = 'flex';
    },

    // 空状态: 没有照片时右侧面板置灰并显示中央提示; 导入照片后恢复
    // 注意: "继续上次会话"按钮的显隐由 checkDraftRestore 负责,这里不碰它
    updateEmptyState() {
        const empty = !this.images || this.images.length === 0;
        const ins = this.dom.inspector;
        if (ins) ins.classList.toggle('no-image', empty);
        if (this.dom.placeholder) this.dom.placeholder.style.display = empty ? 'flex' : 'none';
        if (this.dom.canvas) this.dom.canvas.style.display = empty ? 'none' : 'block';
        // 样式条同时收起:无照片时它还写着上一张图的样式,空态下是假信息(有图后由 applyModeControls 重写)
        const ms = document.getElementById('modeStatus');
        if (ms && empty) ms.style.display = 'none';
    },

    /* ══ armLogoPlacement(logo) { … → app-elements.js ══ */

    /* ══ 缩放 / 状态栏 / 主题 / 用户资料 → app-view.js ══ */

};

/* 工具 */
function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function num(el, def) {
    if (!el) return def == null ? 0 : def;
    const v = parseFloat(el.value);
    return isNaN(v) ? (def == null ? 0 : def) : v;
}
function dashToArray(v) {
    if (!v) return [];
    const arr = String(v).split(',').map(x => parseFloat(x.trim())).filter(x => !isNaN(x) && x > 0);
    return arr;
}

document.addEventListener('DOMContentLoaded', () => App.init());