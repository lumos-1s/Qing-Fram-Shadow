# 清框影 · Frame Studio —— 架构与流程说明

> 审计方式：全量静态阅读（主/渲染进程 + 工具链 + 测试 + 预设 schema），并实跑纯 Node 工具。
> 未启动 GUI、未修改任何文件。行号引用以审计时工作区为准。

---

## 0. 项目定位与血统

- **Electron 45 + 原生 HTML/CSS/JS + Canvas 2D**，本地优先的照片加框工具，代码 MIT（`shared/brandlogos`、`shared/textures` 除外）。
- **它是 JavaFX 桌面版的 Web 重写**：`engine.js:1` 自述「JavaFX BorderEngine 逐行移植」，`index.html:153` 注释「对齐 Java FXML 命名」，函数名 `computeCanvasSize` / `getShadowSpace` / `parseColor` 都保留原版语义，`styleNoise/javaRandom` 是 Java LCG 的复刻（`engine-styles.js:853`）。桌面上还存在同名 Java 版与压测目录。

## 1. 进程与文件布局

| 层 | 文件 | 职责 |
|---|---|---|
| 主进程 | `src/main/index.js`(589) | 单实例锁、窗口、`qflocal://` 协议、~30 个 `ipcMain.handle`、自动更新 |
| | `src/main/state.js`(46) | `userData/state.json` 读写、`freeFilePath` 的 `_1/_2` 递增命名 |
| 桥 | `src/main/preload.js`(51) | `contextBridge` 暴露 `window.qingframe` 26 个方法，与 handle 一一对应 |
| 渲染 | `src/renderer/index.html`(919) | UI 骨架 + **按顺序 `<script>` 加载 17 个文件**（901-917） |
| | `js/engine.js`(1602) | 通用渲染：图层管线、卡片管线、拼图管线 |
| | `js/engine-styles.js`(4526) | IIFE，**76 个相框风格** + 分发表 |
| | `js/app*.js`(10 个) | 全部 `Object.assign` 混入同一个 `window.App` 单例 |
| 数据 | `shared/presets/`(80 个 JSON) | 内置模板 |
| | `shared/textures/`(10 PNG) | 纹理，仅图层管线消费 |
| | `shared/brandlogos/`(106 文件) | 本机素材，**不入库、不进包** |

**安全姿态**：`contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`、CSP 写死在 `index.html:5`（`script-src 'self'`，图片允许 `qflocal:`）。自动更新默认直连 GitHub，不自动改道任何第三方镜像（清单与二进制必须同源）。用户可在「关于 → 更新下载源」自行填镜像：**清单与 sha512 始终取自 GitHub**，只有安装包下载地址被替换（`src/main/update-mirror.js`），下完仍按 GitHub 的 sha512 校验，不匹配即丢弃并回退直连。

**照片不走 IPC**：主进程注册 `qflocal://`，渲染侧用 `qflocal://img?p=<绝对路径>` 直读磁盘，避免 base64 过桥；协议只服务**图片扩展名且被主进程登记过**的路径（文件选择/拖放/剪贴板/封面目录/`read-exif`），并开启 `corsEnabled`。只有**模板/工程文件**与**导出写盘**才走 IPC；导出写盘只认 `pick-export-location` 发出的令牌，渲染层不能直接指定路径。

## 2. 渲染架构（核心）

### 2.1 四条管线，一个分流点

`engine.js:94 _renderToCanvasInner` 按模板字段分流：

1. `photoFrameStyle` 非 `NONE` → `EngineStyles.renderPhotoFrame`（`engine-styles.js:2827`，76 风格）。
2. `photoFrameStyle==='NONE'` → 原图直出（唯一真正读 `app.exportScale`、能上采样的路径）。
3. `baseMargin.bgBlurEnable===1` → `renderCardStyle`（`engine.js:932`）。
4. 其余 → `renderTemplateStyle`（`engine.js:192`，通用图层模板）。
5. 拼图页签独立：`renderPuzzle`（`engine.js:1320`）。

预设到管线的分类由 `tools/validate-presets.js:78 classify()` 判定：80 个预设 = **47 风格 + 2 卡片 + 31 图层**。

### 2.2 坐标系（最容易被踩的地方）

`setupCanvas`（`engine.js:129`）：

