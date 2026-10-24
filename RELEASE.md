# 发布与自动更新流程（RELEASE 指南）

清框影的自动更新走 **electron-updater + GitHub Releases**（同 yt-dlp 的"查版本→下载→替换"思路）：

- 启动 3 秒后主进程静默 `checkForUpdates()`，发现新版本通过 `updater:event` 推送渲染层横幅（"发现新版本 vX.Y.Z，点击更新"）。
- 用户点"立即更新"→ `downloadUpdate()` 下载新安装包并显示进度条 → 下载完"立即重启"→ `quitAndInstall()` 安装生效。
- 版本源是 GitHub Releases 上的 `latest.yml`（由 electron-builder 在打包 NSIS 安装版时自动生成）。

## 一、为什么现在不能一键更新（缺什么）

代码层全部就绪（主进程 / preload / 渲染 UI / build.publish 配置）。真正缺的是**发布动作**：
GitHub Releases 里没有 `latest.yml` + 新版安装包，旧版就永远查不到更新。

## 二、签名发布（推荐，SignPath Foundation）

> **⚠ 当前状态（2026-10-24）：SignPath Foundation 申请被拒（缺少公众信任信号），签名流程暂停。**
> 在重新申请有结果之前，请继续使用下方「三、本地未签名发布」发版；
> `package.json` 中 `build.win` 的 `signtoolOptions.publisherName` 与 `verifyUpdateCodeSignature`
> 已暂时移除——否则新版本 `app-update.yml` 会强制校验 SignPath 签名，之后发未签名版本会导致
> 已装该版的用户自动更新验签失败。申请通过后再把这两项原样加回，并改走本节流程。

首个签名版本开始，Windows 发布走 GitHub Actions + SignPath Foundation。不要再使用本地未签名的 `release:publish` 发布新版本。签名政策、角色和验签说明见 [`CODE_SIGNING.md`](./CODE_SIGNING.md)。

**一次性准备**（详见 [`signpath/README.md`](./signpath/README.md)）：

- SignPath 通过 OSS 申请，项目链接 **GitHub.com** Trusted Build System，并安装 SignPath GitHub App。
- 在 SignPath 创建 `release-signing` 策略、`qingframe-app` 与 `qingframe-installers` 两个 artifact configuration，开启人工审批和 origin verification。
- GitHub 仓库 Actions secret：`SIGNPATH_API_TOKEN`。
- GitHub 仓库 Actions variables：`SIGNPATH_ORGANIZATION_ID`、`SIGNPATH_PROJECT_SLUG`、`SIGNPATH_SIGNING_POLICY_SLUG`、`SIGNPATH_APP_CONFIG_SLUG`、`SIGNPATH_INSTALLER_CONFIG_SLUG`。
- 维护者 GitHub 与 SignPath 账号都开启 MFA。

**每次发版**：

1. 在 `main` 上 bump `package.json` 版本号，提交并推送。
2. 打开 Actions → **Release (SignPath signed)** → Run workflow，选择 `main`，输入 `v<version>`（例如 `v0.1.18`）。
3. 工作流先构建未签名目录，提交 `Qingframe.exe` 给 SignPath；在 SignPath 后台人工批准第 1 个签名请求。
4. 工作流用签名后的 `Qingframe.exe` 打 NSIS/便携版，再提交安装包给 SignPath；人工批准第 2 个签名请求。
5. 工作流用签名后的安装包重算 `latest.yml` 和 `.blockmap`，验证三处签名与哈希，创建**草稿** Release。
6. 下载草稿产物，在本机验证安装、卸载、签名和 `latest.yml`。确认后手动发布 Release；发布后立即用旧版 0.1.17 验证自动更新（草稿不会出现在 GitHub 的 `/releases/latest`，所以真实更新链路只能在发布后测试；如失败，立即撤下该 Release 修复）。
7. 首个签名版本发布后，把 `README.md` 与 `CODE_SIGNING.md` 中“准备中/未签名”的状态说明改成已签名；同时更新 README 顶部的版本徽章。

