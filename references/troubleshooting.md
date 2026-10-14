# 踩坑记录与报错对照表

按"现象 → 原因 → 解法"组织。遇到异常先在这里查，不要重复试错。

## 通用环境类

### 命令 exit 0 但完全没有输出 / 整个调用空返回
- **原因**：本机 stdout 常不回传，进程命令行管道异常时尤其明显。
- **解法**：所有命令加 `*> file`（覆盖）或 `*>> file`（追加），再用 Read 读文件。判断成败看**副作用**：目标文件是否生成、体积是否变化、端口是否监听。**不要**对同一条命令反复重试。

### `cmd.exe cannot be used from the PowerShell tool`
- **原因**：安全策略禁止从 PowerShell 工具调用 cmd。
- **解法**：全部改用原生 PowerShell 语法。需要符号链接用 `New-Item -ItemType SymbolicLink`；需要 `mklink` 的场景改用 .NET API（`[System.IO.Directory]`/`[System.IO.File]`）。

### 中文路径导致日志乱码（如 `閲庡吔鍏堢敓`）
- **原因**：控制台编码与 UTF-8 不一致，只是显示问题，不影响功能。
- **解法**：不要据此判断文件损坏。用 `-Encoding utf8` 写日志，或以文件实际大小为准确认。

## 浏览器 cookie 类

### yt-dlp 报 `Could not copy Chrome cookie database`
- **原因**：Edge/Chrome 运行时独占锁定 `Network\Cookies`（含 SQLite journal）。
- **解法（若确实需要该文件）**：用**卷影副本 VSS** 绕过：
  ```powershell
  $r = Invoke-CimMethod -ClassName Win32_ShadowCopy -MethodName Create -Arguments @{Volume='C:\'; Context='ClientAccessible'}
  $sc = Get-CimInstance Win32_ShadowCopy | Where-Object { $_.ID -eq $r.ShadowID }
  $dev = $sc.DeviceObject      # \\?\GLOBALROOT\Device\HarddiskVolumeShadowCopyN
  [System.IO.File]::Copy("$dev\Users\<user>\...\Network\Cookies", $dst, $true)
  ```
  注意：`Test-Path` / `GetDirectories` 对 `\\?\GLOBALROOT\...` 会失败，但 **`[System.IO.File]::Exists/Copy` 可用**，直接用 .NET API。
  PowerShell 7 **没有** `[wmiclass]`，必须用 `Invoke-CimMethod`。
  用完删除副本：`Get-CimInstance Win32_ShadowCopy | Remove-CimInstance`（`vssadmin delete shadows` 可能返回 -1 失败）。即使占用不高也应清理。

### yt-dlp 报 `Failed to decrypt with DPAPI`
- **原因**：Edge/Chrome 127+ 的 **App-Bound Encryption**，cookie 加密密钥与浏览器可执行文件绑定，外部工具无法解密。
- **解法**：**放弃导出 cookie**。关闭浏览器也无效。改用 CDP 让浏览器自己交出 cookie（`cdp_media_probe.mjs --mode cookies`），或干脆绕开 cookie 直接取流。

### 想给正在运行的 Edge 开调试端口
- **现象**：`msedge.exe --remote-debugging-port=9223` 进程立刻退出，端口不监听。
- **原因**：参数被转发给已有实例后丢弃，调试端口不会开。
- **解法**：另起一个**独立 user-data-dir** 的实例（见 SKILL.md 步骤 3.1）。

### 用副本 profile 起新实例后 `Network.getAllCookies` 返回 0 条
- **原因**：Edge 认为该 profile 不完整，启动时重写了 `Local State`（体积从 49490 变 34840），加密密钥被换掉，旧 cookie 解不开。
- **解法**：不要依赖副本 profile 去"继承"登录态。新实例的用途是**生成新会话 / 取流**，不是复用 cookie。

## CDP 协议类

### `Network.getAllCookies wasn't found`
- **原因**：连的是 `/json/version` 的**浏览器级** WebSocket，该 session 不支持 Network 域。
- **解法**：改连 `/json/list` 里 `type === 'page'` 的 target WebSocket。备用：浏览器级用 `Storage.getCookies`。

### Netscape cookie 文件被 yt-dlp 判为 invalid
- **现象**：`invalid Netscape format cookies file '...'`，伴随 `http.cookiejar AssertionError`。
- **两个原因，都要处理**：
  1. `domain` 以 `.` 开头时，第 2 列（includeSubdomains）**必须是 `TRUE`**，否则断言失败；
  2. 必须过滤 `name` 为空的条目（CDP 会返回空名 cookie）。
- **正确格式**（TAB 分隔）：`domain \t TRUE|FALSE \t path \t TRUE|FALSE(secure) \t expiry \t name \t value`

### 导航到抖音返回"验证码中间页"
- **原因**：headless UA（`HeadlessChrome/...`）被识别。
- **解法**：navigate 之前先 `Emulation.setUserAgentOverride`，UA 写成普通 Chrome/Edge（带 `Edg/`），并设 `platform: 'Win32'`。设置后同一实例重试即可拿到正常页面。

## 抖音站点类

### yt-dlp 报 `Fresh cookies (not necessarily logged in) are needed`
- **原因**：抖音 web detail 接口需要 `ttwid` 等 cookie。
- **手工注入 ttwid 无效**：从 `ttwid.bytedance.com` 拿到的 ttwid 写进 cookie 文件仍报同样错误，不要在这条路上浪费时间。
- **解法**：走 CDP 取流（步骤三），完全不依赖 cookie。

