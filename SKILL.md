---
name: browser-download-yashu
description: 浏览器下载——把网页上的视频与图片落成本地文件。覆盖 B站（bilibili）、抖音（douyin）视频，以及淘宝/天猫/1688 等电商商品页的商品主图与展示视频；也适用于其他"页面里能看、想保存下来"的媒体。当用户要求"下载B站视频/合集/分P""下载抖音视频""把这个视频保存下来/离线存下来""下载这个UP主/博主的视频""下载商品主图/详情图""把这几张图保存下来""下载网页里的图片或视频""帮我从浏览器里把这个下载下来""视频没声音帮我修一下"时使用。覆盖 yt-dlp 直下、B站合集与分P、抖音反爬（App-Bound 加密 cookie、无头浏览器 CDP 取流）、DASH 音视频分离流的 ffmpeg 合并、电商页 CSS 背景图与内嵌 JSON 取图（含 view-source + 剪贴板兜底）、图床防盗链下载，以及下载后无声/播放器不识别音轨的兼容性修复。适用于 Windows + PowerShell 7 环境。
agent_created: true
---

# 浏览器下载（B站 / 抖音视频 + 电商商品页取图）

## 概述

通过浏览器把网页上的媒体落成本地文件，分三条互不相干的路线：

- **B站**：yt-dlp 直下，再 ffmpeg 合并。
- **抖音**：反爬，走浏览器调试协议（CDP）取流，再 ffmpeg 合并。
- **电商商品页（淘宝/天猫/1688）**：从页面里抠出图片/视频直链，再带 Referer 下载（步骤六）。

共同骨架：判断页面类型选路线 → 取流/抠链 → 落地 → 验证 → 必要时修复。

## 环境前提（本机固定事实，勿重新假设）

- 终端一律用 PowerShell 7（`pwsh`）语法；`cmd.exe` 被安全策略拦截，不可用。
- **本机命令 stdout 常不回传**（exit 0 却零输出，或整个调用空返回）。因此：
  - 所有命令把输出重定向到文件（`*> file` / `*>> file`），再用 Read 读该文件；
  - 判断成败看**副作用**（文件是否生成、体积/时长是否变化），不要干等，也不要反复重试同一条命令。
- 已知工具路径（优先直接使用，缺失再探测）：
  - yt-dlp：`D:\software\yt-dlp_win\yt-dlp.exe`
  - ffmpeg / ffprobe：`D:\software\ffmpeg\ffmpeg-2024-09-26-git-f43916e217-full_build\bin\`
  - node：`C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe`（自带全局 WebSocket，可直接连 CDP）
  - Edge：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
- 输出目录约定：`<workspace>\bili_download\`、`<workspace>\douyin_download\`、`<workspace>\<商品名>_主图\`（电商取值，文件名按主图顺序编号）。
- 文件名含中文/空格/全角符号时，PowerShell 一律用单引号包裹；`-o` 模板用 `'%(title)s.%(ext)s'`。
- PowerShell 7 原生脚本路径：`D:\software\PowerShell\7\pwsh.exe`；读系统剪贴板必须加 `-STA`。

## 路线决策树

1. **B站** → 直接上 yt-dlp。绝大多数视频**无需登录 cookie**即可下 1080P，不要一上来就折腾 cookie。
2. **抖音** → yt-dlp 必然报 `Fresh cookies (not necessarily logged in) are needed`。不要在 cookie 上纠缠，直接走 **CDP 取流**路线（步骤三）。
3. **任何要浏览器 cookie 的场景都别导出文件给 yt-dlp**：Edge 127+ 启用 **App-Bound Encryption**，yt-dlp 会报 `Failed to decrypt with DPAPI`，**关闭浏览器也没用**（加密与文件锁无关）。要 cookie 只能用 CDP 让浏览器自己交出来。
4. **淘宝/天猫/1688 等电商商品页** → 目标是**图片（和主图位里的视频）**，不是视频流，yt-dlp 用不上。走**步骤六**：CDP 取图（首选）或 view-source + 剪贴板（兜底）。

## 步骤一：环境探测

```powershell
$out='<workspace>\_check.txt'
"yt-dlp: $((Get-Command yt-dlp -ErrorAction SilentlyContinue).Source)" | Out-File -Encoding utf8 $out
& 'D:\software\yt-dlp_win\yt-dlp.exe' --version *>> $out
"ffmpeg: $((Get-Command ffmpeg -ErrorAction SilentlyContinue).Source)" | Out-File -Append -Encoding utf8 $out
& 'D:\software\ffmpeg\ffmpeg-2024-09-26-git-f43916e217-full_build\bin\ffprobe.exe' -version *>> $out
```
需要更高版本 yt-dlp 时用 `yt-dlp -U` 自更新。

## 步骤二：B站下载

先列格式确认可用清晰度：

```powershell
& 'D:\software\yt-dlp_win\yt-dlp.exe' --no-warnings -F '<视频URL>' *> <workspace>\_bili_formats.txt
```

下载单集（合集务必加 `--no-playlist`，否则会拉整个合集）：

```powershell
$dir='<workspace>\bili_download'; New-Item -ItemType Directory -Force -Path $dir | Out-Null
& 'D:\software\yt-dlp_win\yt-dlp.exe' --no-playlist -P $dir -o '%(title)s.%(ext)s' `
  -f 'bv*[height<=1080][vcodec^=avc1]+ba/b[height<=1080]' --merge-output-format mp4 `
  --no-warnings '<视频URL>' *> <workspace>\_bili_dl.log
