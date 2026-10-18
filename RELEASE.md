# 发布与自动更新流程（RELEASE 指南）

清框影的自动更新走 **electron-updater + GitHub Releases**（同 yt-dlp 的"查版本→下载→替换"思路）：

- 启动 3 秒后主进程静默 `checkForUpdates()`，发现新版本通过 `updater:event` 推送渲染层横幅（"发现新版本 vX.Y.Z，点击更新"）。
- 用户点"立即更新"→ `downloadUpdate()` 下载新安装包并显示进度条 → 下载完"立即重启"→ `quitAndInstall()` 安装生效。
- 版本源是 GitHub Releases 上的 `latest.yml`（由 electron-builder 在打包 NSIS 安装版时自动生成）。

## 一、为什么现在不能一键更新（缺什么）

代码层全部就绪（主进程 / preload / 渲染 UI / build.publish 配置）。真正缺的是**发布动作**：
GitHub Releases 里没有 `latest.yml` + 新版安装包，旧版就永远查不到更新。

## 二、发布步骤（每次发新版）

1. **bump 版本号**（自动更新比对的依据，务必每次递增）：
   ```
   # 改 package.json 的 "version" 字段,如 0.1.7 → 0.1.8
   ```
   版本号规则：`主.次.修订`，任何功能/修复发布都要递增，不得回退。

2. **自检**（发布前必跑）：
   ```
   npm run check   # lint + 预设/标记/能力表校验 + 主进程 I/O、图标、引擎不变量
   npm test        # 上述 check + 24 个 Electron 用例(面板显隐、视觉回归 924 键等)，33 阶段全绿才可发
   ```

3. **打包并发布到 GitHub Releases**（需 GitHub token）：
   ```
   # Windows PowerShell,先设置 token(每次新开终端都要设,不持久化)
   $env:GH_TOKEN = "你的 Personal Access Token"
   npm run release:publish
   ```
   链路是 `app:dir` → `verify:dist`（校验未压缩目录 asar：无品牌 Logo、数量与源码一致、产物新鲜）
   → 打包发布 → `verify:pkg`（核对 Setup.exe 体积与 sha512 是否与 `latest.yml` 一致，不一致退出码 1；
   此时 Release 已上传，需人工修复重发）。`--publish always` 会自动：打包 NSIS 安装版 + portable 版 →
   生成 `latest.yml` → 创建/更新 GitHub Release（版本 tag 取 package.json version）→ 上传产物。产物含：
   - `Qingframe-Setup-<version>-x64.exe`（NSIS 安装版，**只有它带 app-update.yml，能自动更新**）
   - `Qingframe-Portable-<version>-x64.exe`（便携单文件版，**不支持在线自动更新**，代码里已跳过）
   - `latest.yml` / `latest-mac.yml`（更新源元数据，必须随 release 一起存在）
   - `Qingframe-Setup-<version>-x64.exe.blockmap`（**差量更新用，必须上传**：老版本升级时只下载与旧版不同的数据块——
     实测 0.1.10→0.1.11 只差 1.7MB（全量 75MB）；漏传不会把更新装坏，但所有旧版升级都会退化成全量下载）

4. **验证**：
   - 打开 GitHub Releases 页面，确认 tag 与 package.json 版本一致；资产齐全：`latest.yml`、Setup、Portable、
     **Setup 的 `.blockmap`**（历史 release 曾漏传，2026-10-18 已为 v0.1.10 / v0.1.11 补传）。
   - 装旧版 → 启动 → 3 秒后出现"发现新版本"横幅。

## 三、注意事项

- **portable 单文件版不能自动更新**：它不生成 `app-update.yml`，主进程检测到后直接跳过（日志 `[updater] 未发现 app-update.yml`）。想给便携版用户更新，只能引导到 GitHub Releases 手动下载；要"真·一键更新"就用 NSIS 安装版分发。
- **品牌 Logo 不进公开版**：`build.files` 已排除 `shared/brandlogos/**`，发布产物天然不含品牌 Logo 素材（商标/著作权考虑）。本地带 Logo 的包是单独打的，不走这个发布流程。
- **头像/用户名默认空**：打包产物不携带开发机的 userData（状态、头像、签名都留在本机 AppData），新用户安装后头像/用户名为空，符合发布要求。
- **发布无需本地跑**：`release:publish` 也可以在 GitHub Actions 上跑（配 GH_TOKEN secret），本地发布即可。
- **token 权限**：Personal Access Token 需要 `repo` 权限（创建 Release、上传 asset）。不要提交到 git。
- **差量更新（blockmap）**：electron-updater 会对比新旧安装包的数据块，只下载变化部分。三个前提：① 新版发布时上传 `.blockmap`（见上一步产物清单）；② 旧版发布时也上传过 `.blockmap`（否则查不到差量基准，退化为全量）；③ 本机更新缓存里有旧版安装包 `%LOCALAPPDATA%\qingframe-web-updater\installer.exe` —— 0.1.12 起应用会在每次下载完成后自动"留种"它，更早的版本需手工放入。任一前提缺失只会退化为全量下载，不会把更新装坏。
- **更新下载镜像（0.1.12 起）**：点"立即更新"时先对 GH_PROXIES 三个镜像实测速度、选最快者下载，失败自动换源重试；主进程日志 `[updater] 镜像测速(B/s)` 记录当时的实测值。镜像速度随时间剧烈波动（实测同一镜像一小时内可从 1.8MB/s 掉到连不上），排障"更新慢"时先看这一行。