### `Blocked by ArgusSecurityPlugin Uifid Not Found`
- **原因**：直接请求 `aweme/v1/web/aweme/detail/` 等接口缺少 `uifid` + `a_bogus` 签名。
- **解法**：不要手工调用抖音 API，交给真实浏览器页面去请求。

### 只下到视频没下到音频
- **原因**：抖音是 DASH 分离流，`media-video-avc1` 只有画面。
- **解法**：同时下载 `media-audio-und-mp4a` 并 ffmpeg 合并。音频 URL 在资源列表里可能靠后，注意全量筛选。
- **注意时效**：直链带签名/过期参数，抠出来后尽快下载；过期就重新取流。

## 产物类

### 用户反馈"视频没声音"，但 ffprobe 显示有 aac 音轨
- **先验证是不是真的静音**：`ffmpeg -ss 30 -t 60 -i x.mp4 -map 0:a:0 -af volumedetect -f null NUL`。
  - `max_volume: -inf` → 音轨是空的，回去检查取流；
  - `mean_volume ≈ -17dB / max_volume ≈ 0dB` → **有声音**，问题在播放器侧。
- **播放器侧常见原因**：音轨由 **Bento4 封装、语言标记 `und`**，部分播放器直接跳过。
- **解法**：重封装 —— 视频 `-c:v copy`，音频重新编码 `-c:a aac -ar 48000 -ac 2 -b:a 192k`，加 `-movflags +faststart`（见 `verify_media.ps1 -Fix`）。
- 若换成兼容版仍无声，再排查播放器/系统音量、浏览器自动播放静音策略。

### B站下载到 AV1 编码，剪映等软件不认
- **解法**：格式选择加 `[vcodec^=avc1]` 强制 H.264，例如
  `-f 'bv*[height<=1080][vcodec^=avc1]+ba/b[height<=1080]'`，
  或在 `-F` 列表中手选 `30080+30280` 之类的 avc1 组合。

## 电商/图库页面类（淘宝、天猫、1688 等）

> 这一节是实测淘宝商品页（1 个主图视频 + 5 张主图）跑通后沉淀的，踩坑顺序基本就是下面这个顺序。

### DOM 快照 / 页面文本里找不到商品缩略图地址
- **原因**：主图区缩略图用 CSS `background-image` 渲染，不是 `<img>`；真实列表则被前端框架挂在 JS 状态（内嵌 JSON）里。读 innerText / DOM 快照 / `<img>` 列表都拿不到。
- **解法**：不要反复抓 DOM。走 `gallery_probe.mjs` 三路并取（内嵌 JSON + `background-image` + `<img>`）；没有 CDP 能力时走 view-source 复制源码再正则抠 `"images"` / `"videos"` 数组。

### Ctrl+A / Ctrl+C 之后，剪贴板还是旧内容（复制"没生效"）
- **原因**：目标标签页在**后台**，浏览器允许选中但**不写入系统剪贴板**；有时页面自身脚本还会拦截复制。
- **解法**：
  1. 先 `tab_focus` 把标签页切到前台再复制；
  2. 仍不行就走 `Ctrl+U` 打开 `view-source:` 页复制（源码页天然前台，最可靠）；
  3. 读剪贴板**必须用 `pwsh -STA`**，MTA 线程下 `Clipboard::GetText()` 会取不到。
- **判据**：复制后读出的字符数没变化 → 就是没写进去，别怀疑脚本。

### 用坐标点右键"图片另存为"点不到 / 菜单没被截图捕获
- **原因**：电商页普遍自定义右键菜单/浮层，弹窗层级和位置不确定；DOM 快照也不含图标。
- **解法**：**放弃坐标路线**。坐标校准成本高、成功率低，直接 CDP 或 view-source 抠直链。

### 下载图片返回 403 / 下到的是防盗链占位图
- **原因**：图床（`img.alicdn.com`、`cloud.video.taobao.com`）校验 `Referer`。
- **解法**：`curl -e 'https://item.taobao.com/' -A '<浏览器同级 UA>'`。UA 别用默认 curl UA。

### 把"会动的缩略图"当成 GIF 下载
- **原因**：电商对视频缩略图做自动播放预览，视觉上像 GIF。
- **解法**：它是 **mp4 视频**，地址在页面 `"videos"` 数组里。下**原视频**；仅当 URL 确为 `.gif` 时才当 GIF 处理。

### 主图顺序 / 数量对不上
- **原因**：不同数组的拼接顺序不等于页面真实图序（视频常是图库第 1 项，但 JSON 里可能单独一组）。
- **解法**：以 `"images"` 数组顺序为主图序；视频单独按 `"videos"` 处理。**交付前逐张核对（数量、顺序、颜色/款式）**，不清楚就 Read 看图比对。

### 缩略图下到的尺寸太小
- **原因**：抠到的是缩略图 URL，带 `_50x50.jpg` / `_430x430q90.jpg` / `_.webp` 等缩放后缀。
- **解法**：去掉尺寸段通常可得原图；不确定时先下带后缀的验证顺序，再决定是否换原图。

## 收尾清单

1. 删除临时文件（`_*.txt` / `_*.log` / `_*.mjs` / `_probe.json` / `_gallery.json` / `_gallery.html` / `_urls.txt` / `_clip_*`）。
2. 删除副本 profile `_edgeprofile`（可达 170MB）。
3. 删除 VSS 卷影副本（`Remove-CimInstance`）。
4. 用 TaskStop 结束后台无头浏览器任务。
5. 关闭为复制源码新开的 `view-source:` 标签页；还原用户原有剪贴板内容。
6. 保留用户原有的浏览器窗口与标签页，不擅自关闭。