- `scale = uiScale * dpr`；`uiScale` 平时是 `min(1, displayMax/长边)`，导出时若 `exportScale>0` 则等于 `exportScale/长边`。
- 后备缓冲按 `scale` 放大，同时把**逻辑尺寸**写进 `canvas._logW/_logH` —— 全工程所有元素几何都以「基准画布」口径计算，不是最终画布。
- 导出时 `app.uiDprOverride=1`（`app-export.js:80`）保证输出分辨率不被 DPR 污染。
- 拖动/手势期 `displayMax` 被降到 900（`app-state.js:55`）做即时低清渲染，松手恢复。

### 2.3 相框样式管线

`engine-styles.js:3754` 的 `const draw = {...}[styleName]` 是**唯一分发表（76 键）**，签名两类：

- `f(img,size,g,iw,ih[,S])` —— 老几何风格
- `f(img,size,g,iw,ih,S,cwO,chO)` —— 带留白/全出血风格，自行把内容块居中

流程：`buildState`(S：exif/cam/paramFs/globalMargin/sign*/avatar*/brand*) → `styleDims`(76 分支定画布) → 分发表取 draw → 全出血模糊风格按 `effectiveCanvasRatio` 扩画布（`BLUR_FULLBLEED` 名单 3811）→ 临时 canvas 上**劫持 `g.drawImage`** 给照片套 `cornerConfig` 圆角（3836-3856）→ `expandToRatio` 补比例（2788）→ 以 `finalScale = min(1, displayMax/长边)` 贴回可见 canvas（3875）→ `drawUserElements` 画 logo/贴纸/自由文字。异常时 `catch` 回退纯原图（3890）。

未注册的风格名落到占位分支，渲染中性底 + 风格名（`stylePlaceholder:2289`）。

### 2.4 图层模板管线

`computeCanvasSize:60`（图 + 四边 margin + 侧投影预留 `getShadowSpace:31`，再按比例只扩不裁）→ `setupCanvas` → 白底 → **倒序**遍历 `layerList`：`drawLayerShadowGlow:295` + `drawSingleLayer:275`（填充 `applyFill:333` = solid/gradient/texture，描边 `applyStroke:427` 支持 inside/center/outside 与 dash）→ `drawOriginImage:485`（imgScale/imgOffset，投影三态：均匀 / 立体双层 / 默认小阴影）→ `applyShapeMask:591` + `drawFilmPerforations:600`（撕纸、齿孔）→ `applyGlobalLight:698`（暗角 multiply、漏光 screen 暖/冷/品红、光束）→ `applyFilmGrain:673`（overlay，固定盐 `GRAIN_SALT=20240816`）→ `punchRoundedCorners:472` 镂空 → 装饰/文字/EXIF 条/Logo。

照片圆角刻意用「同分辨率临时画布 + `destination-out` evenodd 镂空 + 1:1 贴回」而非裁剪态 drawImage，规避 Chromium 摩尔纹（571-584）。

### 2.5 纹理与"程序化冒充"

- 真纹理只有图层管线用：`shared/textures/*.png` → `list-textures` → `app.textures` → `setTextureFill:403`（`createPattern('repeat')` + `DOMMatrix` 缩放偏移 + multiply/screen/overlay）。
- `engine-styles.js` 里的水彩/油画/蓝晒/报纸等**完全不读磁盘纹理**，靠 `javaRandom` 噪点、`fastBlurCanvas`/`gaussianFilter`、16 桶主色直方图（`extractDominant:64`）现场合成。
- 缓存：`TEXTURE_CACHE:363`、`GRAIN_TILE_CACHE:639`、风格侧 `_smallCache/_edgeCache/_bottomCache/_multiCache`（195-200），切图时 `clearStyleCaches:207`（由 `app-render.js:58` 调用）。

## 3. 状态与数据流

### 3.1 单例 + 混入切片

`window.App`（`app.js:4-45`）是唯一耦合面，由 10 个文件 `Object.assign` 拼装，无模块系统、无打包器，跨文件符号由 `<script>` 顺序与 ESLint 白名单兜底（`renderer` 的 `no-undef` 被关掉）。

关键字段：`images[]`、`image`（当前图，同时是 `imageTemplates` 的 Map 键）、`currentIdx`、`selectedIdx`、`template`（当前编辑模板）、`imageTemplates: Map<图, 深拷贝快照>`、`undoStack/redoStack`、`_renderDirty/_renderSkip/_renderRaf/_renderFlushResolvers`。

### 3.2 双向镜像

