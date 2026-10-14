<#
.SYNOPSIS
  校验下载产物：流结构、时长、以及"音轨里到底有没有声音"。

.DESCRIPTION
  单纯看到 ffprobe 报出 aac 音轨并不代表有声音，也可能是全静音流。
  本脚本用 volumedetect 实测电平，给出结论；并对 Bento4/und 标记这类
  播放器不认的音轨给出修复建议。

.EXAMPLE
  .\verify_media.ps1 -Path 'D:\ws\douyin_download\野兽先生_上.mp4'
  .\verify_media.ps1 -Path '.\x.mp4' -Fix     # 同时产出兼容性修复版（覆盖原文件）
#>
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [double]$SampleStart = 30,
  [double]$SampleSeconds = 60,
  [switch]$Fix,
  [string]$Ffmpeg = 'D:\software\ffmpeg\ffmpeg-2024-09-26-git-f43916e217-full_build\bin\ffmpeg.exe',
  [string]$Ffprobe = 'D:\software\ffmpeg\ffmpeg-2024-09-26-git-f43916e217-full_build\bin\ffprobe.exe'
)

if (-not (Test-Path $Path)) { Write-Output "FAILED: file not found: $Path"; exit 1 }

$log = Join-Path (Split-Path -Parent $Path) '_verify.log'
"FILE=$Path" | Out-File -Encoding utf8 $log
"MB=$([math]::Round((Get-Item $Path).Length / 1MB, 1))" | Out-File -Append -Encoding utf8 $log

"=== streams ===" | Out-File -Append -Encoding utf8 $log
& $Ffprobe -v error -show_entries stream=index,codec_type,codec_name,channels,sample_rate,duration,bit_rate `
  -show_entries format=duration,bit_rate -of default=noprint_wrappers=1 $Path *>> $log

"=== audio level (sample ${SampleStart}s +${SampleSeconds}s) ===" | Out-File -Append -Encoding utf8 $log
& $Ffmpeg -hide_banner -nostats -ss $SampleStart -t $SampleSeconds -i $Path -map 0:a:0? `
  -af volumedetect -f null NUL *>> $log

$txt = Get-Content $log -Raw
$hasAudio = $txt -match 'codec_type=audio'
$mean = ([regex]::Match($txt, 'mean_volume:\s*(-?[\d.]+|-inf)')).Groups[1].Value
$max = ([regex]::Match($txt, 'max_volume:\s*(-?[\d.]+|-inf)')).Groups[1].Value

Write-Output "audio_track=$hasAudio mean_volume=$mean max_volume=$max"

if (-not $hasAudio) {
  Write-Output 'VERDICT: 缺音轨 —— 回到取流步骤，确认音频流（media-audio-*）已下载并参与合并'
} elseif ($max -eq '-inf' -or $max -eq '') {
  Write-Output 'VERDICT: 音轨存在但为静音 —— 音频流本身是空的，重新取流'
} else {
  Write-Output 'VERDICT: 音轨正常有声'
  if ($txt -match 'Bento4 Sound Handler') {
    Write-Output 'NOTE: 音轨由 Bento4 封装（语言标记 und），部分播放器会跳过它；用户反馈无声时加 -Fix 重封装'
  }
}

if ($Fix) {
  $tmp = Join-Path (Split-Path -Parent $Path) '_fixed.mp4'
  "=== fix (re-encode audio, faststart) ===" | Out-File -Append -Encoding utf8 $log
  & $Ffmpeg -hide_banner -y -i $Path -map 0:v:0 -map 0:a:0 -c:v copy -c:a aac -b:a 192k `
    -ar 48000 -ac 2 -movflags +faststart $tmp *>> $log
  if ((Test-Path $tmp) -and (Get-Item $tmp).Length -gt 0) {
    Move-Item $tmp $Path -Force
    Write-Output "FIXED: 已替换为兼容版 ($([math]::Round((Get-Item $Path).Length / 1MB, 1)) MB)"
  } else {
    Write-Output "FIX FAILED, see $log"
  }
}

Write-Output "log=$log"
