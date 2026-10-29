[CmdletBinding()]
param(
    [string]$PackagePath,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Zhiyi\Extension'),
    [switch]$NoOpenBrowser
)

[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$Repo = 'young-yyj/zhiyi'
$Headers = @{ 'User-Agent' = 'Zhiyi-Setup' }

function Write-Banner([string]$Title) {
    Write-Host ''
    Write-Host '============================================================'
    Write-Host ('  ' + $Title)
    Write-Host '============================================================'
    Write-Host ''
}

function Invoke-WithRetry {
    param([scriptblock]$Action, [string]$Label, [int]$Attempts = 3)
    for ($i = 1; $i -le $Attempts; $i++) {
        try { return (& $Action) } catch {
            if ($i -eq $Attempts) { throw }
            Write-Host ("Retry " + $i + "/" + ($Attempts - 1) + " after failure: " + $Label)
            Start-Sleep -Seconds (2 * $i)
        }
    }
}

function Get-Sha256([string]$Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { $bytes = $sha.ComputeHash($stream) } finally { $stream.Dispose(); $sha.Dispose() }
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-Package([string]$LocalPath, [string]$WorkDir) {
    if ($LocalPath) {
        if (-not (Test-Path -LiteralPath $LocalPath -PathType Leaf)) { throw "Package not found: $LocalPath" }
        return (Get-Item -LiteralPath $LocalPath).FullName
    }
    $release = Invoke-WithRetry -Label 'query latest release' -Action {
        Invoke-RestMethod -Uri ("https://api.github.com/repos/" + $Repo + "/releases/latest") -Headers $Headers -TimeoutSec 60
    }
    $assets = @($release.assets | Where-Object { $_.name -like 'zhiyi-chrome-*.zip' })
    if ($assets.Count -ne 1) { throw 'Latest release must contain exactly one zhiyi-chrome zip.' }
    $zip = Join-Path $WorkDir $assets[0].name
    Invoke-WithRetry -Label 'download package' -Action {
        Invoke-WebRequest -Uri $assets[0].browser_download_url -OutFile $zip -Headers $Headers
    } | Out-Null
    $digest = ([string]$assets[0].digest) -replace '^sha256:', ''
    if ($digest -and (Get-Sha256 $zip) -ne $digest.ToLowerInvariant()) { throw 'SHA-256 mismatch.' }
    return $zip
}

function Read-Version([string]$Directory) {
    $manifest = Join-Path $Directory 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return $null }
    return (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version
}

function Install-Package([string]$Target, [string]$Stage) {
    $parent = Split-Path -Parent $Target
    New-Item -ItemType Directory -Path $parent -Force | Out-Null

    $backup = Join-Path $parent 'Extension.bak'
    $moved = $false
    if (Test-Path -LiteralPath $Target) {
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
        Move-Item -LiteralPath $Target -Destination $backup -Force -ErrorAction Stop
        $moved = $true
    }
    try {
        Move-Item -LiteralPath $Stage -Destination $Target -Force -ErrorAction Stop
    } catch {
        if ($moved -and (Test-Path -LiteralPath $backup)) {
            Move-Item -LiteralPath $backup -Destination $Target -Force -ErrorAction Stop
        }
        throw
    }
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
}

function Open-ChromeExtensions {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    foreach ($exe in $candidates) {
        if ($exe -and (Test-Path -LiteralPath $exe -PathType Leaf)) {
            Start-Process -FilePath $exe -ArgumentList 'chrome://extensions/'
            return
        }
    }
    Write-Host 'Open chrome://extensions manually.'
}

$work = Join-Path ([IO.Path]::GetTempPath()) ('Zhiyi-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
    $target = [IO.Path]::GetFullPath($InstallDir)
    $zip = Get-Package $PackagePath $work
    $stage = Join-Path $work 'stage'
    Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
    $newVersion = Read-Version $stage
    if (-not $newVersion) { throw 'Package is missing manifest.json.' }

    $oldVersion = Read-Version $target
    if ($oldVersion -eq $newVersion) {
        Write-Banner ('芷译 已是最新版本 (' + $newVersion + ')')
        Write-Host ('  安装位置: ' + $target)
        Write-Host ''
        Write-Host '  无需操作。'
        Write-Host ''
        exit 0
    }

    Install-Package $target $stage

    if ($oldVersion) {
        Write-Banner ('芷译 已更新到 ' + $newVersion)
        Write-Host ('  原版本  : ' + $oldVersion)
        Write-Host ('  新版本  : ' + $newVersion)
        Write-Host ('  安装位置: ' + $target)
        Write-Host ''
        Write-Host '  接下来请在 Chrome 中刷新扩展:'
        Write-Host '    1. 打开 chrome://extensions'
        Write-Host '    2. 在「芷译」卡片上点击刷新按钮'
        Write-Host '    3. 刷新已打开的网页，让新脚本生效'
        Write-Host ''
    } else {
        Write-Banner ('芷译 安装完成 (' + $newVersion + ')')
        Write-Host ('  版本    : ' + $newVersion)
        Write-Host ('  安装位置: ' + $target)
        Write-Host ''
        Write-Host '  接下来请把这个扩展添加到 Chrome:'
        Write-Host '    1. 打开 chrome://extensions'
        Write-Host '    2. 打开右上角的「开发者模式」'
        Write-Host '    3. 点击「加载已解压的扩展程序」'
        Write-Host '    4. 选择上面显示的安装位置'
        Write-Host ''
        Write-Host '  别忘了：在扩展设置里填写 API Key（接口列表 → XiaomiMimo）'
        Write-Host ''
        Write-Host '  完成后打开英文网页，按 Alt+Z 翻译，再按一次还原。'
        Write-Host ''
    }
    if (-not $NoOpenBrowser) { Open-ChromeExtensions }
} catch {
    Write-Banner '安装失败'
    Write-Host ('  原因: ' + $_.Exception.Message)
    Write-Host ''
    Write-Host '  可以尝试:'
    Write-Host '    1. 检查网络后重新运行本脚本'
    Write-Host '    2. 或者手动下载扩展包，然后用本地安装:'
    Write-Host '       zhiyi-setup.cmd -PackagePath "D:\下载\zhiyi-chrome-<版本>.zip"'
    Write-Host ''
    exit 1
} finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