- `syncModelFromUI()`（`app.js:730`，UI→模型）与 `refreshUI()`（`app.js:894`，模型→UI，`isUpdating` 守卫）是两份**手工维护的巨型字段表**。
- 两条写入路径：
  - `onSettingChanged()`（`app-state.js:5`）= 高频（拖滑块）：同步 + 每图记忆 + 防抖渲染 + 800ms 落 localStorage，**不压撤销栈**。
  - `onSettingCommit()`（`app-state.js:44`）= 离散（勾选/切换/按钮）：`pushUndo` + 立即渲染。
- 手势：`beginGesture`（50，滑块 pointerdown / 输入框 focus）压一次快照并把 `displayMax` 降到 900；`endGesture`（61）恢复全分辨率重渲。撤销栈上限 50，快照是整模板深拷贝。

### 3.3 渲染调度（性能设计的核心）

`app-render.js:7 scheduleRender`：**单个 rAF 句柄 + 脏标记**，任意次调用合并为「下一帧渲一次」；手势期 `_renderSkip=2` 直接**跳帧**降频（而不是用 setTimeout 尾随防抖，注释里明确记录了旧实现 120ms 拖尾）。

`flushRender:41` 走同一队列并等真帧结束，供导出/读像素使用（避免与普通帧并行排两帧读到半成品）。

拖动元素时的优化（`:82-159`）：首帧把「不含被拖元素」的整帧缓存为背景位图，之后每帧只 blit 背景 + 重画被拖元素 + 选择框，把 52~143ms/帧 降为一次位图拷贝；缓存键 = 画布尺寸 / 模板引用 / 图源。

### 3.4 关键流程

**导入**：`open-images`（主进程顺带解析 EXIF）→ `addImageFiles:1214`（`Promise.allSettled` 并发）→ `loadFile`（ObjectURL + buffer）→ `applyOrientation:1291`（处理 8 种 orientation，重编码 JPEG 0.95）→ 缩略图队列 `queueThumb:1483`（350ms 去抖 + 16ms 串行 tick，`renderFramedThumb:1506` 用该图自己的模板渲 200px 成品缩略图）。

**每图独立模板**：`saveCurrentTemplate:1167` 是唯一写入点，把 `cloneTemplate()` 深拷贝同时塞进 `imageTemplates` Map 与 `im.customSettings`；切图时优先恢复该图快照，未设过的图用 `defaultTemplate()`。

**导出**（`app-export.js:4`）：① 先在画布外算文件名（`<原名>_边框|_拼图`，`dedupeExportNames:181` 同名加 `_1/_2`）→ ② `pick-export-location`（多文件选目录 / 单文件选文件并补扩展名）→ ③ 逐张：`uiDprOverride=1` + `flushRender` → 按 UI 尺寸渲一次取基准宽 → 置 `displayMax=目标长边`、`exportScale` → 再渲 → `k=afterW/beforeW`，非拼图时 `scaleElPix:54` 等比放大 logo.size / 锚点 offset / 贴纸 / 自由文字（**rel 比例位置不缩放**）→ 再渲 → `toDataURL`；JPEG 先白底合成 → 目录模式逐张写盘并立刻释放 base64（内存友好）。空模板陷阱有 `confirm` 兜底（28-33）。

**模板 / 工程**：模板落 `userData/templates/<名>.json`（名做非法字符替换）；`.qfs` 是 **v2 自包含单文件**（`app-qfs.js:17`：模板 + 每图 customSettings + 照片以 JPEG 0.92 base64 内嵌），导入时按 `data.images` 自动区分工程与旧裸模板。模板库缩略图用合成的 1000×1250 示例图、`displayMax=96` 现场渲染成 dataURL，**只用内存、每次刷新全量重算**。

**草稿**（`app-draft.js`）：1.5s 去抖 + 30s 定时 + `pagehide`/`visibilitychange` 写 localStorage；启动**只提示不自动恢复**（`btnRestoreDraft`）；`errguard.js` 捕获未处理异常时立即落盘。

**拼图**（`app-puzzle.js`）：12 种布局、`axisVals`、`slots{i:{imageIndex,zoom,offsetX,offsetY,rotate,fillMode}}`、格字幕与间隙字幕、轴线拖动与整格 swap；导出恒 **4000px PNG**，不读导出尺寸档。

