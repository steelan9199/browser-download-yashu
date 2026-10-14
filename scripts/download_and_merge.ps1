<#
.SYNOPSIS
  下载（DASH 分离的）视频流与音频流并合并为单个 MP4。

.DESCRIPTION
  抖音网页版返回的是分离的 DASH 流：视频流 URL 含 media-video-avc1，
  音频流 URL 含 media-audio-und-mp4a。本脚本用 curl 带 Referer/UA 下载两条流，
  再用 ffmpeg -c copy 无损合并，最后清理中间文件并做一次校验。

.EXAMPLE
  .\download_and_merge.ps1 -VideoUrl 'https://...media-video-avc1/...' `
      -AudioUrl 'https://...media-audio-und-mp4a/...' `
      -OutFile 'D:\ws\douyin_download\野兽先生_上.mp4'
#>
param(
  [Parameter(Mandatory = $true)][string]$VideoUrl,
  [string]$AudioUrl = '',
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$Referer = 'https://www.douyin.com/',
  [string]$UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0',
  [string]$Ffmpeg = 'D:\software\ffmpeg\ffmpeg-2024-09-26-git-f43916e217-full_build\bin\ffmpeg.exe',
  [string]$Ffprobe = 'D:\software\ffmpeg\ffmpeg-2024-09-26-git-f43916e217-full_build\bin\ffprobe.exe'
)

$ErrorActionPreference = 'Continue'
$dir = Split-Path -Parent $OutFile
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$log = Join-Path $dir '_merge.log'
$vTmp = Join-Path $dir '_v.tmp.mp4'
$aTmp = Join-Path $dir '_a.tmp.m4a'

"=== download video stream ===" | Out-File -Encoding utf8 $log
curl.exe -sS -L --retry 3 --max-time 1800 -o $vTmp `
  -H "Referer: $Referer" -H "User-Agent: $UserAgent" --url $VideoUrl *>> $log
"video exit=$LASTEXITCODE size=$((Get-Item $vTmp -ErrorAction SilentlyContinue).Length)" |
  Out-File -Append -Encoding utf8 $log

$hasAudio = $false
if ($AudioUrl -ne '') {
  "=== download audio stream ===" | Out-File -Append -Encoding utf8 $log
  curl.exe -sS -L --retry 3 --max-time 1800 -o $aTmp `
    -H "Referer: $Referer" -H "User-Agent: $UserAgent" --url $AudioUrl *>> $log
  "audio exit=$LASTEXITCODE size=$((Get-Item $aTmp -ErrorAction SilentlyContinue).Length)" |
    Out-File -Append -Encoding utf8 $log
  $hasAudio = (Test-Path $aTmp) -and ((Get-Item $aTmp).Length -gt 0)
}

if ($hasAudio) {
  "=== merge ===" | Out-File -Append -Encoding utf8 $log
  & $Ffmpeg -hide_banner -y -loglevel error -i $vTmp -i $aTmp -c copy -movflags +faststart $OutFile *>> $log
  "ffmpeg exit=$LASTEXITCODE" | Out-File -Append -Encoding utf8 $log
} else {
  "=== no audio, move video only ===" | Out-File -Append -Encoding utf8 $log
  Move-Item $vTmp $OutFile -Force
}

Remove-Item $vTmp, $aTmp -Force -ErrorAction SilentlyContinue

if (Test-Path $OutFile) {
  $mb = [math]::Round((Get-Item $OutFile).Length / 1MB, 1)
  "=== result: $OutFile ($mb MB) ===" | Out-File -Append -Encoding utf8 $log
  & $Ffprobe -v error -show_entries stream=index,codec_type,codec_name,channels,sample_rate,duration `
    -show_entries format=duration -of default=noprint_wrappers=1 $OutFile *>> $log
  Write-Output "OK $OutFile ($mb MB)  log=$log"
  if (-not $hasAudio) { Write-Output 'WARNING: 未提供音频流，成品将无声' }
} else {
  Write-Output "FAILED, see $log"
}
