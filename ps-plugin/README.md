# 清框影 · Photoshop 加边框插件 PoC

目标：验证「把桌面端的边框作为 Photoshop 面板插件」是否可行。当前只是**概念验证**，不是可分发产品；本版只做加边框，不含拼图。

## 结论（技术）

- **CEP 路线可行**：CEP 面板是 Chromium WebView，完整支持 Canvas2D（`drawImage` / `fillText` / `getImageData`），我们现有的 `engine.js` / `engine-styles.js` 和 91 款预设可以原样跑。
- **UXP 路线短期不可行**：Adobe 官方文档写明 UXP 的 `HTMLCanvasElement` 只支持基本形状，没有 `drawImage`/文字/像素读取，也没有 WebGL；要做出同样效果得把每款预设重写成 Photoshop 原生图层，工作量是月级。

## 目录

```text
ps-plugin/
├─ CSXS/manifest.xml         CEP 12 扩展清单（必须放在 CSXS 目录，未签名）
├─ index.html                面板 UI
├─ css/panel.css
├─ js/main.js                面板侧：导出图层 → 渲染 → 写回
├─ js/border-params.js       边框参数面板：边距/缩放/圆角/填充/描边/阴影/样式参数
├─ jsx/host.jsx              ExtendScript：Photoshop 侧读写图层
├─ js/                       从 mobile/www/js 复制的引擎与预设（同源）
├─ lib/CSInterface.js        Adobe CEP 12 官方库
├─ lib/Vulcan.js
├─ icon.png
└─ tools/test-poc.js         用 Electron 模拟宿主跑通整条链路
```

## 流程

1. `qfGetDocKey`：先拿一个轻量 key（文档尺寸/路径/历史步数）。文档没改动就直接复用已解码的源图，连 PS 侧的复制/合成/存盘都省掉；改过图才走 `qfGetLayerPng` 重新导出。
2. `qfGetLayerPng`：ExtendScript 复制整份文档并合成，导出高质量 JPEG 到唯一临时文件（manifest 已开文件访问），面板用 `file://` 直接加载，不读 69MB 的 base64。
3. 用桌面同一份 `window.__render` 渲染选中风格，输出高质量 JPEG（体积比 PNG 小一个量级）。
4. Node `fs.writeFile` 写临时 JPEG，`qfPlacePng` 在 Photoshop 里置入/贴回当前文档，随后删除临时结果文件并刷新缓存 key。

输出是**一张扁平化的新图层**，不是可逐层编辑的相框元素。

## 界面与性能

- **风格搜索**：91 款预设可按名字过滤（如「拍立得」「背景模糊」），不用在缩略图墙里翻。
- **缩略图懒加载 + 本地缓存**：只渲染滚动到可见区域的风格，结果存 `localStorage`；下次打开面板几乎瞬时出图。预设变化时缓存自动失效。
- **实时预览节流**：拖滑块时最多约 11 帧/秒，预览底图压到 700px；松手后最后一次改动也会渲染。预览下方显示当前风格名和预览尺寸。
- **源图缓存**：文档没改动时重复套用不再从 PS 重新导出；编辑过的文档（历史记录变化）自动失效。上次选的风格和个性签名会记住。
- **色域转换原地做**：不再额外复制一张与成品等大的 Canvas；转换失败自动回退 sRGB 输出并记日志。
- **状态与日志**：底部常驻「重置参数 / 套用边框」和状态栏；运行日志收进折叠面板，出错时自动展开。
- **头像**：选完缩到 256px 再存本地，避免大图塞爆 localStorage 配额。

## 本地验证（无 Photoshop）

```bash
npm run test:ps:poc
```

用 Electron 加载面板，注入 `window.qfMockHost` 代替 Photoshop，验证：引擎/预设加载、边框渲染、PNG 写回成功。

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
装完**重启 Photoshop**，菜单 `窗口 → 扩展功能 → 清框影桥接`。
选风格 → 在参数面板调边距/缩放/圆角/填充/描边/阴影 → 点「套用边框 → 新图层」。

参数按风格能力显隐：相框风格由 `engine-styles.js` 独立绘制，只读取边距/照片缩放/照片圆角/样式私有参数，填充/描边/阴影分组会对它隐藏；这几组只对「无相框风格」的预设生效。

如果脚本找不到 PS 或权限不足，手动做同样两件事即可：
1. 把整个 `ps-plugin` 目录拷到 `<PS 安装目录>\Required\CEP\extensions\com.qingframe.ps.bridge.poc\`
2. 注册表 `HKEY_CURRENT_USER\Software\Adobe\CSXS.12` → `PlayerDebugMode` = `1`（字符串）

## 打包 ZXP

```bash
npm run ps:poc:fetch-signer   # 首次：下载 Adobe ZXPSignCmd（不入库）
npm run ps:poc:package        # 生成 build/qingframe-ps-poc.zxp 并验证签名
```

默认用自签名证书（仅开发测试，不能上架）。正式分发时提供：

```bash
$env:QF_ZXP_CERT='C:\path\to\cert.p12'
$env:QF_ZXP_PASS='证书密码'
npm run ps:poc:package
```

安装 ZXP 用 Adobe 的 `ExManCmd.exe /install <zxp>`。CEP 属于遗留平台；长期方案应评估 UXP 原生图层重写。

## 已知限制

- 未签名、不可直接上架 Adobe Exchange。
- 取的是**整份文档的可见合成**（尺寸即文档画布），不是选中图层的外框。
- 输出色域按文档配置自动选择（Adobe RGB / Display P3 / sRGB），也允许手动覆盖；结果会嵌入对应 ICC。
- 本版不含拼图。
- 没有把我们的「调色 / RAW / EXIF」链路接进来，只验证加边框。