**调色**（`app-grade.js` + `app-curve.js` + `app-mix.js`，第一行页签「调色」，与画布/文字/边框同族）：9 档滑块（曝/对/饱/色温/色调/高光/阴影/白色/黑色，±100，0 为不变）+ **曲线编辑器**（RGB/R/G/B 四条，单调三次插值 Fritsch–Carlson 防过冲）都挂在 `im.grade` 上、随草稿持久化，属**记录值**而非破坏性编辑。渲染链零改动：`photoSrcOf(im) = im._grade.canvas || im._grade.low || im.el`，只把取源换成烘焙画布。烘焙用原生 `ctx.filter`（`brightness/contrast/saturate/hue-rotate` + `url(#qfsGradeLut)` 的 `feComponentTransfer` 256 项 LUT，必须 `sRGB`），不逐像素、不上 WebGL —— 实测 2400×1600 一次全滤镜约 25ms，逐像素 JS 同尺寸 300ms+。曲线不单独走像素：在 `buildTables` 里串联在色温/高光/阴影的表输出之后（与 PS 复合顺序一致），开曲线不增加烘焙成本。数据只存控制点（`curve:{rgb:[…],r:[…]}`），应用到全部时**深拷贝**。两级缓存：拖动中 1600px 降采样、松手后原尺寸（`ensureFullGrade`），LRU 4 张；中性时不烘焙、不占内存；烘焙画布的 `naturalWidth/Height` 恒等于原图（自适应 EXIF 字号按它算，报像素尺寸会让文字随拖动跳变）。高光/阴影用钟形增益 `v²(1-v)`/`v(1-v)²`，两端锚死，纯黑纯白永不动；白色/黑色是端点操作（白点内移 `v/(1-w·0.25)`、黑点抬升 `v(1-b·0.22)+b·0.22` 或压死 `(v+b·0.22)/(1+b·0.22)`），分别按 `v²`/`(1-v)²` 加权只吃亮部/暗部，故意允许端点溢出（曲线也可以突破锚点）。

**蒙版**（`app-mask.js`）：`im.grade.masks[]`，每项 = 形状（归一化照片坐标）+ 羽化/浓度/反相 + 一套 9 档参数。烘焙顺序是「全局参数烘一层 → 逐个蒙版用它的参数在上一层结果上再烘一层 → 按蒙版 alpha 合成」（`destination-in` 遮罩 + 叠加），所以蒙版参数天然叠在全局之上，与 PS 调整图层的堆叠语义一致。蒙版权重必须落在 **alpha** 通道（早期用黑/白填充，alpha 恒为 1，整张图都被当成蒙版内）。画笔按描边 + 羽化模糊；亮度范围按亮度阈值在 320px 低分辨率上算再放大（软过渡，成本可控），**取样源恒为原图 `im.el`**：若拿已调色的图层当源，压暗后原本不达标的像素会落进亮度区间，选区自己长大，用户看到的就是「调完色再点回蒙版范围变了」（实测 alpha 203/17 → 127/43）。降采样那档按「前缀链」缓存：改第 N 个蒙版只重烘它一层，前面直接复用；全尺寸不缓存，避免几十 MB 常驻。编辑期拖形状只重画叠加层、松手才烘一次，保证 60fps 跟手；叠加层用引擎记在 `app._photoRect` 的照片矩形换算坐标，卡片/相框管线拿不到矩形时提示「无法在画布上编辑」。叠加层的**几何只有两个真相**：`app._photoRect`（基准坐标）与叠加层自身像素尺寸 —— `syncOverlayGeometry` 直接读 canvas 的 `getBoundingClientRect()` 写 left/top/width/height（不再复制 canvas 的 style.width/transform），绘制比例恒为 `ov.width / baseW`，缩放/平移/窗口变化都不会产生第二套口径。线性/椭圆用矢量渐变绘制、画笔/亮度走低分辨率光栅；叠层只表示**范围**，不乘浓度（否则调低浓度或压暗照片后，半透明绿在暗背景上看不见，用户会以为蒙版缩小了）。选中蒙版时 9 档滑块路由到该蒙版（`MASK_ROUTE_KEYS`），曲线/校准/混色器仍写全局。