```

关键点：
- **强制 H.264**：默认会挑 AV1（体积小但剪映等剪辑软件常不认）。用 `[vcodec^=avc1]` 或在格式列表里手选 `30080+30280` 这类 avc1 组合。
- 标题含"1080P 60帧/高码率 missing, premium member required"属正常提示，普通 1080P 仍可下。
- 想下整个合集：去掉 `--no-playlist`，并加 `-I 1:19` 之类限制范围。先下 1 集验证再批量。
- 下载合并耗时：100MB 级约 20 秒，可直接后台跑（`run_in_background`），完成后读日志。

## 步骤三：抖音下载（CDP 取流）

抖音网页播放器用 blob/MSE，DOM 里拿不到地址。做法是：起一个**无头 Edge 实例**去真实加载页面，再用 CDP 执行 JS 把媒体直链抠出来。

### 3.1 启动无头实例（不干扰用户正在用的 Edge）

```bash
# Bash 工具，run_in_background: true。用独立 user-data-dir，避免抢占用户 profile
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --user-data-dir="D:/software/workBuddyWorkspace/_edgeprofile" \
  --remote-debugging-port=9222 --headless=new \
  --no-first-run --no-default-browser-check --disable-gpu about:blank
```
注意：**不要**试图用参数转发给已运行的 Edge 实例来开调试端口，实测无效（新进程直接退出，端口不开）。

### 3.2 用 CDP 抠媒体直链

```powershell
& 'C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe' `
  '<skill>/scripts/cdp_media_probe.mjs' --port 9222 --url '<视频URL>' --out <workspace>\_dy_probe.json *> <workspace>\_probe.log
```

脚本输出 JSON：`videos`（video 元素）、`perf`（媒体请求地址列表）。从中挑出：
- 视频流：URL 含 `media-video-avc1`
- 音频流：URL 含 `media-audio-und-mp4a`

抖音是 DASH 分离流，**必须同时下视频流和音频流**，否则成品无声。

### 3.3 下载两个流并合并

```powershell
& '<skill>\scripts\download_and_merge.ps1' -VideoUrl '<media-video-avc1 URL>' -AudioUrl '<media-audio-und-mp4a URL>' `
  -OutFile '<workspace>\douyin_download\视频.mp4'
```
脚本内部：curl 带 `Referer: https://www.douyin.com/` 与普通 Chrome/Edge UA 下载两条流，再 `ffmpeg -c copy` 合并，最后删中间文件。

关键点：
- 直链**有时效**（带 `x-expires`/签名参数），抠出来要尽快下载，过期就重跑 3.2。
- 音频 URL 有时在 `perf` 中位于靠后位置，别只看前几条。
- `-user-agents`/UA 必须与浏览器同级（`Chrome/139 ... Edg/139 ...`），否则可能 403。

## 步骤四：验证产物

