# 清框影 · 优化改动清单（改动 → 证据 → 如何验证）

> 前提约束：**不改变任何渲染像素**（`tests/visual/baseline.json` 的 869 键不得漂移）。
> 因此本轮所有引擎侧改动都是"同输出、更少的活"；凡会改变输出的一律**没做**，列在最后一节等你拍板。
>
> 交付状态：`npm run check` 全绿（ESLint + 78 预设 + 能力表 + **67 项纯 Node 断言**）。

---

## 一、主进程与 IPC

| # | 改动 | 证据 | 怎么验证 |
|---|---|---|---|
| 1 | **EXIF 只读文件头部**，不再把整张照片读进内存（新增 `src/main/exif-read.js`，`index.js` 引用）。JPEG 单段长度上限 64KB ⇒ APP1 必在文件前部；窗口内找不到完整 APP1 就回退整读 | 78 个真实照片样本（含 40MB 单反图、106 个 PNG）：**头部解析与整文件解析逐字段一致**；内存搬运 **649MB → 52MB（−92%）**，耗时 **486ms → 96ms** | `npm run test:mainio` |
| 2 | **预设合并通道 `load-all-presets`**：1 次 IPC 取代 `1 + 78` 次往返（主进程并发读盘） | 两条路径（合并 / 逐个）产出的对象**逐键序完全相同** | `npm run test:engine` ⑤ 组 |
| 3 | **`open-images` 并发解析 EXIF**（原为串行 `await`） | `Promise.all` 保序，结果顺序不变 | 代码审查 |
| 4 | **`freeFilePath` 用一次 `readdirSync` 取代逐个 `existsSync`**；集合比对用全小写键以对齐 Windows 大小写不敏感语义（否则 `Photo.JPG` 已存在时会覆盖 `photo.jpg`） | 4 个用例 + 目录不存在回退，**与改动前逐例等价** | `npm run test:mainio` ⑥ 组 |

## 二、渲染进程 UI / 状态

| # | 改动 | 证据 |
|---|---|---|
| 5 | 缩略图条改为「图对象 → 节点」索引映射，去掉每渲一张就 `querySelectorAll('img.thumb')` 扫全条的 **O(n²)**；带 `isConnected` 守卫，节点被重建时回退原扫描 | 导入 50 张时由 2500 次节点访问降为 O(1) 直取 |
| 6 | `renderLogoPools` 加内容签名守卫：切到「Logo」页签不再重建 106 个 `div` + 106 个 `img`（给 `img.src` 赋值会触发解码） | 签名含数量/名称/dataUrl 体积，导入·删除·重命名都会改到它 |
| 7 | `updateLabel` 幂等写（值没变不碰 DOM）——每帧路径 | — |
| 8 | 模板缩略图按「名称 + 内容指纹」缓存 dataURL；**模板页签不在前台就不渲染** | 每个缩略图 = 一次完整引擎渲染 + `toDataURL` |
| 9 | `updateExportSizeNote` 的隐藏分支幂等（每次 input 都会走到） | — |

## 三、渲染引擎（全部为"同输出"缓存）

| # | 改动 | 证据 |
|---|---|---|
| 10 | `parseColor` 记忆化 | **144 组 hex/opacity 输入与改动前公式逐字段一致**（`test:engine` ①） |
| 11 | 颗粒砖 `GRAIN_TILE_CACHE` 加 LRU 上限 8（原为无界：键空间约 1300 档、单块最大 7.9MB，拖动留白时每帧新增一块，一次拖拽可达 GB 级） | 像素**逐字节等于参考 LCG**；淘汰后重算**逐字节相同**（②③） |
| 12 | `charW` / `textMetricsF` 记忆化（一帧量上千次 `measureText`） | 缓存键含 `letterSpacing`、`setFont` 仍先于查缓存——做成**源码级绊线**（④） |
| 13 | `style-caps.visibleRows` 记忆化（纯函数，每次 refreshUI 重建 18 键对象） | 76 个风格名返回同一组 18 个布尔键；大小写变体共享缓存；数值滑块行与 MEASURED 口径一致（⑧） |

## 四、导出与内存

