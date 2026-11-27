# 清框影 · Photoshop 桥接 PoC

目标：验证「把桌面端的边框 / 拼图作为 Photoshop 面板插件」是否可行。当前只是**概念验证**，不是可分发产品。

## 结论（技术）

- **CEP 路线可行**：CEP 面板是 Chromium WebView，完整支持 Canvas2D（`drawImage` / `fillText` / `getImageData`），我们现有的 `engine.js` / `engine-styles.js` 和 91 款预设可以原样跑。
- **UXP 路线短期不可行**：Adobe 官方文档写明 UXP 的 `HTMLCanvasElement` 只支持基本形状，没有 `drawImage`/文字/像素读取，也没有 WebGL；要做出同样效果得把每款预设重写成 Photoshop 原生图层，工作量是月级。

## 目录

```text
ps-plugin/
├─ manifest.xml              CEP 12 扩展清单（未签名）
├─ index.html                面板 UI
├─ css/panel.css
├─ js/main.js                面板侧：导出图层 → 渲染 → 写回
├─ jsx/host.jsx              ExtendScript：Photoshop 侧读写图层
├─ js/                       从 mobile/www/js 复制的引擎与预设（同源）
├─ lib/CSInterface.js        Adobe CEP 12 官方库
├─ lib/Vulcan.js
├─ icon.png
└─ tools/test-poc.js         用 Electron 模拟宿主跑通整条链路
```

## 流程

1. `qfGetLayerPng`：ExtendScript 把当前选中图层复制到一个临时文档，导出透明 PNG。
2. 面板用 `cep.fs.readFile` 读成 base64，`Image` 解码后画进离屏 canvas。
3. 用桌面同一份 `window.__render` / `window.__renderPuzzle` 渲染，输出 PNG。
4. `cep.fs.writeFile` 写临时 PNG，`qfPlacePng` 在 Photoshop 里打开它、复制图层、贴回当前文档。

输出是**一张扁平化的新图层**，不是可逐层编辑的相框元素。

## 本地验证（无 Photoshop）

```bash
npm run test:ps:poc
```

用 Electron 加载面板，注入 `window.qfMockHost` 代替 Photoshop，验证：引擎/预设加载、边框渲染、拼图渲染、两次 PNG 写回均成功。

## 在 Photoshop 里试用（开发模式）

一条命令自动安装（复制扩展 + 打开未签名调试模式）：

```bash
# 在项目根目录执行（不是 ps-plugin 目录）
npm run ps:poc:install

# Photoshop 不在 C 盘默认位置时，指定安装目录：
npm run ps:poc:install -- --ps "D:\PS2026\Adobe Photoshop 2026"
```

脚本会找 `C:\Program Files\Adobe\Adobe Photoshop *`，把扩展拷到它的
`Required\CEP\extensions\com.qingframe.ps.bridge.poc\`，并写入
`HKCU\Software\Adobe\CSXS.12\PlayerDebugMode=1`。写 Program Files 可能需要管理员权限；
装完**重启 Photoshop**，菜单 `窗口 → 扩展功能 → 清框影 PS 桥接 PoC`。
选中一个图层 → 选风格 → 点「边框 → 新图层」或「四宫格 → 新图层」。

如果脚本找不到 PS 或权限不足，手动做同样两件事即可：
1. 把整个 `ps-plugin` 目录拷到 `<PS 安装目录>\Required\CEP\extensions\com.qingframe.ps.bridge.poc\`
2. 注册表 `HKEY_CURRENT_USER\Software\Adobe\CSXS.12` → `PlayerDebugMode` = `1`（字符串）

正式分发需要 ZXP 打包 + 签名（Adobe 的 ZXPSignCMD），且 CEP 属于遗留平台；长期方案应评估 UXP 原生图层重写。

## 已知限制

- 未签名、不可直接上架 Adobe Exchange。
- 只取**当前选中图层**，不处理多图层合成。
- 拼图 PoC 用同一张图铺满 4 格，没有换图 UI。
- 没有把我们的「调色 / RAW / EXIF」链路接进来，只验证边框与拼图。