**扩展档位**（对齐 LR）：**细节** = 清晰度/纹理用 `feGaussianBlur`+`feComposite(arithmetic)` 的 USM 串进同一条滤镜链（模糊半径按烘焙分辨率缩放：纹理 ~long/250、清晰度 ~long/40，拖动降采样时半径同步变小），负档反向柔化；去除薄雾为简化版 = LUT 黑场（正档压黑点/负档抬黑）+ `contrast()/saturate()` 复合。**校准** = `feColorMatrix` 3×3 通道混合矩阵：色相 = 原色轴在原色平面内旋转（±45°），饱和 = 轴向灰矢量(1/3,1/3,1/3)收放，各列改动量均摊配平保证 Σ列=(1,1,1)——灰与白边在任何校准组合下恒不偏色（线性 3×3 下纯原色全去饱和必然带邻色，这是数学极限）。**混色器**（`app-mix.js`，8 色相带 × 色相/饱和/明亮度）是唯一走 WebGL 的档位：按色相选区是三维操作，逐通道 LUT 与 SVG 掩膜（8 带×十几原语，烘焙慢一个量级）都不可行；实现为烘焙**前置级** `原图 → GL 单 pass(RGB↔HSV + smoothstep 带权重、跨带取加权平均) → ctx.filter 其余全部`，色相满档 ±40°；GL 不可用/上下文丢失时 `pass()` 返回 null 自动退回原图，混色器整组标记 `.mix-na` 降级，其余功能不受影响。`isNeutral/signature` 计入全部扩展档；`mix` 是两层嵌套结构，应用到全部时深拷贝。

页签归属：调色是**单张照片**的参数面板，与「画布/文字/边框/Logo/模板」同族，故挂在第一行；工具行只保留「拼图/切图」（多图合成与输出，会切走画布状态并走独立导出路径）。原「光影」页签的暗角/漏光/胶片颗粒作为「氛围」分区并入调色面板 —— 它们与调色同作用域（都写在当前照片的 `im.customSettings` 模板快照里）；但渲染语义不同：调色只改照片像素，氛围叠加在整张成片（含白边/边框）之上。相框样式（`photoFrameStyle`）管线不支持氛围三组，`.ctl-grp-light` 仍由 `engine.js` 的 `showLight` 统一隐藏。氛围三组是**常开滑块**（无独立开关，强度 0 即关）：`syncModelFromUI` 里由滑块值反推 `vignetteEnable/lightLeakEnable/filmGrainEnable`，而 `refreshUI` 回显时反过来以 enable 为准（`enable===1 ? 强度 : 0`）—— 预设有 81 个存着 `enable:0 + 强度:35` 的模板默认值，只看强度会让整库预设凭空长出暗角，故双向都以 enable 为准。

**剪贴快捷键**（`app-view.js:56`）：Ctrl+O/Z/Y/A/C/V/E/D/0、Ctrl+Shift+S、Delete/Backspace（先判拼图字幕再判元素）、方向键微移选中元素（Shift=10px；无选中时 ←/→ 切图），输入框聚焦时屏蔽。

## 4. 工程化与质量门

- `npm run check` = ESLint（只覆盖 `src`）+ `validate-presets`（80 预设结构 + 风格白名单）+ `check:caps` + `check:marks`（28 SVG 严格比对）+ `test:mainio` + `test:icons` + `test:engine`。**实跑通过（exit 0）**。
- **`style-caps.js` 能力表**是「面板显隐 ↔ 引擎是否真读该参数」的唯一事实来源：`DIMS`（5 个数值维度：pf/cr/gm/isc/bi）用两个极值探针渲染，判据是**单格最大差 ≥2 且变化格数 ≥2**（`gen-style-caps.js:28-58`，注释记录了"全图均差"曾误判 9 个风格的返工）。生成区由基线实测得出（76 键），`npm run gen:caps` 重写、`--check` 过期退出 1。
- `npm test` = check + 24 个 Electron 用例（经 `run-electron.js` 统一补 GPU 开关，含 panel、panel:audit、visual），`&&` 串联，单点失败即断。**2026-10-08 起整链 33 阶段实跑 EXIT=0（历史首次）**。
- **视觉回归**：`tests/visual/baseline.json` 20.7 MB / **924 键**（76 `__base` + 76×10 参数极值 + 4×22 品牌组合），每键存 32 格分块平均指纹 `{fp:{CW,CH,data}}` 与布局锚点 `m`；容差 `FP_TOL=2.0` / `POS_TOL=2px`。
- 测试三套模板：**A 纯 harness**（`design/regress.html` 只加载引擎，注入 `mulberry32` 固定随机，`__QR.run` 批量渲）；**B/C 真实 app**（注册 `qflocal` 协议 + 打桩 ~25 个 IPC + 注入 preload + 轮询等 `window.App` 就绪）。
- `npm run release` = `app:dir` → `verify-dist`（未压缩目录 asar）→ 打安装包 → `verify-dist --installers`（即 `verify:pkg`：Setup.exe 体积 + sha512 对照 `latest.yml`）；`verify-dist` 退 **0 干净 / 1 泄漏 / 2 无法判定**，并检查产物新鲜度。