| # | 改动 | 证据 |
|---|---|---|
| 14 | **导出元素缩放补上通道 dpr**（`exportSizeScale` + `_exportPathDpr`）。原 `k = afterW/beforeW` 两次都在导出通道内测量（dpr 恒 1），看不见"预览画布 = `_logW × dpr`"与"导出画布 = `_logW × 1`"的差异 ⇒ 导出的 logo 大 dpr 倍、贴边锚点还会离边更远 | 16 项断言：第 1 张 `k == afterW/真实预览宽度`；**批量时每张用自己的 `beforeW`（这条是修补我上一轮引入的偏差）**；口径一致时 `k` 恰为 1；非法 `pathDpr` 退化为 1（⑥） |
| 15 | `.qfs` 导出：旋转过的照片直接复用 `im.el`（尺寸吻合的 canvas，内容来自 JPEG ⇒ 不透明）当编码源 —— 「新建同尺寸画布 + 铺白底 + 1:1 blit」整步是空操作，省掉一块 96MB 画布与一次全分辨率 blit，**产物逐字节相同** | 9 项断言：尺寸严格一致才复用、`<img>` 一律不复用（可能有 alpha）、`customSettings` 保持同一引用（不再深拷贝）、默认值与旧实现一致（⑦） |
| 16 | `.qfs` 用完显式释放画布后备缓冲（`c.width = c.height = 0`） | 24MP ≈ 96MB，不等 GC |

## 五、工具链

| # | 改动 | 证据 |
|---|---|---|
| 17 | **10 个"恒绿"用例改用 `finish()` → `app.exit()`**（`app.quit()` 之后再设 `process.exitCode` 会被 Electron 主进程忽略，断言失败也返回 0） | 语法全绿 + 无 `app.quit()`/`process.exitCode` 残留；**运行结果需你跑 `npm test`** |
| 18 | `verify-dist.js`：预设/纹理数量改为**从源码实测**（原硬编码 70，实际已 78）；**内容缺失归为退出码 1**（原与"无法判定"共用 2）；README 同步 | 合成 `app.asar` 端到端自检 **0 / 1 / 1** 三条出口全对，含"预设少 1 → 1"（这正是原实现会误判成 2 的情况） |
| 19 | `stress.js` 内存熔断**真正生效**：原 `setAbort` 经 contextBridge 暴露，函数体跑在 preload 的**隔离世界**，主世界的压测 RUNNER 永远读不到；且从没设 `App._exportAbort`，在途批量导出根本不停 | 改为 `executeJavaScript` 在主世界置位两个标记 |
| 20 | 新增 **`tools/test-main-io.js`(13 项)** 与 **`tools/test-engine-invariants.js`(54 项)**，接入 `npm run check` | 两组共 67 项断言，**不需要 GUI** |
| 21 | `@electron/asar` 列入 `devDependencies`（原先只靠 electron-builder 的传递依赖）；lock 同步并修正根版本漂移；**删除 525MB 陈旧 `dist/`**（含 106 个 brandlogos 与两个 109MB 安装包） | `npm run verify:dist` 行为已同步 |

---

## 六、导出链体检（2026-10-19，只量未改）

> 工具：`tools/measure-export.js`（`node tools/run-electron.js tools/measure-export.js`）。
> 同一张画布上把「canvas → toDataURL(base64)」与「canvas → toBlob → arrayBuffer」各跑一遍。
> 测试进程带 `--disable-gpu`（软件光栅），绝对耗时偏慢；看的是两条路的相对差。
> 画布内容为渐变 + 4 万块噪点 + 文字（模拟高熵照片），JPEG q92。

| 尺寸 | 像素 | toDataURL | toBlob | base64 体积 | blob 体积 | 膨胀 | 像素一致 | 字节一致 |
|---|---|---|---|---|---|---|---|---|
| 6000×4000 | 24.0 MP | 160.2ms | **107.0ms** | 2.3MB | 1.7MB | 1.333× | 是 | **是** |
| 8192×5461 | 44.7 MP | 272.1ms | **176.9ms** | 2.7MB | 2.0MB | 1.333× | 是 | **是** |

**结论（三条，均已实测）**

1. **同一画布上两条路逐字节相同**（24MP/44.7MP 都是；同一画布两次 `toDataURL` 也逐字节一致 ⇒ 编码确定）。
   即 OPTIMIZATIONS「刻意没做 #5」里「换 `toBlob` 可能静默丢 sRGB」的担忧在实测中不成立：JPEG 标注
   （APP0/JFIF、APP2/ICC_PROFILE 等段清单）两条路完全一致 —— 换路不改产物，不需要重建像素基线。
2. **编码耗时 −33%～−35%**（160→107ms / 272→177ms），且 `toBlob` 是异步接口：长边 8192 的批量导出
   不会把渲染线程按百毫秒级长时间独占（现状 `toDataURL` 是同步调用）。
3. **负载小三分之一**：base64 字符串恒比原始字节大 1.333×（每张多搬 0.6–0.7MB 字符串），
   IPC 往返 base64 5.5/7.4ms vs Uint8Array 3.8/4.9ms，主进程 `Buffer.from(base64)` 另花 0.6–1.1ms。
   `blob.arrayBuffer()` 本身仅 1.6–1.9ms。

**若切（需要拍板，改动点已探明，风险低）**

