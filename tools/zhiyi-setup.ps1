[CmdletBinding()]
param(
    [string]$PackagePath,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Zhiyi\Extension'),
    [switch]$NoOpenBrowser
)

$ErrorActionPreference = 'Stop'
$Repo = 'young-yyj/zhiyi'
$Headers = @{ 'User-Agent' = 'Zhiyi-Setup' }

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
    $release = Invoke-RestMethod -Uri ("https://api.github.com/repos/" + $Repo + "/releases/latest") -Headers $Headers
    $assets = @($release.assets | Where-Object { $_.name -like 'zhiyi-chrome-*.zip' })
    if ($assets.Count -ne 1) { throw 'Latest release must contain exactly one zhiyi-chrome zip.' }
    $zip = Join-Path $WorkDir $assets[0].name
    Invoke-WebRequest -Uri $assets[0].browser_download_url -OutFile $zip -Headers $Headers
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
        Write-Host ("AlreadyCurrent: " + $newVersion)
        exit 0
    }

    Install-Package $target $stage
    Write-Host ("Installed: " + $newVersion)
    Write-Host ("Extension directory: " + $target)
    if ($oldVersion) {
        Write-Host 'Update: click the extension card refresh button, then refresh open web pages.'
    } else {
        Write-Host 'First install: enable Developer mode in chrome://extensions, choose Load unpacked, and select the directory above.'
    }
    if (-not $NoOpenBrowser) { Open-ChromeExtensions }
} catch {
    Write-Error $_.Exception.Message
    exit 1
} finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
