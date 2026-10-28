[CmdletBinding()]
param(
    [string]$PackagePath,
    [string]$Version,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Zhiyi\Extension'),
    [switch]$NoOpenBrowser,
    [switch]$WhatIf
)

$script:Repository = 'young-yyj/zhiyi'
$script:ApiRoot = 'https://api.github.com/repos/' + $script:Repository
$script:ExpectedExtensionId = 'pnkbdgpgamapapljeegfbdblcmddcbin'
$script:AssetPattern = 'zhiyi-chrome-*.zip'
$script:MaxZipEntries = 10000
$script:MaxEntryBytes = 64 * 1024 * 1024
$script:MaxExpandedBytes = 256 * 1024 * 1024
$script:MaxCompressedBytes = 32 * 1024 * 1024
$script:MaxManifestCharacters = 1024 * 1024

function Assert-ZhiyiCompressedSize([int64]$Bytes) {
    if ($Bytes -gt $script:MaxCompressedBytes) {
        throw "Package is larger than the $($script:MaxCompressedBytes) byte download limit."
    }
}

function Copy-LimitedStream {
    param(
        $InputStream,
        $OutputStream,
        [int64]$MaxBytes,
        [int64]$CurrentTotal,
        [int64]$MaxTotal
    )
    $buffer = New-Object byte[] 81920
    $written = [int64]0
    while (($read = $InputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $written += $read
        if ($written -gt $MaxBytes) { throw 'Decompressed entry exceeds the per-file safety limit.' }
        $CurrentTotal += $read
        if ($CurrentTotal -gt $MaxTotal) { throw 'Decompressed archive exceeds the total safety limit.' }
        $OutputStream.Write($buffer, 0, $read)
    }
    return $CurrentTotal
}

function Read-LimitedTextStream {
    param($InputStream, [int]$MaxCharacters)
    $reader = New-Object IO.StreamReader -ArgumentList @($InputStream, [Text.Encoding]::UTF8, $true)
    $builder = New-Object Text.StringBuilder
    $buffer = New-Object char[] 4096
    try {
        while (($read = $reader.Read($buffer, 0, $buffer.Length)) -gt 0) {
            if ($builder.Length + $read -gt $MaxCharacters) { throw 'manifest.json exceeds the character safety limit.' }
            [void]$builder.Append($buffer, 0, $read)
        }
        return $builder.ToString()
    } finally { $reader.Dispose() }
}

function Get-AbsolutePath([string]$Path) {
    return [IO.Path]::GetFullPath($Path)
}

function Get-ChromeExtensionId([string]$PublicKey) {
    if ([string]::IsNullOrWhiteSpace($PublicKey)) { throw 'manifest.json is missing the public key.' }
    try { $bytes = [Convert]::FromBase64String($PublicKey) } catch { throw 'manifest.json contains an invalid base64 public key.' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
    $builder = New-Object Text.StringBuilder
    for ($i = 0; $i -lt 16; $i++) {
        [void]$builder.Append([char](97 + (($hash[$i] -shr 4) -band 15)))
        [void]$builder.Append([char](97 + ($hash[$i] -band 15)))
    }
    return $builder.ToString()
}

function Get-VersionParts([string]$Value) {
    if ($Value -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw "Invalid Chrome version: $Value" }
    return ,(@($Value -split '\.') | ForEach-Object { [int]$_ })
}

function Compare-ChromeVersion([string]$Left, [string]$Right) {
    $a = Get-VersionParts $Left
    $b = Get-VersionParts $Right
    for ($i = 0; $i -lt 4; $i++) {
        if ($a[$i] -lt $b[$i]) { return -1 }
        if ($a[$i] -gt $b[$i]) { return 1 }
    }
    return 0
}

function Read-Manifest([string]$Directory) {
    $path = Join-Path $Directory 'manifest.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Package is missing root manifest.json: $Directory" }
    try { return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json) }
    catch { throw "Cannot parse manifest.json: $($_.Exception.Message)" }
}

function Assert-ZhiyiManifest($Manifest, [string]$Context) {
    if ($null -eq $Manifest.version) { throw "$Context manifest is missing version." }
    $version = [string]$Manifest.version
    [void](Get-VersionParts $version)
    $id = Get-ChromeExtensionId ([string]$Manifest.key)
    if ($id -ne $script:ExpectedExtensionId) { throw "$Context extension ID mismatch. Expected $($script:ExpectedExtensionId), got $id." }
    return $version
}

function Test-ZipEntryPath([string]$EntryName, $Entry) {
    if ([string]::IsNullOrWhiteSpace($EntryName)) { return }
    if ($EntryName -match '^[\\/]' -or $EntryName -match '^[A-Za-z]:' -or $EntryName.Contains(':')) { throw "Unsafe absolute or stream archive path: $EntryName" }
    $segments = $EntryName -split '[\\/]'
    foreach ($segment in $segments) {
        if ($segment -eq '.' -or $segment -eq '..' -or ($segment -and $segment -match '[. ]$')) { throw "Unsafe normalized archive path: $EntryName" }
    }
    if ($segments -contains '..') { throw "Unsafe traversal archive path: $EntryName" }
    $unixType = (([int64]$Entry.ExternalAttributes -shr 16) -band 0xF000)
    if ($unixType -eq 0xA000) { throw "Symbolic links are not allowed in the archive: $EntryName" }
}

function Assert-ZipBudget($Entries) {
    if ($Entries.Count -gt $script:MaxZipEntries) { throw "Archive contains too many entries: $($Entries.Count)" }
    $total = [int64]0
    foreach ($entry in $Entries) {
        if ([int64]$entry.Length -gt $script:MaxEntryBytes) { throw "Archive entry is too large: $($entry.FullName)" }
        $total += [int64]$entry.Length
        if ($total -gt $script:MaxExpandedBytes) { throw 'Archive expanded size exceeds the safety limit.' }
    }
}

function Expand-ZhiyiPackage([string]$ZipPath, [string]$StagePath) {
    [void](Read-ZhiyiPackageManifest $ZipPath)
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stageRoot = ([IO.Path]::GetFullPath($StagePath)).TrimEnd('\') + '\'
    $stream = $null
    $archive = $null
    $expandedTotal = [int64]0
    try {
        $stream = [IO.File]::OpenRead($ZipPath)
        $archive = New-Object IO.Compression.ZipArchive($stream, ([IO.Compression.ZipArchiveMode]::Read), $false)
        $entries = @($archive.Entries)
        Assert-ZipBudget $entries
        $manifestFound = $false
        $seenPaths = @{}
        foreach ($entry in $entries) {
            Test-ZipEntryPath $entry.FullName $entry
            $relative = $entry.FullName -replace '/', '\'
            $target = [IO.Path]::GetFullPath((Join-Path $StagePath $relative))
            if (-not $target.StartsWith($stageRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Archive entry escapes staging directory: $($entry.FullName)" }
            $normalizedPath = $target.TrimEnd('\').ToLowerInvariant()
            if ($seenPaths.ContainsKey($normalizedPath)) { throw "Duplicate archive path: $($entry.FullName)" }
            $seenPaths[$normalizedPath] = $true
            if ($entry.FullName -eq 'manifest.json') { $manifestFound = $true }
        }
        if (-not $manifestFound) { throw 'Archive must contain manifest.json at its root.' }
        New-Item -ItemType Directory -Path $StagePath -Force | Out-Null
        foreach ($entry in $entries) {
            $relative = $entry.FullName -replace '/', '\'
            $target = [IO.Path]::GetFullPath((Join-Path $StagePath $relative))
            if ($entry.FullName.EndsWith('/')) {
                New-Item -ItemType Directory -Path $target -Force | Out-Null
                continue
            }
            $parent = [IO.Path]::GetDirectoryName($target)
            if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            $input = $entry.Open()
            $output = $null
            try {
                $output = [IO.File]::Create($target)
                $expandedTotal = Copy-LimitedStream -InputStream $input -OutputStream $output -MaxBytes $script:MaxEntryBytes -CurrentTotal $expandedTotal -MaxTotal $script:MaxExpandedBytes
            } finally {
                if ($output) { $output.Dispose() }
                if ($input) { $input.Dispose() }
            }
        }
    } finally {
        if ($archive) { $archive.Dispose() }
        if ($stream) { $stream.Dispose() }
    }
}

function Read-ZhiyiPackageManifest([string]$ZipPath) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stream = $null
    $archive = $null
    $manifestEntry = $null
    try {
        $stream = [IO.File]::OpenRead($ZipPath)
        $archive = New-Object IO.Compression.ZipArchive($stream, ([IO.Compression.ZipArchiveMode]::Read), $false)
        $entries = @($archive.Entries)
        Assert-ZipBudget $entries
        foreach ($entry in $entries) {
            Test-ZipEntryPath $entry.FullName $entry
            if ($entry.FullName -eq 'manifest.json') {
                if ($manifestEntry) { throw 'Archive contains duplicate root manifest.json entries.' }
                $manifestEntry = $entry
            }
        }
        if (-not $manifestEntry) { throw 'Archive must contain manifest.json at its root.' }
        if ([int64]$manifestEntry.Length -gt $script:MaxManifestCharacters) { throw 'manifest.json exceeds the size safety limit.' }
        $input = $manifestEntry.Open()
        try {
            $text = Read-LimitedTextStream -InputStream $input -MaxCharacters $script:MaxManifestCharacters
            return ($text | ConvertFrom-Json)
        } catch { throw "Cannot parse package manifest.json: $($_.Exception.Message)" }
        finally { $input.Dispose() }
    } finally {
        if ($archive) { $archive.Dispose() }
        if ($stream) { $stream.Dispose() }
    }
}

function Get-Sha256([string]$Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = $null
    try {
        $stream = [IO.File]::OpenRead($Path)
        $bytes = $sha.ComputeHash($stream)
    } finally {
        if ($stream) { $stream.Dispose() }
        $sha.Dispose()
    }
    $builder = New-Object Text.StringBuilder
    foreach ($byte in $bytes) { [void]$builder.Append($byte.ToString('x2')) }
    return $builder.ToString()
}

function Assert-FileSha256([string]$Path, [string]$ExpectedDigest) {
    if ($ExpectedDigest -notmatch '^sha256:[0-9a-fA-F]{64}$') { throw "Invalid SHA-256 digest: $ExpectedDigest" }
    $expected = $ExpectedDigest.Substring(7).ToLowerInvariant()
    $actual = Get-Sha256 $Path
    if ($actual -ne $expected) { throw "SHA-256 mismatch. Expected $expected, got $actual." }
    return $actual
}

function Test-ZhiyiSha256([string]$Path, [string]$Digest) {
    try { [void](Assert-FileSha256 $Path $Digest); return $true } catch { return $false }
}

function Get-ApiHeaders() {
    return @{ 'User-Agent' = 'Zhiyi-Windows-Setup'; Accept = 'application/vnd.github+json' }
}

function Get-ZhiyiRelease([string]$RequestedVersion, [string]$DownloadDirectory) {
    if ([string]::IsNullOrWhiteSpace($RequestedVersion)) { $uri = $script:ApiRoot + '/releases/latest' }
    else {
        [void](Get-VersionParts $RequestedVersion)
        $uri = $script:ApiRoot + '/releases/tags/v' + $RequestedVersion
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    try { $release = Invoke-RestMethod -Uri $uri -Headers (Get-ApiHeaders) -UseBasicParsing -ErrorAction Stop }
    catch { throw "Cannot query GitHub Release: $($_.Exception.Message)" }
    $releaseVersion = ([string]$release.tag_name) -replace '^v', ''
    [void](Get-VersionParts $releaseVersion)
    if ($RequestedVersion -and [string]$release.tag_name -cne ('v' + $RequestedVersion)) { throw "Requested release tag v$RequestedVersion resolved as $($release.tag_name)." }
    $assets = @($release.assets | Where-Object { $_.name -ceq ('zhiyi-chrome-' + $releaseVersion + '.zip') })
    if ($assets.Count -ne 1) { throw "Expected asset zhiyi-chrome-$releaseVersion.zip in release $($release.tag_name)." }
    $asset = $assets[0]
    if ([IO.Path]::GetFileName([string]$asset.name) -cne [string]$asset.name -or [string]$asset.digest -notmatch '^sha256:[0-9a-fA-F]{64}$') { throw "Release asset name or SHA-256 digest is invalid: $($asset.name)" }
    $downloadUri = $null
    try { $downloadUri = [Uri]$asset.browser_download_url } catch { throw "Release asset URL is invalid: $($asset.browser_download_url)" }
    if ($downloadUri.Scheme -cne 'https' -or $downloadUri.Host -cne 'github.com' -or $downloadUri.Port -ne 443 -or -not [string]::IsNullOrEmpty($downloadUri.UserInfo) -or -not $downloadUri.AbsolutePath.StartsWith('/' + $script:Repository + '/releases/download/', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Release asset URL is outside the trusted GitHub repository: $($asset.browser_download_url)"
    }
    if ($null -ne $asset.size) { Assert-ZhiyiCompressedSize ([int64]$asset.size) }
    $zipPath = Join-Path $DownloadDirectory $asset.name
    $request = $null
    $response = $null
    $input = $null
    $output = $null
    try {
        $request = [Net.HttpWebRequest]::Create($downloadUri)
        $request.Method = 'GET'
        $request.AllowAutoRedirect = $true
        $request.MaximumAutomaticRedirections = 5
        $request.UserAgent = 'Zhiyi-Windows-Setup'
        $request.Timeout = 60000
        $response = $request.GetResponse()
        if ($response.ContentLength -gt $script:MaxCompressedBytes) {
            throw "Release asset is larger than the $($script:MaxCompressedBytes) byte download limit."
        }
        $input = $response.GetResponseStream()
        $output = [IO.File]::Create($zipPath)
        [void](Copy-LimitedStream -InputStream $input -OutputStream $output -MaxBytes $script:MaxCompressedBytes -CurrentTotal 0 -MaxTotal $script:MaxCompressedBytes)
    } catch {
        if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue }
        throw "Cannot download Release asset: $($_.Exception.Message)"
    } finally {
        if ($output) { $output.Dispose() }
        if ($input) { $input.Dispose() }
        if ($response) { $response.Dispose() }
    }
    $actual = Assert-FileSha256 $zipPath ([string]$asset.digest)
    return [pscustomobject]@{ ZipPath = $zipPath; Version = $releaseVersion; Digest = $actual }
}

function Resolve-ZhiyiPackage([string]$LocalPackagePath, [string]$RequestedVersion, [string]$DownloadDirectory) {
    if (-not [string]::IsNullOrWhiteSpace($LocalPackagePath)) {
        $path = Get-AbsolutePath $LocalPackagePath
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Local package does not exist: $path" }
        Assert-ZhiyiCompressedSize ([int64](Get-Item -LiteralPath $path).Length)
        return [pscustomobject]@{ ZipPath = $path; Version = $RequestedVersion; Digest = (Get-Sha256 $path) }
    }
    return Get-ZhiyiRelease $RequestedVersion $DownloadDirectory
}

function Open-ChromeExtensionsPage {
    $candidates = @()
    $roots = @($env:ProgramW6432, $env:ProgramFiles, $env:LOCALAPPDATA)
    foreach ($root in $roots) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        $candidate = Join-Path $root 'Google\Chrome\Application\chrome.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidates += $candidate }
    }
    if ($candidates.Count -eq 0) { Write-Warning 'Chrome executable was not found. Open chrome://extensions manually.'; return }
    try { Start-Process -FilePath $candidates[0] -ArgumentList 'chrome://extensions/' | Out-Null }
    catch { Write-Warning "Could not open chrome://extensions: $($_.Exception.Message)" }
}

function Keep-RecentBackups([string]$BackupRoot) {
    if (-not (Test-Path -LiteralPath $BackupRoot -PathType Container)) { return }
    $old = @(Get-ChildItem -LiteralPath $BackupRoot -Directory -ErrorAction Stop | Sort-Object {
        if ($_.Name -match '-(\d{8}T\d{9}Z)$') { [datetime]::ParseExact($matches[1], "yyyyMMdd'T'HHmmssfff'Z'", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal) }
        else { $_.LastWriteTimeUtc }
    } -Descending | Select-Object -Skip 3)
    foreach ($entry in $old) {
        try {
            Remove-Item -LiteralPath $entry.FullName -Recurse -Force -ErrorAction Stop
            if (Test-Path -LiteralPath $entry.FullName) { throw 'directory still exists after removal' }
        } catch {
            throw "Could not prune old backup '$($entry.FullName)': $($_.Exception.Message)"
        }
    }
}

function Invoke-ZhiyiSetup {
    param([string]$LocalPackagePath, [string]$RequestedVersion, [string]$TargetInstallDir, [bool]$SkipBrowser, [bool]$DryRun)
    $workRoot = $null
    $stagePath = $null
    $backupPath = $null
    $movedCurrent = $false
    $movedStage = $false
    $preserveStage = $false
    $installPath = Get-AbsolutePath $TargetInstallDir
    $currentVersion = $null
    try {
        $installParent = [IO.Path]::GetDirectoryName($installPath)
        if (-not $installParent) { throw "Invalid install directory: $TargetInstallDir" }
        if (Test-Path -LiteralPath $installPath) {
            if (-not (Test-Path -LiteralPath $installPath -PathType Container)) { throw "Install path is not a directory: $installPath" }
            $currentVersion = Assert-ZhiyiManifest (Read-Manifest $installPath) 'Current install'
        }
        $workRoot = Join-Path ([IO.Path]::GetTempPath()) ('ZhiyiSetup-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
        $package = Resolve-ZhiyiPackage $LocalPackagePath $RequestedVersion $workRoot
        $targetManifest = $null
        $targetVersion = $null
        if ($currentVersion) {
            $targetManifest = Read-ZhiyiPackageManifest $package.ZipPath
            $targetVersion = Assert-ZhiyiManifest $targetManifest 'Target package'
            if ($package.Version -and $package.Version -ne $targetVersion) { throw "Requested version $($package.Version) does not match manifest version $targetVersion." }
            $comparison = Compare-ChromeVersion $currentVersion $targetVersion
            if ($comparison -gt 0) { throw "Refusing downgrade from $currentVersion to $targetVersion." }
            if ($comparison -eq 0) { Write-Host "AlreadyCurrent: $currentVersion"; return 0 }
        }
        if (-not $DryRun) { New-Item -ItemType Directory -Path $installParent -Force | Out-Null }
        $stageParent = if (Test-Path -LiteralPath $installParent -PathType Container) { $installParent } else { [IO.Path]::GetTempPath() }
        $stagePath = Join-Path $stageParent ('.Zhiyi.staging-' + [guid]::NewGuid().ToString('N'))
        Expand-ZhiyiPackage $package.ZipPath $stagePath
        if (-not $targetManifest) {
            $targetManifest = Read-Manifest $stagePath
            $targetVersion = Assert-ZhiyiManifest $targetManifest 'Target package'
        }
        if ($package.Version -and $package.Version -ne $targetVersion) { throw "Requested version $($package.Version) does not match manifest version $targetVersion." }
        $operation = if ($currentVersion) { 'Updated' } else { 'Installed' }
        Write-Host "$operation target: $targetVersion"
        if ($DryRun) { return 0 }
        $backupRoot = Join-Path $installParent '.backups'
        if ($currentVersion) {
            New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
            $backupPath = Join-Path $backupRoot ($currentVersion + '-' + [DateTime]::UtcNow.ToString("yyyyMMdd'T'HHmmssfff'Z'"))
            try { Move-Item -LiteralPath $installPath -Destination $backupPath -Force -ErrorAction Stop }
            catch { $preserveStage = $true; throw }
            $movedCurrent = $true
        }
        try { Move-Item -LiteralPath $stagePath -Destination $installPath -Force -ErrorAction Stop }
        catch { $preserveStage = $true; throw }
        $stagePath = $null
        $movedStage = $true
        $installedVersion = Assert-ZhiyiManifest (Read-Manifest $installPath) 'Installed package'
        if ($installedVersion -ne $targetVersion) { throw 'Installed manifest validation failed.' }
        if ($currentVersion) { Keep-RecentBackups $backupRoot }
        Write-Host ($operation + ': ' + $targetVersion)
        Write-Host ('Extension directory: ' + $installPath)
        if ($operation -eq 'Installed') {
            Write-Host 'First install: enable Developer mode in chrome://extensions, choose Load unpacked, and select the directory above.'
        } else {
            Write-Host 'Update: click the extension card refresh button, then refresh open web pages.'
        }
        if (-not $SkipBrowser) { Open-ChromeExtensionsPage }
        return 0
    } catch {
        $message = $_.Exception.Message
        try {
            if ($movedStage -and (Test-Path -LiteralPath $installPath -PathType Container)) {
                Remove-Item -LiteralPath $installPath -Recurse -Force -ErrorAction Stop
                if (Test-Path -LiteralPath $installPath) { throw 'new installation directory still exists' }
            }
            if ($movedCurrent -and $backupPath -and (Test-Path -LiteralPath $backupPath -PathType Container)) {
                if (Test-Path -LiteralPath $installPath) { throw 'cannot restore backup because install path still exists' }
                Move-Item -LiteralPath $backupPath -Destination $installPath -Force -ErrorAction Stop
                Write-Warning 'Previous installation restored.'
            }
        } catch { throw "$message Rollback failed: $($_.Exception.Message)" }
        Write-Error $message
        return 1
    } finally {
        if ($stagePath -and (Test-Path -LiteralPath $stagePath)) {
            if ($preserveStage) { Write-Warning ('Staging retained for retry: ' + $stagePath) }
            else {
                try { Remove-Item -LiteralPath $stagePath -Recurse -Force -ErrorAction Stop }
                catch { Write-Warning "Could not clean staging '$stagePath': $($_.Exception.Message)" }
            }
        }
        if ($workRoot -and (Test-Path -LiteralPath $workRoot)) {
            try { Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction Stop }
            catch { Write-Warning "Could not clean temporary download '$workRoot': $($_.Exception.Message)" }
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    exit (Invoke-ZhiyiSetup -LocalPackagePath $PackagePath -RequestedVersion $Version -TargetInstallDir $InstallDir -SkipBrowser ([bool]$NoOpenBrowser) -DryRun ([bool]$WhatIf))
}
