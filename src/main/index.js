const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { createStateStore } = require('./state');

// 打包版与开发版数据隔离:发布版用独立 userData,首次启动头像/用户名等默认全空,
// 也不会读到开发机(含开发者自己)已保存的旧登录数据。
if (app.isPackaged) {
    app.setPath('userData', path.join(app.getPath('appData'), 'qingframe-web-release'));
}

// 渲染进程通过 qflocal:// 协议在磁盘上直接读取照片(不经过 base64 过 IPC,节省内存)
protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

// EXIF 解析:独立模块(src/main/exif-read.js)。只读文件头部而不整读照片,
// 拆出来是为了能用纯 node 直接验证"头部解析 == 整文件解析"。
const { readExif } = require('./exif-read');
// EXIF 写回:导出 JPEG 时把原图 EXIF 移植进成品(默认剥 GPS),任何失败静默回退。
const exifWrite = require('./exif-write');

if (!app.requestSingleInstanceLock()) {
    // 静默退出会把"我明明重启了却还是旧代码"变成一个查不出来的谜:
    // 单实例锁会让新进程直接自杀、只把旧窗口聚焦到前台 —— 而旧的**主进程**代码换不掉。
    // 踩过:改了 src/main 后 `npm start`,窗口照常出现,于是以为重启成功,实际跑的还是旧进程。
    // 这一行是纯 ASCII 副本,别删:start.bat 必须靠它判断"到底有没有启动"。
    // 它无法用中文那句来匹配 —— cmd 按控制台代码页解析 .bat(GBK),中文匹配串不可靠;
    // 而 Chromium 的 process_singleton 报错只在"锁文件建不出来"时才有,真的"已有实例"
    // 走的是静默退出分支,日志里一个 ASCII 标记都没有,只有下面这三行中文。
    console.warn('[qingframe] single-instance lock refused this launch.');
    console.warn('[清框影] 已有实例在运行,本次启动被忽略(单实例锁)。');
    console.warn('         要加载 src/main 的改动,必须先完全退出已有实例:');
    console.warn('         任务管理器里结束所有 Electron / 清框影 进程,再执行 npm start。');
    app.quit();
} else {
    const PRESETS_DIR = path.join(__dirname, '..', '..', 'shared', 'presets');
    const LOGOS_DIR = path.join(__dirname, '..', '..', 'shared', 'brandlogos');
    const TEXTURES_DIR = path.join(__dirname, '..', '..', 'shared', 'textures');
    const MARKS_DIR = path.join(__dirname, '..', '..', 'shared', 'marks');
    const TEMPLATES_DIR = path.join(app.getPath('userData'), 'templates');
    const { loadState, saveState, validDir, freeFilePath } = createStateStore(path.join(app.getPath('userData'), 'state.json'));

const createWindow = () => {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 640,
        title: '清框影 · 照片加框',
        backgroundColor: '#181B1A',
        icon: path.join(__dirname, 'icon.png'),
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    win.once('ready-to-show', () => win.show());
    return win;
};

app.whenReady().then(() => {
    protocol.handle('qflocal', (request) => {
        try {
            const u = new URL(request.url);
            const filePath = u.searchParams.get('p');
            if (!filePath || !fs.existsSync(filePath)) return new Response('Not Found', { status: 404 });
            return net.fetch(pathToFileURL(filePath).href);
        } catch (e) {
            return new Response('Not Found', { status: 404 });
        }
    });
    createWindow();

    // ── 自动更新:仅打包后(app.isPackaged)生效;启动静默检查,事件经 webContents 推给渲染进程做 UI ──
    //    updater 为 null 时(check-for-updates 等 IPC)一律返回"开发模式",避免 dev 下调用报错
    //    [v0.1.9] 国内网络优化:①检查更新加 20s 超时并推送明确提示;②安装包下载走 GitHub 加速镜像(可经 QINGFRAME_PROXY 环境变量覆盖)
    const CHECK_TIMEOUT_MS = 20000;
    const GH_PROXIES = process.env.QINGFRAME_PROXY
        ? [process.env.QINGFRAME_PROXY]
        : ['https://ghproxy.net', 'https://ghfast.top', 'https://gh-proxy.com'];
    // 镜像会随时间劣化(实测 ghproxy.net 2026-10 起常被限速到 40KB/s 级):下载前实测各镜像速度,
    // 把最快者写进 activeProxy;探测失败时回退用列表第一个。QINGFRAME_PROXY 指定时尊重用户选择。
    let activeProxy = null;
    const proxyFor = () => activeProxy || GH_PROXIES[0];
    const withTimeout = (promise, ms, label) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(
            () => reject(new Error(`${label}超时（${Math.round(ms / 1000)}s），GitHub 连接缓慢或不可达，请稍后重试或开启代理`)),
            ms
        ))
    ]);
    // 检查环节的镜像优选:检查请求固定按 GH_PROXIES 顺序走,首选镜像一旦劣化(实测 2026-10:
    // ghproxy.net 对 releases/latest 只回几字节垃圾),electron-updater 会把解析失败报成
    // "Cannot parse releases feed: Unable to find latest version on GitHub"。
    // 检查前并行探测各镜像,按列表顺序取第一个返回合法 JSON(tag_name)的写进 activeProxy;
    // 全部不可用则维持原顺序(检查照旧失败,推给 UI 的文案会被翻译成可读版本)。
    const CHECK_LATEST_URL = 'https://github.com/lumos-1s/Qing-Fram-Shadow-web/releases/latest';
    const CHECK_PROBE_TIMEOUT_MS = 5000;
    const probeProxyForCheck = async () => {
        if (GH_PROXIES.length < 2) return; // 用户用 QINGFRAME_PROXY 指定了镜像时尊重其选择
        const probe = async (proxy) => {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), CHECK_PROBE_TIMEOUT_MS);
            try {
                const res = await net.fetch(proxy + '/' + CHECK_LATEST_URL, {
                    headers: { Accept: 'application/json' },
                    signal: ac.signal
                });
                if (!res.ok) return null;
                const info = JSON.parse(await res.text());
                return (info && info.tag_name) ? proxy : null;
            } catch (_) {
                return null;
            } finally {
                clearTimeout(timer);
            }
        };
        const results = await Promise.all(GH_PROXIES.map((proxy) => probe(proxy)));
        const healthy = results.find((p) => p);
        if (healthy) {
            activeProxy = healthy;
            console.log('[updater] 检查镜像可用:', healthy);
        } else {
            console.warn('[updater] 所有检查镜像均不可用,按默认顺序尝试:', GH_PROXIES.join(', '));
        }
    };
    // 原始 feed 报错(JSON 解析栈)对用户不可读,推给 UI 时换成一句网络提示;日志仍保留原文
    const friendlyUpdaterError = (msg) => {
        const m = String(msg || '');
        if (m.includes('Cannot parse releases feed') || m.includes('Unable to find latest version') || m.includes('ERR_UPDATER_INVALID_RELEASE_FEED')) {
            return '无法连接 GitHub 更新源（镜像暂不可用）。请稍后重试，或到 GitHub Releases 手动下载新版';
        }
        return m || '网络异常';
    };
    // 下载环节把 GitHub 文件 URL 换成镜像前缀(镜像仅转发原文件,sha512 不变);patch 一次即可
    const patchGitHubDownloadProxy = () => {
        try {
            const ghMod = require('electron-updater/out/providers/GitHubProvider');
            const GHProvider = ghMod && ghMod.GitHubProvider;
            if (!GHProvider || GHProvider.prototype.__qfProxyPatched) return true;
            const orig = GHProvider.prototype.resolveFiles;
            GHProvider.prototype.resolveFiles = function (updateInfo) {
                const files = orig.call(this, updateInfo);
                const proxy = proxyFor();
                if (proxy && files && files.length) {
                    for (const f of files) {
                        // electron-updater 26 里 f.url 是 URL 实例(非字符串),要按 href 判断并重建 URL
                        const u = f && f.url;
                        const href = (typeof u === 'string') ? u : (u && u.href);
                        if (href && href.startsWith('https://github.com/')) {
                            const proxied = proxy + '/' + href;
                            f.url = (typeof u === 'string') ? proxied : new URL(proxied);
                        }
                    }
                }
                return files;
            };
            GHProvider.prototype.__qfProxyPatched = true;
            return true;
        } catch (e) {
            console.warn('[updater] 下载镜像 patch 失败:', e && e.message);
            return false;
        }
    };
    // 检查环节统一走 Provider.httpRequest(atom 源 / releases/latest / latest.yml)。
    // 直连 GitHub 在国内常被 HTTP/2 重置(net::ERR_HTTP2_PROTOCOL_ERROR),把 github.com 请求也换到镜像;
    // 镜像服务器在国外访问 GitHub,本地只连镜像,绕开被干扰的链路。
    // 实测(2026-10-10):ghproxy.net / ghfast.top / gh-proxy.com 对 /releases.atom 一律 403/404
    // (镜像只放行下载类路径),但 releases/latest(带 Accept:application/json)与 latest.yml 均 200。
    // 因此 atom 源不真的取:改用 releases/latest 的 tag_name/body 现拼一个最小 feed(见下),
    // 真实 tag、版本、更新说明全部来自服务端,检查链路即可全镜像跑通。
    // 这份静态 feed 只作动态取数失败时的兜底(更新检查不会因此断掉, 只是说明退回这条)。
    const FAKE_ATOM_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Qing-Fram-Shadow-web Releases</title>
  <entry>
    <title>新版本可用</title>
    <link href="https://github.com/lumos-1s/Qing-Fram-Shadow-web/releases/tag/v0.1.16"/>
    <content type="html">新增「摄影署名水印」「相机参数水印」预设; 相机参数水印支持背景模糊、圆角、图片缩放与参数字号; 修复「头像纪念」底部透明黑条</content>
  </entry>
