param(
  [switch]$ForcePortableNode,
  [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# 所有自动下载内容都放在项目目录中，避免修改系统 Node.js 环境。
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot '.runtime'
$portableNodeRoot = Join-Path $runtimeRoot 'node'
$downloadRoot = Join-Path $runtimeRoot 'downloads'
$playwrightRoot = Join-Path $runtimeRoot 'ms-playwright'
$lockFile = Join-Path $projectRoot 'package-lock.json'
$dependencyMarker = Join-Path $runtimeRoot 'package-lock.sha256'
$nodeVersion = '22.14.0'
$minimumNodeMajor = 20

function Write-Step([string]$message) {
  Write-Host "`n[BOM Assistant] $message" -ForegroundColor Cyan
}

function Get-NodeMajor([string]$nodeExecutable) {
  try {
    $version = & $nodeExecutable --version
    if ($version -match '^v(\d+)\.') { return [int]$Matches[1] }
  } catch {}
  return 0
}

function Get-Sha256([string]$filePath) {
  $stream = $null
  $sha256 = $null
  try {
    $stream = [System.IO.File]::OpenRead($filePath)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '')
  } finally {
    if ($sha256) { $sha256.Dispose() }
    if ($stream) { $stream.Dispose() }
  }
}

function Test-ZipArchive([string]$archivePath, [string]$expectedHash) {
  if (-not (Test-Path -LiteralPath $archivePath)) { return $false }
  if ((Get-Item -LiteralPath $archivePath).Length -lt 1024) { return $false }
  $zip = $null
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
    $zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
    if ($zip.Entries.Count -eq 0) { return $false }
  } catch {
    return $false
  } finally {
    if ($zip) { $zip.Dispose() }
  }
  if ($expectedHash) {
    $actualHash = Get-Sha256 $archivePath
    if ($actualHash -ne $expectedHash) { return $false }
  }
  return $true
}

function Get-OfficialChecksum([string]$baseUrl, [string]$archiveName) {
  try {
    $response = Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 120
    $escapedName = [Regex]::Escape($archiveName)
    foreach ($line in ([string]$response.Content -split "`n")) {
      if ($line.Trim() -match "^([0-9a-fA-F]{64})\s+$escapedName$") {
        return $Matches[1].ToUpperInvariant()
      }
    }
  } catch {
    Write-Host '警告：暂时无法获取官方校验和，将仅验证 ZIP 结构。' -ForegroundColor Yellow
  }
  return $null
}

function Download-VerifiedArchive([string]$downloadUrl, [string]$archivePath, [string]$expectedHash) {
  if (Test-ZipArchive $archivePath $expectedHash) { return }
  if (Test-Path -LiteralPath $archivePath) {
    Write-Host '检测到损坏或不完整的 Node.js 下载缓存，正在自动删除。' -ForegroundColor Yellow
    Remove-Item -LiteralPath $archivePath -Force
  }

  $partialPath = "$archivePath.partial"
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      if (Test-Path -LiteralPath $partialPath) { Remove-Item -LiteralPath $partialPath -Force }
      Write-Host "正在下载 Node.js（第 $attempt/3 次尝试）..."
      Invoke-WebRequest -Uri $downloadUrl -OutFile $partialPath -UseBasicParsing -TimeoutSec 120
      if (-not (Test-ZipArchive $partialPath $expectedHash)) {
        throw '下载文件未通过 ZIP 完整性或 SHA-256 校验。'
      }
      Move-Item -LiteralPath $partialPath -Destination $archivePath -Force
      return
    } catch {
      if (Test-Path -LiteralPath $partialPath) { Remove-Item -LiteralPath $partialPath -Force }
      if ($attempt -eq 3) { throw "Node.js 下载连续失败3次：$($_.Exception.Message)" }
      Write-Host "下载失败，将自动重试：$($_.Exception.Message)" -ForegroundColor Yellow
      Start-Sleep -Seconds (2 * $attempt)
    }
  }
}