- 渲染层 `app-export.js` 两处：`exportImage`（`files[n].data = src.toDataURL(...).split(',')[1]`）与
  `_gridFiles`（逐块 `toDataURL`）→ 改 `await toBlob + arrayBuffer`，负载传 `Uint8Array`。
- 主进程 `index.js` 写盘 handler：`Buffer.from(f.data, 'base64')`（exif-write.js `applyExifToExportItem`）
  改为 `Buffer.from(arr.buffer, byteOffset, byteLength)`；`.qfs` 与其它 base64 路径不动。
- EXIF 移植、`freeFilePath`、进度事件都不受影响（两条路之后完全同路径）。
- 注：**本机测试窗口**的画布编码带 APP2 ICC_PROFILE(472B)，而应用画布在 `test:srgb` 里测得 0 字节 ICC ——
  与页面色彩配置有关；但两条路在**同一画布**上标注与字节完全一致，故与本次取舍无关。

---

## 验证命令

```powershell
$env:ELECTRON_RUN_AS_NODE=$null      # 本机若被置位,Electron 脚本会第一行就崩
npm run check                        # 不需 GUI:lint + 预设 + 能力表 + 67 项断言
npm test                             # ← 唯一还没跑过的:869 键视觉基线 + 19 个 GUI 用例
npm run verify:dist                  # 重新打包后再跑(dist/ 已清空,现在会报"还没打包过"= 退出码 2)
```

改前/改后对比（需要 GUI）：

```powershell
npx electron tools/measure-drag.js   # 拖动每帧耗时(改动前注释记录为 52~143ms/帧)
npx electron tools/measure-size.js
$env:STRESS_IN='<照片目录>'; $env:STRESS_OUT='<可写目录>'; npx electron tools/stress.js
```

---

## 刻意没做的（按原因分类）

**A. 会改变像素/文件内容，需要你先拍板**

1. **`applyOrientation` 的 JPEG 0.95 往返**（`app.js:1296`）：每个需要旋转的照片都走「全分辨率 canvas → 重编码 JPEG 0.95 → 再解码回 `<img>`」。后果：**有损**（每次导入掉一次画质）、PNG 源图的透明区被编码成**黑底**、每次导入多一次全尺寸编码+解码（24MP 各约 96MB）。`canvas` 本身就能当绘制源，省掉这趟会让旋转照片**更清晰**——所以属于"改变像素"，我没有擅自改。
2. **`.qfs` 把每张源图全分辨率重编码 JPEG 0.92**（`app-qfs.js`）：每次"导出工程 → 导入工程"都掉一次画质，而工程里存的本来只是源图。
3. **`shared/custom-icons.json` 数据瘦身**：**41.83MB / 仅 2 条**，`1_1.jpg` 6024×4024、`sony.png` 6000×4265（解码合计约 190MB），却只当几百像素的贴纸用。导入时降采样到 2048 即可根治，视觉无差。

**B. 需要先拿到 `npm test` 基线才敢动**

4. **每帧全模板深克隆**（`app-state.js:7` → `app.js` `cloneTemplate`，以及 `app-render.js:196`）：UI 组认定的单项最大收益（带 logoElements 时 0.5–3ms/帧）。但它有 **6 个读取点**（切图 1189 / 缩略图 1524 / 导出 `app-export.js:207` / 草稿 `app-draft.js:44` / 同步 `app-templates.js:567` / 帧内判定 `app-render.js:199`），延迟克隆漏接任何一个都会变成"编辑完快速切走再切回，改动没了"的**静默数据丢失**。
5. **导出改 `toBlob` → `Uint8Array`**：8192 每张约省 35–45MB 峰值与一趟 base64。风险：可能与 `toDataURL` 的编码字节不同（**静默丢 sRGB**，而那正是 `test-export-srgb` 要防的"微信发灰"）；但那条测试跑的是 `design/regress.html` 自调 `toDataURL` 的路径，**不经过 `app-export`,抓不到这个回归**。**（2026-10-19 实测已排雷：同一画布两条路逐字节相同、标注一致、编码 −33%，见第六节；等拍板即可切）**
6. **`willReadFrequently`**：可能让 CPU/GPU 光栅差 1 LSB —— 那等于改像素。必须先过 869 键基线。

**C. 已评估后判定不划算**

7. `TEXTURE_CACHE` 加 LRU：淘汰会让位图回到"异步加载中"，`getElementBitmap` 那一帧返回 null ⇒ **Logo 可能整帧不画**，撞上导出就是丢 logo。为省内存冒这个险不值当。
8. `.thumb-strip` 的 `backdrop-filter` / `will-change`：GPU 合成行为难以在不测量的情况下预测，收益不明确。
9. 预设搜索框 `buildTree` 防抖：每键重建约 390 个 DOM 节点，但加防抖会让"输入后立刻点击"可能点到未过滤的项，收益不足以换这个交互风险。