</feed>`;
    const patchUpdateHttpRequests = () => {
        try {
            const provMod = require('electron-updater/out/providers/Provider');
            const ProviderCls = provMod && provMod.Provider;
            if (!ProviderCls || ProviderCls.prototype.__qfHttpPatched) return true;
            const origHttp = ProviderCls.prototype.httpRequest;
            const origCreateOpts = ProviderCls.prototype.createRequestOptions;
            // 镜像替换统一放在 createRequestOptions:httpRequest 与 GitHubProvider 的
            // fetchData(this.executor.request(channelFileUrl)) 两条链路都会经过它, 一处覆盖全部。
            ProviderCls.prototype.createRequestOptions = function (url, headers) {
                const proxy = proxyFor();
                if (proxy && url) {
                    const href = (typeof url === 'string') ? url : url.href;
                    if (href && href.startsWith('https://github.com/') && !/\/releases\.atom$/.test(href)) {
                        const proxied = proxy + '/' + href;
                        url = (typeof url === 'string') ? proxied : new URL(proxied);
                    }
                }
                return origCreateOpts.call(this, url, headers);
            };
            // atom 源:镜像不支持该路径(实测 403/404)。不返回写死的静态 feed, 而是用同一条
            // 镜像链路现取 releases/latest, 用 tag_name/body 拼一个最小 feed:
            // electron-updater 会把「链接匹配真实 tag 的条目」的 <content> 当更新说明(getNoteValue),
            // 动态生成后说明永远等于该 Release 的正文, 不会再显示检查方自带的旧文案。
            // 取数/解析失败时兜底返回静态 FAKE_ATOM_XML, 更新检查本身不受影响。
            ProviderCls.prototype.httpRequest = function (url, headers, cancellationToken) {
                if (url) {
                    const href = (typeof url === 'string') ? url : url.href;
                    if (href && /\/releases\.atom$/.test(href)) {
                        const esc = (s) => String(s == null ? '' : s)
                            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                        const base = href.replace(/\.atom$/, '');
                        return origHttp.call(this, base + '/latest', { Accept: 'application/json' }, cancellationToken)
                            .then((raw) => {
                                const info = JSON.parse(raw);
                                if (!info || !info.tag_name) throw new Error('releases/latest 无 tag_name');
                                return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Qing-Fram-Shadow-web Releases</title>
  <entry>
    <title>${esc(info.name || info.tag_name)}</title>
    <link href="${base}/tag/${esc(info.tag_name)}"/>
    <content type="html">${esc(info.body || '')}</content>
  </entry>
</feed>`;
                            })
                            .catch(() => FAKE_ATOM_XML);
                    }
                }
                return origHttp.call(this, url, headers, cancellationToken);
            };
            ProviderCls.prototype.__qfHttpPatched = true;
            return true;
        } catch (e) {
            console.warn('[updater] 检查镜像 patch 失败:', e && e.message);
            return false;
        }
    };

    // ── 更新下载提速:镜像测速优选 + 差量留种 ──
    // ① 下载前对各个镜像实测速度(与真实下载同路径:普通 GET,读满 512KB 即断),选最快者下载,
    //    失败时按速度顺序自动换源重试 —— 镜像速度随时间和线路剧烈波动(实测同一镜像一小时
    //    内从 1.8MB/s 跌到连不上),写死一个必踩坑;
    // ② 下载完成后把安装包复制成更新缓存里的 installer.exe:electron-updater 的差量下载
    //    (只下与旧版不同的数据块)需要它当"旧文件"基准,而工具链没有任何环节维护它,
    //    不主动留种的话差量只在第一次可用,之后就永远退化回整个 75MB 全量下载。
    const PROBE_BYTES = 512 * 1024;
    const PROBE_TIMEOUT_MS = 4000;
    const probeProxySpeed = async (proxy, githubUrl) => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
        const t0 = Date.now();
        let got = 0;
        try {
            const res = await net.fetch(proxy + '/' + githubUrl, { signal: ac.signal });
            if (res.ok) {
                const reader = res.body.getReader();
                while (got < PROBE_BYTES) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    got += value.length;
                }
                try { await reader.cancel(); } catch (_) { /* ignore */ }
            }
        } catch (_) { /* 超时/网络错:按已收字节折算速度 */ }
        finally { clearTimeout(timer); }
        return got >= 64 * 1024 ? Math.round(got / Math.max(Date.now() - t0, 1) * 1000) : 0; // B/s;收得太少视为失败
    };
    // 返回按实测速度降序的可用镜像列表;探测不出可用镜像时返回 null(调用方保持默认顺序)
    const rankProxies = async (githubUrl) => {
        if (!githubUrl || GH_PROXIES.length < 2) return null; // 用户用 QINGFRAME_PROXY 指定了镜像时尊重用户选择
        const byProxy = new Map();
        const all = Promise.all(GH_PROXIES.map(async (proxy) => {
            byProxy.set(proxy, await probeProxySpeed(proxy, githubUrl));
        }));
        // 早退:已有镜像达到"够快"标准就不必再等慢的(每 200ms 看一眼)
        await Promise.race([all, (async () => {
            for (let i = 0; i < Math.ceil(PROBE_TIMEOUT_MS / 200); i++) {
                await new Promise((r) => setTimeout(r, 200));
                let best = 0;
                for (const s of byProxy.values()) best = Math.max(best, s);
                if (best >= 768 * 1024) return;
            }
        })()]);
        const results = GH_PROXIES.map((proxy) => ({ proxy, speed: byProxy.get(proxy) || 0 }));
        console.log('[updater] 镜像测速(B/s):', results.map((r) => `${r.proxy}=${r.speed}`).join(', '));
        const usable = results.filter((r) => r.speed > 0).sort((a, b) => b.speed - a.speed);
        return usable.length ? usable.map((r) => r.proxy) : null;
    };
    // 差量留种:把刚下载的安装包复制为缓存 installer.exe(体积相同则跳过,避免每次下载都复制 75MB)
    const seedCachedInstaller = () => {
        try {
            const helper = updater && updater.downloadedUpdateHelper;
            const src = helper && helper.file;
            const cacheDir = helper && helper.cacheDir;
            if (!src || !cacheDir || !fs.existsSync(src)) return;
            const dest = path.join(cacheDir, 'installer.exe');
            if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size) return;
            fs.copyFileSync(src, dest);
            console.log('[updater] 已留种缓存 installer.exe,下次更新可走差量:', dest);
        } catch (e) {
            console.warn('[updater] 差量留种失败(忽略):', e && e.message);
        }
    };
    let updater = null;
    if (app.isPackaged) {
        // portable 单文件版不生成 app-update.yml,electron-updater 读取时会抛
        // ENOENT 导致启动后弹"检查更新失败";没有该文件就直接跳过自动更新。
        const updateYml = path.join(process.resourcesPath, 'app-update.yml');
        if (!fs.existsSync(updateYml)) {
            console.warn('[updater] 未发现 app-update.yml(portable 版),自动更新已跳过');
        } else {
        try {
            const { autoUpdater } = require('electron-updater');
            updater = autoUpdater;
            autoUpdater.autoDownload = false; // 发现新版后由用户点按钮再下载
            patchGitHubDownloadProxy();
            patchUpdateHttpRequests();
            const pushUpdater = (type, payload) => {
                const w = BrowserWindow.getAllWindows()[0];
                if (w && !w.isDestroyed()) w.webContents.send('updater:event', Object.assign({ type }, payload || {}));
            };
            autoUpdater.on('update-available', (info) => pushUpdater('available', { version: info && info.version, releaseNotes: info && (info.releaseNotes || info.releaseNotesString) }));
            autoUpdater.on('update-not-available', () => pushUpdater('not-available'));
            autoUpdater.on('download-progress', (p) => pushUpdater('progress', { percent: p && p.percent, speed: p && p.bytesPerSecond }));
            autoUpdater.on('update-downloaded', () => pushUpdater('downloaded'));
            autoUpdater.on('error', (err) => { console.warn('[updater]', err && err.message); pushUpdater('error', { message: friendlyUpdaterError(err && err.message) }); });
            // 启动后延迟静默检查,避免拖慢首屏;国内网络慢,加超时兜底(失败静默,不打扰首屏)
            setTimeout(() => {
                probeProxyForCheck()
                    .catch(() => {})
                    .then(() => withTimeout(autoUpdater.checkForUpdates(), CHECK_TIMEOUT_MS, '检查更新'))
                    .catch(() => {});
            }, 3000);
        } catch (e) {
            console.warn('[updater] 初始化失败:', e && e.message);
        }
        }
    }
    ipcMain.handle('check-for-updates', async () => {
        if (!updater) return { ok: false, message: '当前为便携版,不支持在线自动更新,请到 GitHub Releases 下载新版' };
        try {
            await probeProxyForCheck().catch(() => {});
            await withTimeout(updater.checkForUpdates(), CHECK_TIMEOUT_MS, '检查更新');
            return { ok: true };
        } catch (e) {
            const msg = friendlyUpdaterError(e && e.message);
            // 手动点"检查更新"时,超时/失败也要让更新横幅可见并带"重试"按钮
            try {
                const w = BrowserWindow.getAllWindows()[0];
                if (w && !w.isDestroyed()) w.webContents.send('updater:event', { type: 'error', message: msg });
            } catch (_) { /* ignore */ }
            return { ok: false, message: msg };
        }
    });
    let updateDownloadInFlight = false; // 防连点:测速+下载+自动重试全程只允许一个在飞
    ipcMain.handle('start-update-download', async () => {
        if (!updater) return { ok: false, message: '当前为便携版,不支持在线自动更新,请到 GitHub Releases 下载新版' };
        if (updateDownloadInFlight) return { ok: false, message: '更新下载已在进行中' };
        updateDownloadInFlight = true;
        try {
            // 先让横幅进入"下载中"状态:镜像测速最多要几秒,不能看起来像点了没反应
            try {
                const w = BrowserWindow.getAllWindows()[0];
                if (w && !w.isDestroyed()) w.webContents.send('updater:event', { type: 'progress', percent: 0, speed: 0 });
            } catch (_) { /* ignore */ }
            // ① 下载前镜像测速,选最快者下载;② 下载失败时按速度顺序自动换源重试
            let candidates = null;
            try {
                const info = updater.updateInfoAndProvider && updater.updateInfoAndProvider.info;
                const file = info && Array.isArray(info.files) ? info.files[0] : null;
                if (info && file) {
                    const raw = (typeof file.url === 'string') ? file.url : (file.url && file.url.href);
                    const githubUrl = /^https?:\/\//.test(raw || '')
                        ? raw
                        : `https://github.com/lumos-1s/Qing-Fram-Shadow-web/releases/download/${info.tag}/${raw}`;
                    candidates = await rankProxies(githubUrl);
                    if (candidates) activeProxy = candidates[0];
                }
            } catch (e) {
                console.warn('[updater] 镜像测速失败(继续用默认顺序):', e && e.message);
            }
            let lastErr = null;
            try {
                await updater.downloadUpdate();
            } catch (e) {
                lastErr = e;
            }
            while (lastErr && candidates && candidates.length > 1) {
                candidates = candidates.slice(1);
                activeProxy = candidates[0];
                console.warn('[updater] 下载失败,自动换镜像重试:', activeProxy, '-', lastErr.message);
                try {
                    await updater.downloadUpdate();
                    lastErr = null;
                } catch (e2) {
                    lastErr = e2;
                }
            }
            if (lastErr) return { ok: false, message: lastErr && lastErr.message };
            seedCachedInstaller();
            return { ok: true };
        } finally {
            updateDownloadInFlight = false;
        }
    });
    ipcMain.handle('quit-and-install', () => {
        if (updater) { try { updater.quitAndInstall(); } catch (e) { console.warn('[updater] quitAndInstall:', e && e.message); } }
        return { ok: true };
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('list-presets', () => {
    try {
        if (!fs.existsSync(PRESETS_DIR)) return [];
        return fs.readdirSync(PRESETS_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace(/\.json$/, ''));
    } catch (e) { return []; }
});

// ── 诊断日志:应用信息 + 渲染层操作日志导出(报 bug 时一键提供,同 yt-dlp --verbose 思路) ──
ipcMain.handle('get-app-info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    userData: app.getPath('userData'),
    appPath: app.getAppPath()
}));
// 导出完成后在资源管理器中显示文件/目录(不再只显示一串路径文本)
ipcMain.handle('show-item-in-folder', (_e, p) => {
    try {
        if (!p) return { ok: false };
        const stat = fs.statSync(p);
        if (stat.isDirectory()) { shell.openPath(p); return { ok: true, opened: 'dir' }; }
        shell.showItemInFolder(p);
        return { ok: true, opened: 'file' };
    } catch (e) { return { ok: false, message: e && e.message }; }
});