> 工作流只从 `main` 运行，版本号与 tag 必须一致；草稿 Release 不会成为 electron-updater 的 `latest`，必须手动发布。
>
> 签名会改变文件字节，**不能**在 electron-builder 生成 `latest.yml`/`.blockmap` 之后手动补签而不重算元数据。本工作流已用 `tools/refresh-release-metadata.js` 处理。
>
> SignPath 可能拒绝重跑旧请求。签名请求超时或被拒时，重新跑一次新的 workflow，不要反复 rerun 旧 run。

## 三、本地未签名发布（旧流程，仅用于过渡/排障）

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

## 四、注意事项

- **portable 单文件版不是自动更新目标**：自动更新以 NSIS 安装版为准；便携版用户请到 GitHub Releases 手动下载新版。要"真·一键更新"就用 NSIS 安装版分发。
- **品牌 Logo 不进公开版**：`build.files` 已排除 `shared/brandlogos/**`，发布产物天然不含品牌 Logo 素材（商标/著作权考虑）。本地带 Logo 的包是单独打的，不走这个发布流程。
- **头像/用户名默认空**：打包产物不携带开发机的 userData（状态、头像、签名都留在本机 AppData），新用户安装后头像/用户名为空，符合发布要求。
- **发布无需本地跑**：`release:publish` 也可以在 GitHub Actions 上跑（配 GH_TOKEN secret），本地发布即可。
- **token 权限**：Personal Access Token 需要 `repo` 权限（创建 Release、上传 asset）。不要提交到 git。
- **差量更新（blockmap）**：electron-updater 会对比新旧安装包的数据块，只下载变化部分。三个前提：① 新版发布时上传 `.blockmap`（见上一步产物清单）；② 旧版发布时也上传过 `.blockmap`（否则查不到差量基准，退化为全量）；③ 本机更新缓存里有旧版安装包 `%LOCALAPPDATA%\qingframe-web-updater\installer.exe` —— 0.1.12 起应用会在每次下载完成后自动"留种"它，更早的版本需手工放入。任一前提缺失只会退化为全量下载，不会把更新装坏。
- **更新下载镜像（0.1.12 起）**：点"立即更新"时先对 GH_PROXIES 三个镜像实测速度、选最快者下载，失败自动换源重试；主进程日志 `[updater] 镜像测速(B/s)` 记录当时的实测值。镜像速度随时间剧烈波动（实测同一镜像一小时内可从 1.8MB/s 掉到连不上），排障"更新慢"时先看这一行。

## 五、macOS 构建（准备中）

macOS 目标已加入 `package.json` 的 `build.mac`：universal（Intel + Apple Silicon）DMG + ZIP，最低 macOS 10.15，ZIP 供 electron-updater 使用。

**本地/CI 未签名构建**（需要 macOS；Windows 不能交叉打包 DMG）：

```bash
npm ci
npm run check
npm run dist:mac
```

产物：

- `dist/Qingframe-<version>-universal.dmg`（手动安装）
- `dist/Qingframe-<version>-universal.zip`（自动更新用）
- `dist/latest-mac.yml`

仓库里新增了 `.github/workflows/build-macos.yml`，手动触发即可在 `macos-14` 上构建未签名产物并上传为 Actions artifact。未签名 DMG 在 Gatekeeper 下会被拦截，测试机可右键“打开”，或执行：

```bash
xattr -cr "/Applications/清框影.app"
```

**签名/公证（正式分发和自动更新必需）**：

- Apple Developer Program（Developer ID Application 证书）。
- GitHub Actions secrets / 本地环境：
  - `CSC_LINK`（.p12 的 base64 或路径）
  - `CSC_KEY_PASSWORD`
  - `APPLE_ID`
  - `APPLE_APP_SPECIFIC_PASSWORD`
  - `APPLE_TEAM_ID`
- 未签名构建显式设 `CSC_IDENTITY_AUTO_DISCOVERY=false`；正式构建不要设。
- 公证通过后，用户首次打开才不会被 Gatekeeper 拦；macOS 自动更新（Squirrel.Mac）也要求 app 已签名。

**发布顺序建议**：

1. 先跑 `Build macOS (unsigned)`，在真实 Mac 上验证界面、拖拽、导入/导出、HEIC、快捷键。
2. 拿到 Developer ID 后，在 macOS 上配置签名/公证，生成 `latest-mac.yml` 并创建 draft Release。
3. 发布前用旧版 macOS 安装包验证更新；未签名版本不要作为“支持自动更新”的正式版发布。
