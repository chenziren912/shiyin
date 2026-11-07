param([string]$Iscc = '', [switch]$SkipRuntimeRefresh)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Push-Location $taskRoot
try {
    $taskDotnet = Join-Path $taskRoot '.tools\dotnet\dotnet.exe'
    if (-not (Test-Path -LiteralPath $taskDotnet)) { $taskDotnet = (Get-Command dotnet -ErrorAction Stop).Source }
    $taskPublish = Join-Path $taskRoot 'artifacts\publish'
    & $taskDotnet publish 'src\VinylMV\VinylMV.csproj' -c Release -r win-x64 --self-contained false -o $taskPublish --nologo
    if ($LASTEXITCODE -ne 0) { throw '应用编译失败' }
    foreach ($taskResource in @('Renderer\render.py', 'Renderer\spectrum.py', 'Renderer\lyric_layout.py', 'Renderer\composition.py', 'Renderer\encoding_settings.py', 'Renderer\device_benchmark.py', 'Web\index.html', 'Web\startup.js', 'Web\themes.js', 'Web\themes.css', 'Web\app.js', 'Web\batch.js', 'Web\device.js', 'Web\encoding.js', 'Web\encoding-dialog.html', 'Web\spectrum.js', 'Web\lyric-layout.js', 'Web\composition.js', 'Web\styles.css', 'Web\editor.html', 'Web\editor.js', 'Web\editor.css')) {
        $taskResourcePath = Join-Path $taskPublish $taskResource
        if (-not (Test-Path -LiteralPath $taskResourcePath) -or (Get-Item -LiteralPath $taskResourcePath).Length -eq 0) { throw ('发布文件缺失或为空：' + $taskResource) }
    }
    foreach ($taskAiResource in @('Web\ai-video.js', 'Web\ai-video.css', 'Web\ai-video-dialog.html')) {
        if (-not (Test-Path -LiteralPath (Join-Path $taskPublish $taskAiResource))) { throw ('AI 视频组件缺失：' + $taskAiResource) }
    }
    if (-not $SkipRuntimeRefresh) { & "$PSScriptRoot\prepare-runtime.ps1" }
    $taskBootstrapper = Join-Path $taskRoot '.tools\WebView2Bootstrapper.exe'
    if (-not (Test-Path -LiteralPath $taskBootstrapper)) { Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $taskBootstrapper }
    $taskSignature = Get-AuthenticodeSignature -LiteralPath $taskBootstrapper
    if ($taskSignature.Status -ne 'Valid' -or $taskSignature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'WebView2 引导组件数字签名验证失败' }
    if (-not $Iscc) {
        foreach ($taskCandidate in @((Join-Path $taskRoot '.tools\inno\tools\ISCC.exe'), 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe', 'C:\Program Files\Inno Setup 6\ISCC.exe')) {
            if (Test-Path -LiteralPath $taskCandidate) { $Iscc = $taskCandidate; break }
        }
    }
    if (-not $Iscc) { throw '未找到 Inno Setup 6.7 或以上编译器。使用 -Iscc 指定 ISCC.exe。' }
    & $Iscc ('/DPublishDir=' + $taskPublish) 'installer\setup.iss'
    if ($LASTEXITCODE -ne 0) { throw 'Inno Setup 打包失败' }
    $taskInstaller = Get-Item -LiteralPath (Join-Path $taskRoot 'artifacts\installer\拾音安装程序-0.9.0.exe')
    if ($taskInstaller.Length -gt 50000000) { throw ('安装包超过 50 MB 限制：' + $taskInstaller.Length + ' 字节') }
    $taskSidecars = Get-ChildItem -LiteralPath $taskInstaller.DirectoryName -File | Where-Object { $_.Extension -in '.bin','.msi','.zip','.7z' }
    if ($taskSidecars) { throw '发布目录出现了非 EXE 分发文件' }
    Write-Output ('已生成单个 EXE 安装包：' + $taskInstaller.FullName)
    Write-Output ('安装包大小：' + [Math]::Round($taskInstaller.Length / 1000000, 2) + ' MB（' + $taskInstaller.Length + ' 字节）')
} finally { Pop-Location }