ipcMain.handle('save-diagnostics', async (_e, text) => {
    try {
        const r = await dialog.showSaveDialog({
            title: '保存诊断日志',
            defaultPath: path.join(app.getPath('documents'), '清框影诊断日志.txt'),
            filters: [{ name: '文本文件', extensions: ['txt'] }]
        });
        if (r.canceled || !r.filePath) return { ok: false, canceled: true };
        fs.writeFileSync(r.filePath, String(text || ''), 'utf-8');
        return { ok: true, path: r.filePath };
    } catch (e) { return { ok: false, message: e && e.message }; }
});

ipcMain.handle('load-preset', (_e, name) => {
    try {
        const p = path.join(PRESETS_DIR, name + '.json');
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) { return null; }
});

// 启动时要读全部预设:原来 list-presets + 逐个 load-preset = 78 次 IPC 往返,每次都在主进程
// 做一次 existsSync + readFileSync 且串行。合并成一次往返,盘上并发读。
ipcMain.handle('load-all-presets', async () => {
    try {
        if (!fs.existsSync(PRESETS_DIR)) return [];
        const names = fs.readdirSync(PRESETS_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace(/\.json$/, ''));
        const list = await Promise.all(names.map(async (name) => {
            try {
                const txt = await fs.promises.readFile(path.join(PRESETS_DIR, name + '.json'), 'utf-8');
                return { name, data: JSON.parse(txt) };
            } catch (e) { return null; }
        }));
        return list.filter(Boolean);
    } catch (e) { return []; }
});