> 环境提示：本会话 `ELECTRON_RUN_AS_NODE=1` 被置位，`require('electron')` 退化为路径字符串，任何 Electron 测试脚本第一行就崩（不是测试失败）。要跑 GUI 用例需先 `$env:ELECTRON_RUN_AS_NODE=$null`。

## 5. 发现的问题（按严重度）

1. **【已解决】9 个 Electron 用例恒绿**：`app.quit()`/`process.exit()` 之后再设 `process.exitCode` 会被忽略，断言失败也返回 0。已全部改为 `finish()` → `app.exit()`（OPTIMIZATIONS #17），24 个 GUI 用例退出码可信；`npm test` 整链 33 阶段实跑 EXIT=0。
2. **【已解决】release 链是破的**：旧 `dist/` 陈旧且含 106 个 brandlogos、`verify-dist` 实跑 exit 1，预设数还硬编码成 70（会把数量异常推到 exit 2「无法判定」）。现已清空重建（0.1.7 安装包 75.0 MB）、预设/纹理数改为从 `shared/` 实测（OPTIMIZATIONS #18），并新增 `verify:pkg`（`--installers`）对安装包做体积 + sha512 ↔ `latest.yml` 核验，正/负向均验证通过。
3. **【已解决】相框样式路径不读 `exportScale`**：原先 `finalScale=min(1, displayMax/长边)` 封顶，只有 NONE 原图路径能上采样 → 「相框样式 + 4096/8192」拿不到目标尺寸。现在 `engine-styles.js` 在 `app.exportScale` 存在时按目标长边缩放（预览仍只缩不放），`test:fidelity` 已实测 2048 目标下相框输出 2048×1769。
4. **【中】离屏渲染共享单例、不可重入**：缩略图队列、模板库缩略图、导出三条路径都靠「临时改写 `dom.canvas/image/template`」再 `finally` 还原；`queueThumb` 与 `_renderTplThumbs` 并发会互相踩踏（导出因此必须深拷贝模板 + 逐张 flush）。
5. **【中】依赖与可移植性**：`@electron/asar` 未列入 `package.json`（靠 electron-builder 传递依赖）；`measure-drag.js`/`stress.js` 默认目录写死作者机器绝对路径，CI 不可用。
6. **【中】8192 导出内存**：`out` + 可见 canvas + `toDataURL` 三份大缓冲并存（8192² RGBA ≈ 268 MB/张），`getImageData` 调用点还会打断 GPU 加速。九宫格批量已改为「逐张渲染 → 立即写盘」，不再把整批 base64 攒在内存；单张 8192 仍是峰值。
7. **【低】一致性债务**：`syncModelFromUI`/`refreshUI` 两份手工镜像无漏字段保护；`applyGlobalMargin:860` 每次同步从 `refTop` 重算四边、会冲掉单边 margin；undo 栈与 `imageTemplates` 两套历史不联动。草稿里的大 `data:` 图片已外置到 `userData/draft-assets`（草稿只存 `qfasset:` 引用）；头像/自定义图标仍在 localStorage，超配额仍可能静默丢弃。`tools/`、`tests/` 不受 lint 保护。
8. **【低】仓库不干净**：`dist/`（.gitignore 已忽略但仍在盘上）与根目录若干本地日志（`s_err.log`/`debug.log`/`dist-build.log`/`start.log`，均已忽略）混放；原先混入的 `custom-icons.json` 与 `.docx` 已不存在。

## 6. 关键文件速查

| 想改什么 | 去哪里 |
|---|---|
| 新增/改相框风格 | `engine-styles.js` 分发表（3754）+ 风格函数 + `styleDims` 分支 + `style-caps.js` 能力表 |
| 参数语义 / 图层 / 光影 | `engine.js`（60/192/275/427/673/698） |
| 面板控件与状态同步 | `app.js:730 syncModelFromUI`、`:894 refreshUI`、`:1673 setupPanelInteractions` |
| 撤销 / 手势 / 自动保存 | `app-state.js` |
| 渲染调度 / 性能 | `app-render.js` |
| 导出 | `app-export.js` + 主进程 `pick-export-location`/`write-export-files` |
| 模板库 / 预设应用 | `app-templates.js`（`applyPreset:469` 保留用户元素） |
| 工程文件 | `app-qfs.js` + `index.js:226` |
| 预设数据 | `shared/presets/*.json`（须过 `validate-presets`） |
| 发布校验 | `tools/verify-dist.js`（`verify:pkg` = `--installers`，核对安装包 size/sha512 ↔ `latest.yml`） |
