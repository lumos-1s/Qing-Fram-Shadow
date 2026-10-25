# 看片台静态原型

这是「清框影」首页看片台的静态视觉/交互原型，不是第二个编辑器，也不是营销落地页。
它只负责展示成片、浏览风格、查看详情，并把「选风格」这件事演示清楚；真正的导入、套用和编辑还没有接进来。

## 打开

在项目根目录执行：

```powershell
start design\home-prototype.html
```

或者直接双击 `design/home-prototype.html`。页面通过相对路径加载样式、脚本和图片，可以离线打开。
建议用 Electron 或较新的 Chromium/Edge 查看。

## 文件

| 文件 | 用途 |
| --- | --- |
| `home-prototype.html` | 原型页面结构 |
| `home-prototype.css` | 深色/浅色主题、看片台、网格、详情灯箱、响应式样式 |
| `home-prototype.js` | 拖动、吸附、分类、模式切换、键盘、详情、焦点管理等交互 |
| `home-prototype-data.js` | 由真实预设生成的 12 条展示数据 |
| `home-prototype-assets/` | 12 组预设成片（示例/我的照片两版）和 6 张示例照片 |
| `render-home-prototype.js` | 重新渲染封面并生成数据 |
| `test-home-prototype.js` | Electron 交互与布局回归检查 |
| `shot-home-prototype.js` | 生成审阅截图 |

## 哪些是真的

- 12 张封面不是占位图，而是用 `shared/presets/` 里的真实预设渲染出来的。
- 卡片标题、描述、分类、标签、预设文件名、画布尺寸都来自生成的数据。
- 交互是真的：横向看片台、拖动滚动、吸附居中、左右箭头、键盘方向键、分类筛选、示例/我的照片切换、网格视图、详情灯箱、大图模式、Esc 关闭、焦点陷阱、主题持久化。
- 响应式是真的：1400×900 和 1000×640 都做了布局检查。1000×640 首屏仍能看到「选择照片」、完整当前卡片和标题。

## 哪些是占位

- 「选择照片」会打开系统文件选择框，但选完只弹提示，不会真的导入。
- 「导入文件夹」「工作台」「设置」「关于」都只弹提示；「继续上次会话」是禁用占位。
- 卡片和详情里的「用我的照片试穿」只演示选择动作，不会修改照片或打开编辑器。
- 「最近作品」是空状态，没有真实的草稿读取。
- 主题会写入 `localStorage`，这是原型里唯一会持久化的状态。
- 6 张示例照片是生成的风格化插画，不是有版权的真实照片。

## 重新生成封面

```powershell
node tools\run-electron.js design\render-home-prototype.js
```

脚本会重新写入 `design/home-prototype-assets/` 和 `design/home-prototype-data.js`。
如果改了 `render-home-prototype.js` 里的 `ITEMS`、分类或文案，重新跑一次即可。

## 回归检查

```powershell
node tools\run-electron.js design\test-home-prototype.js
```

当前检查覆盖：初始卡片与进度、封面加载、1400/1000 布局、分类筛选、示例/我的照片、箭头与键盘、网格、详情、大图、Esc、焦点恢复、主题，以及 1000×640 下首屏和网格的可见性。
最后应输出 `ALL PASS`。

## 重新截图

```powershell
node tools\run-electron.js design\shot-home-prototype.js
```

截图输出到：

```text
%TEMP%\qingframe-home-proto\
```

包括深色首页、网格、详情、大图、我的照片、浅色首页、1000×640、分类筛选、浅色详情和最近作品区域。

## 接入状态

原型文件独立放在 `design/` 下，没有改应用启动流程、没有改编辑器逻辑，也没有提交。
下一步如果要接入，建议先把 `home-prototype-data.js` 的字段映射到真实预设和最近草稿，再替换占位按钮的事件。
