<a id="readme-top"></a>
<p align="center">
  <img src="assets/readme/hero.svg" width="100%" alt="清框影 QingFramShadow · Frame Studio — 本地照片加边框工具">
</p>

<p align="center">
  <strong>给照片一副好框，给参数一个位置。</strong><br>
  本地优先的桌面照片加框工具：艺术边框、光影、Logo 水印、EXIF 与签名，一次完成。
</p>

<p align="center">
  <sub>A local-first desktop photo framing app. Frames, light, logos, EXIF and signatures — rendered entirely on your machine.</sub>
</p>

<p align="center">
  <a href="https://github.com/lumos-1s/Qing-Fram-Shadow/stargazers"><img src="https://img.shields.io/github/stars/lumos-1s/Qing-Fram-Shadow?style=flat-square&color=blue" alt="GitHub stars"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/lumos-1s/Qing-Fram-Shadow?style=flat-square&color=green" alt="MIT License"></a>
  <a href="https://github.com/lumos-1s/Qing-Fram-Shadow/releases"><img src="https://img.shields.io/badge/version-0.1.21-orange?style=flat-square" alt="Version 0.1.21"></a>
  <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/Electron-45-47848F?style=flat-square" alt="Electron 45"></a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4?style=flat-square" alt="Windows 10/11">
</p>

<details>
<summary><strong>目录 · Table of Contents</strong></summary>

