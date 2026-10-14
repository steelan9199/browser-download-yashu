<#
.SYNOPSIS
  从页面源码（或剪贴板里的 HTML）中，按出现顺序提取商品图库的图片与视频直链。

.DESCRIPTION
  电商详情页（淘宝 / 天猫 / 1688 等）的真实主图常内嵌在页面 HTML 的 JSON 里，
  形如 "images":["//img.alicdn.com/..."]、"videos":[...]；缩略图区则是 CSS 背景图。
  读 DOM 文本 / <img> 列表都拿不到，所以这里直接对源码做三路扫描：
    1) 内嵌 JSON 的 images / videos / imageList / videoList / mainImages 数组
    2) <img> 标签的 src / data-src / data-ks-lazyload / data-original
    3) CSS background-image: url(...)
  结果按出现顺序去重输出，每行一个 URL（可直接喂给下载循环）。

.PARAMETER Path
  页面源码文件路径（可用 view-source 复制后落盘，或用 -FromClipboard 直接取）。

.PARAMETER FromClipboard
  直接从系统剪贴板读取 HTML。**必须以 pwsh -STA 运行**，否则读不到。

.PARAMETER Out
  把结果写到该 TXT 文件（每行一个 URL）。不填则只打印到 stdout。

.EXAMPLE
  pwsh -STA -NoProfile -ExecutionPolicy Bypass -File .\extract_gallery_urls.ps1 `
    -FromClipboard -Out D:\ws\_urls.txt

.EXAMPLE
  .\extract_gallery_urls.ps1 -Path D:\ws\_src.html -Out D:\ws\_urls.txt
#>
param(
  [string]$Path,
  [switch]$FromClipboard,
  [string]$Out
)

$ErrorActionPreference = 'Continue'

# ---- 取源 ----
$html = ''
if ($FromClipboard) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $html = [System.Windows.Forms.Clipboard]::GetText()
  } catch {
    Write-Output 'FAILED: 读取剪贴板失败 —— 请以 `pwsh -STA` 运行本脚本'
    exit 1
  }
  if (-not $html) {
    Write-Output 'FAILED: 剪贴板为空。请先在页面 Ctrl+A / Ctrl+C（务必让标签页在前台）'
    exit 1
  }
} elseif ($Path) {
  if (-not (Test-Path -LiteralPath $Path)) { Write-Output "FAILED: file not found: $Path"; exit 1 }
  $html = Get-Content -Raw -LiteralPath $Path
} else {
  Write-Output 'FAILED: 需要 -Path 或 -FromClipboard'
  exit 1
}

$raw = New-Object System.Collections.Generic.List[string]

# ---- 1) 内嵌 JSON 数组 ----
foreach ($key in 'images', 'mainImages', 'imageList', 'videos', 'videoList') {
  $re = '"' + $key + '"\s*:\s*\[([^\]]*)\]'
  foreach ($m in [regex]::Matches($html, $re)) {
    # 先还原 JSON 字符串里常见的转义斜杠，否则会漏地址
    $grp = $m.Groups[1].Value -replace '\\u002[fF]', '/' -replace '\\/', '/'
    foreach ($u in [regex]::Matches($grp, 'https?:[^"''\s]+|//[^"''\s]+')) {
      $raw.Add($u.Value)
    }
  }
}

# ---- 2) <img> 标签 ----
foreach ($m in [regex]::Matches($html, '<img[^>]*>')) {
  foreach ($attr in 'src', 'data-src', 'data-ks-lazyload', 'data-original', 'data-img') {
    $a = [regex]::Match($m.Value, $attr + '\s*=\s*["'']([^"'']+)["'']')
    if ($a.Success) { $raw.Add($a.Groups[1].Value) }
  }
}

# ---- 3) CSS background-image ----
foreach ($m in [regex]::Matches($html, 'background(?:-image)?\s*:\s*url\(["'']?([^"'')]+)["'']?\)')) {
  $raw.Add($m.Groups[1].Value)
}

# ---- 归一化 + 过滤 + 去重（保序）----
$seen = New-Object 'System.Collections.Generic.HashSet[string]'
$outList = New-Object System.Collections.Generic.List[string]
foreach ($item in $raw) {
  if (-not $item) { continue }
  $u = $item.Trim()
  if ($u.StartsWith('//')) { $u = 'https:' + $u }
  if ($u -match '^(data:|about:|javascript:|blob:)') { continue }
  if ($u -notmatch '\.(jpe?g|png|webp|avif|gif|mp4|mov|m3u8)') { continue }
  if ($seen.Add($u)) { $outList.Add($u) }
}

if ($Out) {
  $outList | Out-File -Encoding utf8 -LiteralPath $Out
  Write-Output "WROTE=$Out count=$($outList.Count)"
} else {
  Write-Output "COUNT=$($outList.Count)"
}
foreach ($u in $outList) { Write-Output $u }