// 扩展名 → MIME(src/main/image-mime.js,独立成模块便于纯 node 验证)
const { imageMimeOf } = require('./image-mime');
const readImagesAsDataUrls = (dir, exts) => {
    try {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir)
            .filter(f => exts.some(ext => f.toLowerCase().endsWith(ext)))
            .map(f => {
                const full = path.join(dir, f);
                const buf = fs.readFileSync(full);
                return { name: f.replace(/\.\w+$/, ''), dataUrl: `data:${imageMimeOf(f)};base64,${buf.toString('base64')}` };
            });
    } catch (e) { return []; }
};

// 静态资源进程内缓存:品牌logo/纹理/标记都是只读资源,每次启动重复读盘+base64 是启动慢的主因之一。
// 失效策略:按目录内每个文件的 mtime 做摘要,任何文件增删/修改都会触发重建(代价只是几十次 stat)。
const _staticCache = new Map();
const cachedImages = (key, dir, exts) => {
    let sig = '';
    try {
        sig = fs.readdirSync(dir)
            .map(f => f + ':' + fs.statSync(path.join(dir, f)).mtimeMs)
            .sort().join('|');
    } catch (_) { sig = 'missing'; }
    const c = _staticCache.get(key);
    if (c && c.sig === sig) return c.data;
    const data = readImagesAsDataUrls(dir, exts);
    _staticCache.set(key, { sig, data });
    return data;
};
ipcMain.handle('list-logos', () => cachedImages('logos', LOGOS_DIR, ['.png', '.jpg', '.jpeg']));

