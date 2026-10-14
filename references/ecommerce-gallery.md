---
name: ecommerce-gallery
description: 电商商品页（淘宝/天猫/1688）取图与视频的完整做法：三个必知坑、CDP 取图（gallery_probe.mjs）、view-source 兜底、带 Referer 下载。
---

# 电商商品页取图与视频（淘宝 / 天猫 / 1688 等）

商品页的图片和视频**不是流媒体**，yt-dlp / DASH 那条路完全用不上。核心是"把页面里已经存在的媒体直链抠出来"。这条路是**实测跑通过的**（淘宝女装页：1 个主图视频 + 5 张主图全部取到）。

## 6.0 先认清三个坑（不知道就会一直原地打转）

1. **缩略图是 CSS 背景图**：主图区缩略图多数用 `background-image` 渲染，不是 `<img>`。所以读页面文本 / `<img>` 列表 / DOM 快照**都拿不到真实地址**——不要在这上面反复试。
2. **真实主图藏在页面内嵌 JSON 里**：形式是 `"images":["//img.alicdn.com/...","..."]`、`"videos":[...]`。**数组顺序＝主图顺序**，这才是完整有序的列表。
3. **页面会拦截复制，且后台标签页复制无效**：必须让目标标签页**在前台**（`tab_focus` 或让用户手动切），`Ctrl+C` 才会真正写入系统剪贴板；否则按了没反应，读出来还是旧内容。

## 6.1 首选：CDP 取图（gallery_probe.mjs）

复用 SKILL.md 步骤 3.1 的同一个无头实例（不用再起第二个）：

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

## 6.2 兜底：view-source + 剪贴板（浏览器插件只能点/截图、没法执行 JS 时）

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

## 6.3 下载（务必带 Referer，图床有防盗链）

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

## 6.4 关键点与易错处

- **"会动的第 1 张"多半是视频，不是 GIF**：电商对视频缩略图做自动播放预览，看起来像 GIF，实际是 **mp4**，在 `"videos"` 数组里。要下**原视频**，不是截一帧图。（本轮实测：标记为"GIF"的那张实为 00:33 的 mp4。）
- **缩略图 vs 原图**：URL 里的 `_50x50.jpg` / `_430x430q90.jpg` / `_.webp` 是缩放后缀，去掉尺寸段通常可得原图。不确定时先下带后缀的验证顺序，再决定是否换原图。
- **直链有时效**：带签名/`x-expires` 的（多见于视频）抠出后尽快下载，过期就重抠。
- **交付前逐项核对**：数量、顺序、颜色/款式是否与用户标记一致（可用 Read 逐张看图比对）。
- **主图顺序以 JSON 数组为准**，不要把 `candidates` 里"images 全排在 videos 前"的顺序当成真实图序。

> 电商相关异常的现象 → 原因 → 解法，另见 `references/troubleshooting.md` 的「电商/图库页面类」一节。
