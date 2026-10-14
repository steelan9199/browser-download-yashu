---
name: browser-download-yashu
description: 浏览器下载——把网页上的视频与图片落成本地文件：B站/抖音视频、淘宝天猫商品主图与展示视频。激活条件：用户消息须包含以下关键词之一:`下载B站视频`、`下载抖音视频`、`下载商品主图`、`保存网页视频`、`保存网页图片`。
version: 1.1.0
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

商品页的图片和视频**不是流媒体**，yt-dlp / DASH 那条路用不上。核心是**把页面里已存在的媒体直链抠出来**。
**动手前必读 `references/ecommerce-gallery.md`**（三个坑 / CDP 取图 / view-source 兜底 / 带 Referer 下载）。

三条必知（漏读即返工）：

1. **缩略图是 CSS 背景图，真实主图藏在内嵌 JSON 的 `"images"` 数组里**——DOM 快照/页面文本读不到，别反复试。
2. **下载必须带 `Referer: https://item.taobao.com/` + 浏览器同级 UA**，否则 403 或拿到防盗链占位图。
3. **"会动的第 1 张"多半是 mp4 而不是 GIF**，要下原视频。

## 收尾与注意事项

- 清理临时文件、副本 profile（`_edgeprofile` 可达 170MB）、以及 VSS 卷影副本（若创建过）。
- 停掉后台无头实例：用 TaskStop 结束对应 task。
- 电商取值路线额外清理：`_gallery.json` / `_gallery.html` / `_urls.txt` / `_clip_*` 等中间文件。
- 若为了复制源码新开过 `view-source:` 标签页，用完关掉，别留在用户浏览器里。
- 还原用户原有剪贴板内容（若为取图借用过剪贴板）。
- 下载仅供个人学习，交付时提示不要二次传播。
- 版权与合规：不绕过付费/会员内容，不下载明确禁止下载的内容。

## 自进化（本技能是活文档）

本技能在使用中持续自我修正：**发现错误就改，冗余就删，不留痕迹**。

1. **只留正确的知识**：进文档须过五道门槛（G0~G4），被证伪的删干净，**不并存、不标注、不归档**。
2. **📏 体量红线：本技能所有 markdown 文档（`SKILL.md` 与各篇 `references/*.md`）都 ≤10000 字符**，超了必须拆分，**不调阈值**。
   依据是**共享性**：公共部分留本文件，只服务某条路线的下沉到对应文档，本文件只留一行指针。
3. **🔧 取证充分就直接改，不必请示**——只有不可逆或会削弱安全网的动作才先问
   （删脚本 / 删 git tag / 改推送目标 / 绕门禁）。口径：**能不能靠 git 回滚 + 门禁能不能拦住**。
4. **改完必须跑门禁**：`node scripts/skill_audit.js`（四道闸：引用断链 / 负向声明 / 工具路径一致性 / 体量红线），
   不过就拒推；minor/major 改动走 `node push.js "<说明>"`（提交 + 推送 + 打回滚 tag）。

> **改本技能前必读 `references/自进化与维护.md`**（收录判据 / 删错门槛 / 授权分级 / 版本号 / 回滚纪律）。

## 文档路由（按需读，别通读）

| 文件 | 什么时候读 |
|---|---|
| **`references/自进化与维护.md`** | **改本技能前必读**。收录判据 / 删错门槛 / 授权分级 / 版本号 / push-tag-回滚 / 体量红线 |
| **`references/troubleshooting.md`** | **遇到异常先查这里**。全部踩坑记录与报错对照表 |
| **`references/ecommerce-gallery.md`** | **走电商取值路线时必读**。三个坑 / CDP 取图 / view-source 兜底 / 带 Referer 下载 |

## 脚本

| 文件 | 用途 |
|---|---|
| `scripts/cdp_media_probe.mjs` | CDP 取流脚本：连无头 Edge，可抠媒体直链或导出 cookie（Netscape 格式） |
| `scripts/gallery_probe.mjs` | CDP 取图脚本：连无头 Edge 打开商品页，三路抠出主图/视频直链（内嵌 JSON + CSS 背景图 + `<img>`） |
| `scripts/extract_gallery_urls.ps1` | 从源码文件或剪贴板 HTML 中按顺序提取图片/视频地址（view-source 兜底路线用） |
| `scripts/download_and_merge.ps1` | 下载 DASH 双流并 ffmpeg 合并 |
| `scripts/verify_media.ps1` | ffprobe + 音量检测，判断产物是否正常有声 |
| `scripts/skill_audit.js` | 改本技能后的自进化门禁（引用断链 / 负向声明 / 工具路径一致性 / 体量红线） |
| `push.js` | 提交推送 + 打回滚 tag：`node push.js "<说明>"` |