// 内置自定义图标库。种子 shared/custom-icons.json 只读,实际读写走 userData 下的副本 ——
// 打包后种子在 app.asar 里是只读的,就地改必然失败(见 custom-icons.js 顶部注释)。
const { createCustomIconStore } = require('./custom-icons');
const customIcons = createCustomIconStore(
    path.join(app.getPath('userData'), 'custom-icons.json'),
    path.join(__dirname, '..', '..', 'shared', 'custom-icons.json')
);

ipcMain.handle('list-custom-icons', () => customIcons.list());

// 删除/重命名自定义图标:同步写盘,否则初始库图标重启后复活
ipcMain.handle('delete-custom-icon', (_e, dataUrl) => customIcons.remove(dataUrl));
ipcMain.handle('rename-custom-icon', (_e, dataUrl, name) => customIcons.rename(dataUrl, name));

ipcMain.handle('list-textures', () => cachedImages('textures', TEXTURES_DIR, ['.png', '.jpg', '.jpeg']));

// 内置原创标记(shared/marks,随包分发)。全部是项目自绘的几何/排版图形,
// 不含任何第三方品牌素材 —— 品牌 logo 因商标/著作权原因不随发行版分发,见 OPTIMIZATIONS.md。
ipcMain.handle('list-marks', () => cachedImages('marks', MARKS_DIR, ['.svg', '.png']));