```powershell
& '<skill>\scripts\verify_media.ps1' -Path '<成品.mp4>'
```
检查三项：① 音视频两条流都在；② 时长与页面一致；③ **音频电平非静音**（`mean_volume` 应在 -30~-10 dB，`max_volume` 接近 0 dB）。若 `max_volume` 为 `-inf`，说明音频流本身是空的，需回到步骤三检查是否漏下音频流。

## 步骤五：音频兼容性修复（"下载后没声音"）

若验证显示音轨有信号，但用户播放无声，多半是**音轨由 Bento4 封装、语言标记 `und`**，部分播放器直接跳过。做一次重封装即可：

```powershell
& 'D:\software\ffmpeg\ffmpeg-2024-09-26-git-f43916e217-full_build\bin\ffmpeg.exe' -hide_banner -y `
  -i '<原文件>' -map 0:v:0 -map 0:a:0 -c:v copy -c:a aac -b:a 192k -ar 48000 -ac 2 `
  -movflags +faststart '<临时文件>' *> <workspace>\_fix.log
```
视频无损复制、音频重编码为标准 48kHz AAC、moov 前置。验证通过后 `Move-Item` 覆盖原文件。

## 步骤六：电商商品页取图与视频（淘宝 / 天猫 / 1688 等）

商品页的图片和视频**不是流媒体**，yt-dlp / DASH 那条路完全用不上。核心是"把页面里已经存在的媒体直链抠出来"。这条路是**实测跑通过的**（淘宝女装页：1 个主图视频 + 5 张主图全部取到）。

### 6.0 先认清三个坑（不知道就会一直原地打转）

1. **缩略图是 CSS 背景图**：主图区缩略图多数用 `background-image` 渲染，不是 `<img>`。所以读页面文本 / `<img>` 列表 / DOM 快照**都拿不到真实地址**——不要在这上面反复试。
2. **真实主图藏在页面内嵌 JSON 里**：形式是 `"images":["//img.alicdn.com/...","..."]`、`"videos":[...]`。**数组顺序＝主图顺序**，这才是完整有序的列表。
3. **页面会拦截复制，且后台标签页复制无效**：必须让目标标签页**在前台**（`tab_focus` 或让用户手动切），`Ctrl+C` 才会真正写入系统剪贴板；否则按了没反应，读出来还是旧内容。

### 6.1 首选：CDP 取图（gallery_probe.mjs）

复用步骤 3.1 的同一个无头实例（不用再起第二个）：

```powershell
& 'C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe' `
  '<skill>\scripts\gallery_probe.mjs' --port 9222 --url '<商品页URL>' `
  --out <workspace>\_gallery.json *> <workspace>\_gallery.log
```

脚本**三路并取**，结果落在 `_gallery.json` + `_gallery.html`：

| 字段 | 来源 | 用途 |
|---|---|---|
| `json.images` / `json.mainImages` | 页面内嵌 JSON 数组 | **完整有序的商品主图列表（首选）** |
| `json.videos` | 同上 | 主图位里的视频（如"会动的第 1 张"） |
| `backgroundImages` | CSS `background-image` | 缩略图区的地址（常带缩放后缀） |
| `imgTags` / `htmlImgs` | `<img>` src / data-src | 兜底 |
| `candidates` | 上面合并去重、保序 | 带 `kind`（image/video/gif）的候选清单 |

按 `json.images` 的数组顺序取前 N 张即主图；`json.videos` 里的就是视频。**先用 `candidates` 快速看清都有什么，再用分数组精确定序。**

### 6.2 兜底：view-source + 剪贴板（浏览器插件只能点/截图、没法执行 JS 时）

上一轮实战里，Edge 插件能点击/截图但**不能执行页面脚本**，DOM 快照也确实读不到缩略图，最后是靠这条路走通的：

1. **把目标标签页切到前台**（`tab_focus`；若是后台标签，复制会被浏览器丢弃）。
2. `Ctrl+U` 打开 `view-source:` 页 → `Ctrl+A` → `Ctrl+C`（源码页本身就是前台，比在原页面复制可靠）。
3. 复制后直接用脚本解析（**必须 `-STA`**，否则读剪贴板会失败）：

