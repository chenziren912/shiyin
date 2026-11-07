$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskTools = Join-Path $taskRoot '.tools'
New-Item -ItemType Directory -Force -Path $taskTools | Out-Null
$taskMetadata = Invoke-RestMethod -Uri 'https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json'
$taskRelease = $taskMetadata.releases | Where-Object { $_.'release-version' -match '^10\.0\.\d+$' } | Select-Object -First 1
$taskCore = $taskRelease.runtime.files | Where-Object { $_.name -eq 'dotnet-runtime-win-x64.zip' } | Select-Object -First 1
$taskDesktop = $taskRelease.windowsdesktop.files | Where-Object { $_.name -eq 'windowsdesktop-runtime-win-x64.zip' } | Select-Object -First 1
$taskHashes = @{}
foreach ($taskComponent in @(@{Name='Core';File='dotnet-runtime.zip';Item=$taskCore}, @{Name='Desktop';File='windowsdesktop-runtime.zip';Item=$taskDesktop})) {
    $taskUrl = [Uri]$taskComponent.Item.url
    if ($taskUrl.Scheme -ne 'https' -or $taskUrl.Host -ne 'builds.dotnet.microsoft.com') { throw '运行环境下载源不正确' }
    $taskFile = Join-Path $taskTools $taskComponent.File
    if (-not (Test-Path -LiteralPath $taskFile) -or (Get-FileHash -LiteralPath $taskFile -Algorithm SHA512).Hash -ne $taskComponent.Item.hash) {
        Invoke-WebRequest -Uri $taskUrl -OutFile $taskFile
    }
    if ((Get-FileHash -LiteralPath $taskFile -Algorithm SHA512).Hash -ne $taskComponent.Item.hash) { throw '微软官方运行环境 SHA-512 校验失败' }
    $taskHashes[$taskComponent.Name] = (Get-FileHash -LiteralPath $taskFile -Algorithm SHA256).Hash.ToLowerInvariant()
}
$taskInclude = @"
; 自动生成：下载内容已与微软官方发布元数据中的 SHA-512 核对。
#define RuntimeVersion "$($taskRelease.windowsdesktop.version)"
#define CoreRuntimeUrl "$($taskCore.url)"
#define DesktopRuntimeUrl "$($taskDesktop.url)"
#define CoreRuntimeHash "$($taskHashes.Core)"
#define DesktopRuntimeHash "$($taskHashes.Desktop)"
"@
[IO.File]::WriteAllText((Join-Path $taskRoot 'installer\prerequisites.iss'), $taskInclude, [Text.UTF8Encoding]::new($false))
Write-Output ('已验证运行环境：' + $taskRelease.windowsdesktop.version)