const ensureTemplatesDir = () => {
    if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
    return TEMPLATES_DIR;
};

ipcMain.handle('save-template', (_e, { name, data }) => {
    try {
        if (!name) return { ok: false, error: '模板名称为空' };
        ensureTemplatesDir();
        const safe = String(name).replace(/[\\:*?"<>|/]/g, '_');
        fs.writeFileSync(path.join(TEMPLATES_DIR, safe + '.json'), JSON.stringify(data, null, 2), 'utf-8');
        return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('list-templates', () => {
    try {
        ensureTemplatesDir();
        return fs.readdirSync(TEMPLATES_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace(/\.json$/, ''));
    } catch (e) { return []; }
});

ipcMain.handle('load-template', (_e, name) => {
    try {
        const p = path.join(TEMPLATES_DIR, name + '.json');
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) { return null; }
});

ipcMain.handle('delete-template', (_e, name) => {
    try {
        const p = path.join(TEMPLATES_DIR, name + '.json');
        if (fs.existsSync(p)) fs.unlinkSync(p);
        return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('rename-template', (_e, { oldName, newName }) => {
    try {
        if (!oldName || !newName) return { ok: false, error: '模板名称为空' };
        const from = path.join(TEMPLATES_DIR, String(oldName).replace(/[\\:*?"<>|/]/g, '_') + '.json');
        const to = path.join(TEMPLATES_DIR, String(newName).replace(/[\\:*?"<>|/]/g, '_') + '.json');
        if (!fs.existsSync(from)) return { ok: false, error: '源模板不存在' };
        if (fs.existsSync(to)) return { ok: false, error: '已存在同名模板' };
        fs.renameSync(from, to);
        return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('export-template', async (_e, { name, data }) => {
    const st = loadState();
    const baseName = (name || 'template') + '.json';
    const def = validDir(st.lastExportDir) ? path.join(st.lastExportDir, baseName) : baseName;
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出模板',
        defaultPath: def,
        filters: [{ name: 'JSON 模板', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        saveState({ lastExportDir: path.dirname(filePath) });
        return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('import-template', async () => {
    const st = loadState();
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '导入模板',
        defaultPath: validDir(st.lastOpenDir) ? st.lastOpenDir : undefined,
        filters: [{ name: 'JSON 模板', extensions: ['json'] }],
        properties: ['openFile']
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    try {
        const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf-8'));
        saveState({ lastOpenDir: path.dirname(filePaths[0]) });
        return { ok: true, name: path.basename(filePaths[0], '.json'), data };
    } catch (e) { return { ok: false, error: '模板格式错误：' + e.message }; }
});

// ── .qfs 工程文件:自包含单文件(模板 + 源照片 + 每图模板,照片以 base64 内嵌) ──
ipcMain.handle('export-qfs', async (_e, data) => {
    const st = loadState();
    const baseName = (data && data.name ? String(data.name) : '未命名工程') + '.qfs';
    const def = validDir(st.lastExportDir) ? path.join(st.lastExportDir, baseName) : baseName;
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出工程 (.qfs)',
        defaultPath: def,
        filters: [
            { name: '清框影工程 (*.qfs)', extensions: ['qfs'] },
            { name: 'JSON', extensions: ['json'] }
        ]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        saveState({ lastExportDir: path.dirname(filePath) });
        return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('open-qfs', async () => {
    const st = loadState();
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '打开工程 (.qfs)',
        defaultPath: validDir(st.lastOpenDir) ? st.lastOpenDir : undefined,
        filters: [
            { name: '清框影工程 (*.qfs)', extensions: ['qfs'] },
            { name: 'JSON', extensions: ['json'] }
        ],
        properties: ['openFile']
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    try {
        const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf-8'));
        saveState({ lastOpenDir: path.dirname(filePaths[0]) });
        return { ok: true, name: path.basename(filePaths[0], path.extname(filePaths[0])), data };
    } catch (e) { return { ok: false, error: '工程文件格式错误：' + e.message }; }
});

ipcMain.handle('get-user', () => {
    const st = loadState();
    return st.user || null;
});

ipcMain.handle('save-user', (_e, user) => {
    saveState({ user });
    return { ok: true };
});

ipcMain.handle('logout-user', () => {
    saveState({ user: null });
    return { ok: true };
});

// 界面偏好(导出质量等),与用户资料分开存
ipcMain.handle('get-prefs', () => {
    const st = loadState();
    return st.prefs || {};
});

ipcMain.handle('save-prefs', (_e, prefs) => {
    if (prefs && typeof prefs === 'object') saveState({ prefs });
    return { ok: true };
});

ipcMain.handle('open-image', async () => {
    const st = loadState();
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择照片',
        defaultPath: validDir(st.lastOpenDir) ? st.lastOpenDir : undefined,
        filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
        properties: ['openFile']
    });
    if (canceled || filePaths.length === 0) return null;
    saveState({ lastOpenDir: path.dirname(filePaths[0]) });
    const fp = filePaths[0];
    return { name: path.basename(fp), path: fp, size: fs.statSync(fp).size, exif: await readExif(fp) };
});

ipcMain.handle('open-images', async () => {
    const st = loadState();
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择照片（可多选，第一张会成为当前主图）',
        defaultPath: validDir(st.lastOpenDir) ? st.lastOpenDir : undefined,
        filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
        properties: ['openFile', 'multiSelections']
    });
    if (canceled || !filePaths.length) return null;
    saveState({ lastOpenDir: path.dirname(filePaths[0]) });
    // 并发解析 EXIF:头部读取后单张约 1ms,但串行 await 会线性累加(Promise.all 保序)
    const items = await Promise.all(filePaths.map(async (fp) => ({
        name: path.basename(fp), path: fp, size: fs.statSync(fp).size, exif: await readExif(fp)
    })));
    return items;
});

ipcMain.handle('read-exif', (_e, filePath) => readExif(String(filePath || '')));

// 贴纸 / 自定义图标:体积小且须内嵌进模板(导出/导入不丢),仍走 base64 dataUrl
ipcMain.handle('open-sticker-image', async () => {
    const st = loadState();
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择贴纸 / 图标图片',
        defaultPath: validDir(st.lastOpenDir) ? st.lastOpenDir : undefined,
        filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
        properties: ['openFile']
    });
    if (canceled || filePaths.length === 0) return null;
    saveState({ lastOpenDir: path.dirname(filePaths[0]) });
    const fp = filePaths[0];
    return { name: path.basename(fp), data: fs.readFileSync(fp).toString('base64') };
});

ipcMain.handle('save-image-base64', async (_e, { data, filename }) => {
    const st = loadState();
    const dir = validDir(st.lastExportDir) ? st.lastExportDir : null;
    // 目标目录已有同名文件时自动加号,再次导出数字继续递增
    const def = dir ? freeFilePath(dir, filename) : filename;
    // 默认过滤器跟随目标文件名扩展名:此前 PNG 恒排第一,导 JPG/WebP 时保存框先显示「PNG 图片」,
    // 一路回车就会拿到扩展名与内容不一致的文件。
    const ext = String(path.extname(filename || '') || '.png').slice(1).toLowerCase();
    const allFilters = [
        { name: 'PNG 图片', extensions: ['png'] },
        { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] },
        { name: 'WebP 图片', extensions: ['webp'] }
    ];
    const matchFilter = allFilters.find(f => f.extensions.indexOf(ext) >= 0);
    const filters = matchFilter ? [matchFilter].concat(allFilters.filter(f => f !== matchFilter)) : allFilters;
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出图片',
        defaultPath: def,
        filters: filters
    });
    if (canceled || !filePath) return false;
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
    saveState({ lastExportDir: path.dirname(filePath) });
    return true;
});

ipcMain.handle('save-images-batch', async (_e, files) => {
    // files: [{ data, filename }]
    let dir = null;
    const st = loadState();
    try {
        const res = await dialog.showOpenDialog({
            title: '选择导出目录',
            defaultPath: validDir(st.lastExportDir) ? st.lastExportDir : undefined,
            properties: ['openDirectory', 'createDirectory']
        });
        if (res.canceled || !res.filePaths.length) return { canceled: true };
        dir = res.filePaths[0];
    } catch (e) { return { canceled: true, error: String(e) }; }
    saveState({ lastExportDir: dir });
    let ok = 0, fail = 0;
    const written = new Set();
    try {
        for (const f of files) {
            if (!f || !f.data) { fail++; continue; }
            try {
                // 目录里已有同名文件(含本次已写入)时自动加号
                const dest = freeFilePath(dir, f.filename, written);
                fs.writeFileSync(dest, Buffer.from(f.data, 'base64'));
                written.add(path.basename(dest));
                ok++;
            } catch (e) { fail++; }
            // 必须用 handler 的形参(_e);这里原来写的是不存在的 `event`,
            // 一进循环就抛 ReferenceError 并被外层 catch 吞掉 → 只写完第 1 个文件。
            _e.sender.send('export-progress', { done: ok + fail, total: files.length });
        }
    } catch (e) { return { ok, fail, error: String(e) }; }
    return { ok, fail, dir };
});

// 先选好保存位置再导出:多文件选目录,单文件选文件(带默认文件名)
ipcMain.handle('pick-export-location', async (_e, { count, hintName }) => {
    const st = loadState();
    const dir0 = validDir(st.lastExportDir) ? st.lastExportDir : undefined;
    if (count > 1) {
        const res = await dialog.showOpenDialog({
            title: '选择导出目录',
            defaultPath: dir0,
            properties: ['openDirectory', 'createDirectory']
        });
        if (res.canceled || !res.filePaths.length) return { canceled: true };
        const dir = res.filePaths[0];
        saveState({ lastExportDir: dir });
        return { mode: 'dir', dir };
    }
    const def = dir0 ? freeFilePath(dir0, hintName || 'photo.jpg') : (hintName || 'photo.jpg');
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出图片',
        defaultPath: def,
        filters: [
            { name: 'PNG 图片', extensions: ['png'] },
            { name: 'JPEG 图片', extensions: ['jpg'] },
            { name: 'WebP 图片', extensions: ['webp'] }
        ]
    });
    if (canceled || !filePath) return { canceled: true };
    // 用户手敲文件名没带扩展名时,按默认导出格式补全,避免写出无法打开的无后缀文件
    let fp = filePath;
    if (!/\.[a-zA-Z0-9]{1,5}$/.test(fp)) {
        const ext0 = (hintName.match(/\.[^.]+$/) || ['.png'])[0];
        fp += ext0;
    }
    saveState({ lastExportDir: path.dirname(fp) });
    return { mode: 'file', filePath: fp };
});

// 把已渲染好的导出数据写入选好的位置。
// 条目带 originalPath 时,经 exif-write 把原图 EXIF 移植进 JPEG 字节(失败静默回退为原字节)。
ipcMain.handle('write-export-files', async (event, { location, files }) => {
    if (!location || !files || !files.length) return { ok: 0, fail: files ? files.length : 0 };
    if (location.mode === 'file') {
        try {
            fs.writeFileSync(location.filePath, await exifWrite.applyExifToExportItem(files[0]));
            event.sender.send('export-progress', { done: 1, total: 1 });
            return { ok: 1, fail: 0 };
        } catch (e) {
            return { ok: 0, fail: 1, error: String(e) };
        }
    }
    let ok = 0, fail = 0;
    const written = new Set();
    try {
        for (const f of files) {
            // 空 data/bytes 也算一格并上报,否则 done 会卡在倒数一格不动
            if (!f || (!f.data && !f.bytes)) { fail++; }
            else {
                try {
                    const destDir = (f.subdir && String(f.subdir).trim()) ? path.join(location.dir, String(f.subdir).trim()) : location.dir;
                    if (destDir !== location.dir) fs.mkdirSync(destDir, { recursive: true });
                    const dest = freeFilePath(destDir, f.filename || (f.stem + '.' + f.ext), written);
                    fs.writeFileSync(dest, await exifWrite.applyExifToExportItem(f));
                    written.add(path.basename(dest));
                    ok++;
                } catch (e) { fail++; }
            }
            // 目录分支原来不发这个事件,渲染层 onExportProgress 永远收不到 →
            // 九宫格批量导出的进度条永远停在 2% / 「写盘 0/N」。逐张上报。
            event.sender.send('export-progress', { done: ok + fail, total: files.length });
        }
    } catch (e) { return { ok, fail, error: String(e) }; }
    return { ok, fail };
});

    app.on('second-instance', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });
}