```powershell
& 'D:\software\PowerShell\7\pwsh.exe' -STA -NoProfile -ExecutionPolicy Bypass `
  -File '<skill>\scripts\extract_gallery_urls.ps1' -FromClipboard -Out <workspace>\_urls.txt
```

也可先把剪贴板存成文件（`-STA`）再 `-Path` 解析。脚本会按出现顺序输出：内嵌 JSON 的 `images`/`videos` 数组 → `<img>` 标签 → CSS 背景图，并去重。

4. 打开 `_urls.txt`，按顺序挑出商品主图/视频地址。

> **别用坐标点右键"图片另存为"**：电商页常有自定义右键菜单/浮层，坐标点中率低、菜单弹出还不一定被截图捕获。反复调坐标纯属浪费——直接 CDP 或 view-source 抠直链。

### 6.3 下载（务必带 Referer，图床有防盗链）

`img.alicdn.com` / `cloud.video.taobao.com` 等会校验 `Referer`，UA 要与浏览器同级：

```powershell
$ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0'
$dir = '<workspace>\<商品名>_主图'; New-Item -ItemType Directory -Force -Path $dir | Out-Null
$i = 0
foreach ($u in (Get-Content '<workspace>\_urls.txt')) {
  if (-not $u) { continue }
  $i++
  $ext = if ($u -match '\.(mp4|gif|png|webp)') { $Matches[1] } else { 'jpg' }
  $name = ('{0:d2}_{1}.{2}' -f $i, '主图', $ext)
  curl.exe -sS -L --retry 3 -e 'https://item.taobao.com/' -A $ua -o (Join-Path $dir $name) --url $u
}
```

文件名按数组顺序编号（`01_主图.jpg`…），交付时按序可用。

### 6.4 关键点与易错处

- **"会动的第 1 张"多半是视频，不是 GIF**：电商对视频缩略图做自动播放预览，看起来像 GIF，实际是 **mp4**，在 `"videos"` 数组里。要下**原视频**，不是截一帧图。（本轮实测：标记为"GIF"的那张实为 00:33 的 mp4。）
- **缩略图 vs 原图**：URL 里的 `_50x50.jpg` / `_430x430q90.jpg` / `_.webp` 是缩放后缀，去掉尺寸段通常可得原图。不确定时先下带后缀的验证顺序，再决定是否换原图。
- **直链有时效**：带签名/`x-expires` 的（多见于视频）抠出后尽快下载，过期就重抠。
- **交付前逐项核对**：数量、顺序、颜色/款式是否与用户标记一致（可用 Read 逐张看图比对）。
- **主图顺序以 JSON 数组为准**，不要把 `candidates` 里"images 全排在 videos 前"的顺序当成真实图序。

## 收尾与注意事项

- 清理临时文件、副本 profile（`_edgeprofile` 可达 170MB）、以及 VSS 卷影副本（若创建过）。
- 停掉后台无头实例：用 TaskStop 结束对应 task。
- 电商取值路线额外清理：`_gallery.json` / `_gallery.html` / `_urls.txt` / `_clip_*` 等中间文件。
- 若为了复制源码新开过 `view-source:` 标签页，用完关掉，别留在用户浏览器里。
- 还原用户原有剪贴板内容（若为取图借用过剪贴板）。
- 下载仅供个人学习，交付时提示不要二次传播。
- 版权与合规：不绕过付费/会员内容，不下载明确禁止下载的内容。

## 资源

- `scripts/cdp_media_probe.mjs` — CDP 取流脚本：连无头 Edge，可抠媒体直链或导出 cookie（Netscape 格式）。
- `scripts/gallery_probe.mjs` — CDP 取图脚本：连无头 Edge 打开商品页，三路抠出主图/视频直链（内嵌 JSON + CSS 背景图 + `<img>`）。
- `scripts/extract_gallery_urls.ps1` — 从源码文件或剪贴板 HTML 中按顺序提取图片/视频地址（view-source 兜底路线用）。
- `scripts/download_and_merge.ps1` — 下载 DASH 双流并 ffmpeg 合并。
- `scripts/verify_media.ps1` — ffprobe + 音量检测，判断产物是否正常有声。
- `references/troubleshooting.md` — 全部踩坑记录与报错对照表（遇到异常先查这里）。