function Install-PortableNode {
  $portableNode = Join-Path $portableNodeRoot 'node.exe'
  if ((Test-Path -LiteralPath $portableNode) -and ((Get-NodeMajor $portableNode) -ge $minimumNodeMajor)) {
    return $portableNode
  }

  Write-Step "未检测到 Node.js $minimumNodeMajor 或更高版本，正在下载便携版 Node.js v$nodeVersion..."
  New-Item -ItemType Directory -Force -Path $runtimeRoot, $downloadRoot | Out-Null

  $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
  $archiveName = "node-v$nodeVersion-$architecture.zip"
  $baseUrl = "https://nodejs.org/dist/v$nodeVersion"
  $downloadUrl = "$baseUrl/$archiveName"
  $archivePath = Join-Path $downloadRoot $archiveName
  $extractRoot = Join-Path $runtimeRoot 'node-extract'

  $expectedHash = Get-OfficialChecksum $baseUrl $archiveName
  Download-VerifiedArchive $downloadUrl $archivePath $expectedHash
  if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
  if (Test-Path -LiteralPath $portableNodeRoot) { Remove-Item -LiteralPath $portableNodeRoot -Recurse -Force }
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
  $extractedDirectory = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
  if (-not $extractedDirectory) { throw 'Node.js 压缩包内容无效。' }
  Move-Item -LiteralPath $extractedDirectory.FullName -Destination $portableNodeRoot
  Remove-Item -LiteralPath $extractRoot -Recurse -Force

  if (-not (Test-Path -LiteralPath $portableNode)) { throw '便携版 Node.js 安装失败。' }
  return $portableNode
}

try {
  Set-Location -LiteralPath $projectRoot
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

  $nodeExecutable = $null
  if (-not $ForcePortableNode) {
    $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($systemNode -and ((Get-NodeMajor $systemNode.Source) -ge $minimumNodeMajor)) {
      $nodeExecutable = $systemNode.Source
      Write-Step "使用系统 Node.js：$(& $nodeExecutable --version)"
    }
  }
  if (-not $nodeExecutable) { $nodeExecutable = Install-PortableNode }

  $nodeDirectory = Split-Path -Parent $nodeExecutable
  $env:Path = "$nodeDirectory;$env:Path"
  $env:PLAYWRIGHT_BROWSERS_PATH = $playwrightRoot
  $npmExecutable = Join-Path $nodeDirectory 'npm.cmd'
  $npxExecutable = Join-Path $nodeDirectory 'npx.cmd'
  if (-not (Test-Path -LiteralPath $npmExecutable)) { $npmExecutable = (Get-Command npm.cmd).Source }
  if (-not (Test-Path -LiteralPath $npxExecutable)) { $npxExecutable = (Get-Command npx.cmd).Source }

  $currentHash = Get-Sha256 $lockFile
  $savedHash = if (Test-Path -LiteralPath $dependencyMarker) { (Get-Content -Raw -LiteralPath $dependencyMarker).Trim() } else { '' }
  if ((-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\express'))) -or $currentHash -ne $savedHash) {
    Write-Step '正在安装项目依赖...'
    & $npmExecutable ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm 依赖安装失败，退出代码：$LASTEXITCODE" }
    Set-Content -LiteralPath $dependencyMarker -Value $currentHash -NoNewline
  } else {
    Write-Step '项目依赖已经就绪。'
  }

  $edgeCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $edgeExecutable = $edgeCandidates | Select-Object -First 1
  $chromiumInstalled = Get-ChildItem -LiteralPath $playwrightRoot -Directory -Filter 'chromium-*' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($edgeExecutable) {
    Write-Step "检测到 Microsoft Edge：$edgeExecutable，跳过备用 Chromium 下载。"
  } elseif (-not $chromiumInstalled) {
    Write-Step '未检测到 Microsoft Edge，正在下载备用 Chromium 浏览器组件...'
    & $npxExecutable playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw "Chromium 下载失败，退出代码：$LASTEXITCODE" }
  } else {
    Write-Step '备用 Chromium 浏览器组件已经就绪。'
  }

  if ($PrepareOnly) {
    Write-Host "`n首次运行环境准备完成。" -ForegroundColor Green
    exit 0
  }

  Write-Step '正在启动 BOM 淘宝采购助手...'
  Write-Host '操作页面：http://127.0.0.1:3210'
  Write-Host '使用工具期间请勿关闭此窗口。' -ForegroundColor Yellow
  & $nodeExecutable (Join-Path $projectRoot 'src\server.js')
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "服务异常退出，代码：$LASTEXITCODE" }
} catch {
  Write-Host "`n启动失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host '请检查网络连接后重新双击“启动工具.cmd”。' -ForegroundColor Yellow
  Read-Host '按 Enter 键关闭窗口'
  exit 1
}