- [最近更新](#whats-new)
- [下载](#download)
- [核心功能](#features)
- [预设效果](#preset-gallery)
- [快速开始](#quick-start)
- [技术栈](#tech-stack)
- [项目结构](#project-structure)
- [开发与校验](#development)
- [代码签名政策](#code-signing)
- [参与贡献](#contributing)
- [素材与许可](#assets-license)

</details>

---

## 先看效果 · See it in action

<p align="center">
  <img src="assets/readme/app-ui.png" width="100%" alt="清框影应用界面：左侧预设库、中间套用复古双线边框的示例照片、右侧参数与 EXIF 面板">
</p>

<p align="center">
  <sub>真实应用界面 · 套用「复古双线」预设 · 示例照片与参数为演示数据<br>Real UI with the “1970s Double Line” preset · demo photo and data</sub>
</p>

## 它是什么 · What it is

**清框影 QingFramShadow** 是一款 Windows 桌面照片加框工具。它把「边框」当成一张可编辑的画布：先选一个模板定下气质，再调整边距、圆角、纹理、光影、Logo、相机参数与签名，最后按原图尺寸或指定尺寸导出。

- **想让照片快速成片的人**：87 个模板直接套用，右侧参数实时预览。
- **在意画质与隐私的人**：Canvas 2D 本地渲染，照片不上传，不登录。
- **需要成批出图的人**：模板记忆、批量导入、同步到选中，一次导出。

> **English** — A Windows desktop app for framing photos locally: 87 presets, 92 frame styles, live frame/light/logo/EXIF controls, reusable templates, collage, grid slicing and batch export. No account, no uploads.

<a id="whats-new"></a>
## 最近更新 · What's New

### v0.1.21

- **沉浸展示支持滚轮切换** — 鼠标滚轮上下滚动即可切换上一张/下一张；触控板惯性按一次手势处理，不会一划跳过很多张。
- **背景模糊默认开关** — 可选择「跟随预设 / 默认开 / 默认关」，切预设和重启后仍记住选择；默认开时模糊程度调节正常显示。
- **预设视觉更新** — 重做 NOMO 复古相机，预设墙同步多张自定义封面。
- **预设墙体验优化** — 外圈聚焦隔帧刷新，拖动前撤掉悬停倾斜，浏览更稳。

> **English** — v0.1.21 adds mouse-wheel navigation in immersive view, a remembered background-blur default, a reworked NOMO preset and refreshed preset-wall covers.

完整变更与安装包见 [GitHub Releases](https://github.com/lumos-1s/Qing-Fram-Shadow/releases)。

<a id="download"></a>
## 下载 · Download

从 [GitHub Releases](https://github.com/lumos-1s/Qing-Fram-Shadow/releases) 下载 Windows 安装版（NSIS）或便携版。

**当前 Windows 产物未签名。** 安装包由 GitHub Actions 从本仓库构建；首次运行会遇到 SmartScreen「未知发布者」提示，处理方式见下方[安装提示](#smart-screen)，校验方式见[代码签名政策](./CODE_SIGNING.md)。

> **English** — Windows builds are currently unsigned (SmartScreen will warn on first run). They are built by GitHub Actions from this repository. See [code signing policy](./CODE_SIGNING.md).

<a id="smart-screen"></a>
### 提示「未知发布者」怎么办 · SmartScreen note

未签名软件首次运行会被 SmartScreen 拦截，这是预期行为，不代表文件被篡改：

1. 在蓝色提示框点「更多信息 / More info」。
2. 点「仍要运行 / Run anyway」，再在 UAC 里点「是 / Yes」。
3. 不放心就先核对文件校验值（`certutil -hashfile <安装包> SHA256`），或改用免安装的便携版。

<a id="features"></a>
## 核心功能 · Features

- **87 个内置模板 · 92 种边框风格** — 杂志、拍立得、撕纸、胶带、邮票、报纸、胶片、渐变卡、漫画分镜、3D 卡、签名纪念与头像叠加，以及自动取色边框等快速预设；选中即套用，再继续微调。
- **预设墙启动页** — 启动即进入 87 张预设封面墙，方向键、滚轮或拖动浏览，点击直接套用并进入编辑；支持用自定义照片替换封面。
- **参数实时可调** — 圆角、边距、照片缩放/偏移、内/外阴影、描边、投影、画布比例、纹理/渐变填充，改动即时反馈。
- **背景模糊默认偏好** — 在「跟随预设 / 默认开 / 默认关」之间切换，切预设或重启后仍记住选择。
- **分区编辑台** — 左侧预设显示与预设墙一致的封面缩略图，墙上换封面会同步到工作台；右侧按「画布 / 文字 / 边框 / 调色 / Logo / 模板」分区，拼图与切图归入工具行（原「光影」的暗角/漏光/颗粒已并入调色页签的「氛围」分区）；滑块旁可输入精确数值，双击参数名、数字框或滑轨本身即可复位该行，按住 Shift 拖动可微调；左右侧栏可收起、拖宽并记住上次宽度；多选照片后自动浮出批量操作条。
- **黑白混色器** — 勾一下就整张转灰度，再用 8 个色相带（红/橙/黄/绿/浅绿/蓝/紫/洋红）分别调「这个颜色转灰后有多亮」；导入 LR 预设时 `ConvertToGrayscale` 与 `GrayMixer*` 会一并套用。
- **蒙版调色** — 调色面板顶部可加蒙版：线性渐变 / 径向椭圆 / 画笔涂抹 / 亮度范围，可叠多个；选中某个蒙版后，九档滑块只作用在蒙版范围内（曲线/校准/混色器仍是全局），支持羽化、浓度与反相；画布上直接拖渐变方向或涂抹，蒙版范围实时染成绿色预览。
- **基础调色** — 曝光、对比度、饱和度、色温、色调、高光、阴影、白色、黑色九档滑块（白色/黑色是 Lightroom 那对黑场白场：白色并合高光、黑色抬黑或压死暗部），外加 RGB / 红 / 绿 / 蓝四条可拖动曲线（S 形加对比、抬黑点做褪色灰调、分通道调色）；再往上是「细节」（清晰度 / 纹理 / 去除薄雾）、「校准」（红/绿/蓝原色 · 色相/饱和）与「混色器」（8 色相带 × 色相/饱和度/明亮度，彩色轨道子页切换）；只作用于当前选中的照片，参数随草稿保存、随时可重置，也可一键复制到本次导入的全部照片，不改动原图。
- **光影与质感** — 暗角、漏光、暖光/冷光、胶片颗粒（在「调色 → 氛围」里，都是常开滑块、强度 0 即关闭，叠加于整张成片含边框），以及纸张、布料等纹理，给整张成片统一的氛围。
- **Logo、EXIF 与签名** — 品牌 Logo 或自定义图标水印；自动读取品牌、型号、焦距、光圈、ISO、快门，可手动修改；签名与头像组合排版。
- **模板系统** — 保存/导入/导出 `.qfs` 工程与 `.json`；支持搜索、标签分组、缩略图预览、应用、重命名与带确认的删除。
- **拼图与九宫格** — 多图网格拼贴，间距、圆角与字幕可调；九宫格切图把当前画布按 n×n 切成多张，预览确认后导出。
- **批量处理** — 批量导入（支持整个文件夹与 HEIC，HEIC 自动读取 EXIF）、逐张记忆模板、同步到选中、装框缩略图，一键批量导出。
- **沉浸展示** — 把胶片条或勾选的照片铺成模糊照片墙，中央毛玻璃卡片展示当前成片；←/→ 或鼠标滚轮上下切换，鼠标静止 2 秒自动隐藏工具栏与光标，Esc 或关闭按钮退出，退出后不改变当前图、选区和缩放。
- **导出** — PNG / JPEG / WebP，质量可调；原图、1080、2048、4096、8192px；选好位置后渲染写入，默认原图尺寸。
- **全本地** — 无需登录、不上传照片；照片、EXIF 与模板都留在本机。

> **English** — 87 presets and 92 frame styles for magazine, polaroid, torn paper, tape, stamp, newspaper, film, gradient, comic, 3D card, signature and avatar layouts; a preset-wall launcher; live frame, shadow, texture and light controls; remembered background-blur defaults; basic per-photo grading (exposure, contrast, saturation, temperature, tint, highlight, shadow); preset thumbnails, split canvas/text panels, exact numeric slider input, double-click row reset and Shift fine-tuning; collapsible resizable side panels; logo/EXIF/signature layers; `.qfs` and `.json` templates; collage, grid slicing, batch export and an immersive photo-wall presentation with wheel navigation; PNG/JPEG/WebP up to 8192px. Everything local.

<a id="preset-gallery"></a>
## 预设效果 · Preset Gallery

<p align="center">
  <img src="assets/readme/preset-wall.webp" width="100%" alt="六种预设的真实渲染：VHS 录像带、复古报纸、复古双线、仿古邮票、复古胶片撕裂、老相册角贴">
</p>

<p align="center">
  <sub>六种预设的真实渲染 · 示例照片为项目自绘的黄昏湖面<br>Six real engine renders · sample photo: a self-drawn dusk lake</sub>
</p>

87 个模板覆盖复古胶片、拍立得、邮票、报纸、杂志、撕纸、胶带、漫画、签名、拼图等方向；每个模板都能继续改边距、圆角、纹理、光影与文字。六张预设图都由引擎实际渲染，不是手工绘制的模拟效果，也没有使用图库或用户照片。

<a id="quick-start"></a>
## 快速开始 · Quick Start

**直接使用**：从 [Releases](https://github.com/lumos-1s/Qing-Fram-Shadow/releases) 下载 Windows 安装版或便携版。

**三步出片**：

1. 从预设墙选一个模板进入编辑，或导入一张/多张照片；还没照片时可点「先用示例图看看」。
2. 在左侧换模板；右侧「画布」调边距、缩放与圆角，「文字」调字号与相机 EXIF，「边框 / 调色 / Logo / 模板」继续细化。
3. 点「导出」，选择 PNG / JPEG / WebP 与导出尺寸。

> **English** — Download a Windows build from Releases, import photos, pick a preset, adjust the frame/light/logo/EXIF, then export as PNG, JPEG or WebP.

**从源码运行**：

```bash
# 安装依赖 / install dependencies
npm install

# 开发模式启动 / run in dev mode
npm run start

# 打包 Windows 安装版 / build installers
npm run dist

# 仅供便携版 / portable only
npm run dist:portable
```

构建产物位于 `dist/`。Built artifacts are placed in `dist/`.

> 开发启动推荐用 `npm run start:soft`：自动挑一个可用的 Electron（项目外同版本副本优先），默认硬件合成。
> 只有 GPU 进程崩溃时才用 `npm run start:sw`（swiftshader 软件 GL，慢但兼容）。
> `npm run start` 仍是裸 `electron .`，供 CI / start.bat 使用。

> 提示：Windows 上可双击根目录 `start.bat` 直接启动开发环境。
> Tip: on Windows you can double-click `start.bat` in the project root to launch the dev environment.

### 换预设墙封面照片 · Changing preset-wall cover photos

预设墙（启动页）的封面由 `tools/gen-preset-wall.js` 渲染生成；换照片不用改代码：

1. 把照片按分类名放进 `design/preset-wall-samples/`，例如 `个性.jpg`、`艺术.webp`（支持 jpg / jpeg / png / webp）。
2. 重新生成（应用开着也能跑，生成器是独立进程）：

```bash
npm run gen:wall
```

没放照片的分类继续用 `tools/preset-wall.config.json` 里 `tagSamples` 指定的默认示例图，也可以直接改这个文件调整映射。只想换某一两张预设的封面、不想重新生成时，把图片放进应用数据目录的 `wall-covers/<预设名>.webp`（启动页「换封面」按钮会打开这个目录），重启应用生效。

生成器默认把封面长边压到 560px（配置里的 `coverMax`，或命令行 `--max`），87 张合计约 3MB。

> **English** — Drop photos named after a category into `design/preset-wall-samples/` (e.g. `个性.jpg`), then run `npm run gen:wall`. Categories without an override keep the default sample from `tools/preset-wall.config.json`. For one-off cover changes, put an image in `wall-covers/<preset>.webp` via the in-app “换封面” button and restart.

<a id="tech-stack"></a>
## 技术栈 · Tech Stack

[![Tech Stack](https://skillicons.dev/icons?i=js,html,css,electron,nodejs,npm,git,github)](https://skillicons.dev)

| 层 Layer | 技术 Tech |
|---|---|
| 桌面壳 Desktop shell | Electron 45（主/渲染进程分离，`contextIsolation` + `sandbox` 开启） |
| 渲染 Rendering | 原生 HTML / CSS / JavaScript + Canvas 2D 离屏合成 |
| 打包分发 Packaging | electron-builder（NSIS 安装版 + 便携版） |
| 自动更新 Auto-update | electron-updater + GitHub Releases |

没有前端框架，也没有后端服务；边框、光影、文字与导出都在渲染进程的 Canvas 2D 里完成。

<a id="project-structure"></a>
## 项目结构 · Project Structure

```
├─ src/
│  ├─ main/          # Electron 主进程：窗口、菜单、文件 IPC、模板读写
│  │                 #   main process: window, menus, file IPC, template I/O
│  └─ renderer/      # 渲染进程：UI 与 Canvas 渲染引擎
│                    #   renderer: UI and Canvas rendering engine
├─ shared/
│  ├─ presets/       # 87 个内置模板（JSON 描述）
│  │                 #   87 built-in preset templates (JSON)
│  ├─ textures/      # 纹理素材 / texture assets (10)
│  └─ brandlogos/    # 本机品牌 Logo 素材，不随发行版分发
│                    #   local-only brand logos, excluded from distribution
├─ assets/readme/    # README 头图、界面截图与预设效果墙
├─ tools/            # 构建、校验与 Electron 测试辅助脚本
├─ tests/            # 单元 / 视觉回归等测试
├─ start.bat         # Windows 快速启动脚本 / quick-launch script
├─ THIRD-PARTY-ASSETS.md  # 第三方素材归属说明 / asset attribution notice
└─ package.json
```

<a id="development"></a>
## 开发与校验 · Development

<details>
<summary><strong>发布前自检 · Pre-release checks</strong></summary>

```bash
npm run check         # ESLint + 预设/标记/能力表校验 + 主进程 I/O、图标、引擎不变量（纯 Node，不需要 GUI）
npm test              # check + Electron 用例（面板、拖动、视觉回归等；&& 串联，单点失败即断）
npm run release       # 未压缩目录 → verify:dist 校验 → 打安装包 → verify:pkg 校验安装包
```

`npm run release` 等价于 `app:dir` + `verify:dist` + `dist`（`dist` 内含安装包构建 + `verify:pkg`）。`verify:dist` 会拦截品牌 Logo 泄漏、预设/纹理数量与源码不符、以及产物早于源码改动的情况；一旦发现，不会继续产出安装包。

```bash
npm run app:dir       # 只产出未压缩目录（供校验用）
npm run verify:dist   # 检查 dist/ 下所有 app.asar：无品牌 Logo、预设/纹理数量与源码实测一致、产物新鲜
npm run verify:pkg    # 另加安装包核验：Setup.exe 体积与 latest.yml 一致 + sha512 校验和逐字节复核
```

`verify:dist` 的退出码：`0` 通过 / `1` 已确定的失败（品牌 Logo 泄漏、预设或纹理数量与源码不符、或没有任何可读产物）/ `2` 无法判定（仅产物早于源码改动这种拿不准的情况）。`verify:pkg`（`--installers` 模式）在此基础上核对安装包与 `latest.yml` 的 size/sha512，不一致即退出码 1——`dist` / `release` / `release:publish` 都已在链尾自动执行。

> 预设与纹理的期望数量从 `shared/` 实测，不写死在脚本里——加了预设就不必再改校验脚本。

</details>

<a id="code-signing"></a>
## 代码签名政策 · Code signing policy

**Windows 产物目前未签名。** 本项目曾向 [SignPath Foundation](https://signpath.org/) 申请开源项目的免费代码签名；因项目公开可见度尚未达到该计划的门槛（其评审看的是 Star、Fork、外部引用与社区活跃度等公开信号），申请未获通过，达到条件后会重新申请。

在获得签名之前：

- GitHub Releases 上的安装包与便携版都是**未签名产物**，首次运行会出现 SmartScreen「未知发布者」提示；这是未签名软件的正常行为，处理方式见[安装提示](#smart-screen)。
- 请只从本仓库 Releases 页面下载，并按 [`CODE_SIGNING.md`](./CODE_SIGNING.md#verifying-an-unsigned-release) 核对校验值。
- **任何称清框影已由 SignPath Foundation 签名的说法，对当前版本都不成立。**

签名范围、审批流程与验签方法（签名启用后适用）见 [`CODE_SIGNING.md`](./CODE_SIGNING.md)；联网与隐私说明见 [`PRIVACY.md`](./PRIVACY.md)。

> **English** — Windows builds are unsigned for now. An application to the SignPath Foundation OSS program was declined because the project does not yet meet the program's public-visibility bar; the project will reapply. Do not describe any current release as signed. See [`CODE_SIGNING.md`](./CODE_SIGNING.md) for verification.

<a id="contributing"></a>
## 参与贡献 · Contributing

欢迎提交 Issue 或 Pull Request：

1. Fork 本仓库。
2. 新建分支：`git checkout -b feature/your-feature`。
3. 提交改动，并运行 `npm run check`；涉及 UI 时再运行对应的 Electron 用例。
4. 推送分支并创建 Pull Request。

> **English** — Issues and pull requests are welcome. Fork the repo, create a feature branch, run `npm run check`, and open a PR.

<a id="assets-license"></a>
## 素材与许可 · Assets & License

代码采用 [MIT](./LICENSE) 许可。该许可仅覆盖 `src/` 下的源代码与 `shared/presets/` 中的原创模板；`shared/brandlogos/` 与 `shared/textures/` 中的素材不适用，其权利归各自权利人所有。

- **品牌 Logo**：`shared/brandlogos/` 是本机素材，**不在版本库中**，也不随安装包分发。全新克隆缺少该目录时软件照常运行，只是「品牌 Logo」选择组为空、「按品牌自动配 Logo」不生效；相关素材需自行准备。品牌名称与图形仅用于标识照片的拍摄设备，本软件与任何品牌无授权或合作关系。
- **纹理素材**：`shared/textures/` 中的纹理不适用 MIT 许可，权利归各自权利人所有。
- **README 示例图**：示例照片为项目自绘的合成图；界面截图与预设效果由真实应用渲染，未使用图库或用户照片。

详见 [`THIRD-PARTY-ASSETS.md`](./THIRD-PARTY-ASSETS.md)。

> **English** — MIT covers the source code under `src/` and the original presets under `shared/presets/`. Brand logos are local-only: not tracked by git and excluded from installers; a fresh clone runs fine without them. Assets under `shared/textures/` are third-party material. See `THIRD-PARTY-ASSETS.md`.

---

<sub>关键词 / Keywords：照片加边框 · 艺术边框 · 水印 · EXIF 相机参数 · 拼图 · 九宫格切图 · 批量导出 · 桌面工具 · Electron · Canvas 2D · photo frame · watermark · collage · grid slice · batch export</sub>

<p align="center"><a href="#readme-top">回到顶部 ↑</a></p>

<p align="center"><sub>如果清框影对你有帮助，欢迎点一个 ⭐ Star。</sub></p>
