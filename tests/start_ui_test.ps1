param([int]$Port = 9224, [switch]$Visible, [string]$AudioPath = '', [string]$BackgroundPath = '', [string]$BatchFixture = '', [switch]$TestDevicePrompt)
$ErrorActionPreference = 'Stop'
$testRoot = Split-Path -Parent $PSScriptRoot
$testListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
try { $testListener.Start() }
catch { throw "验证端口 $Port 已被使用，请通过 -Port 指定其他端口；不会停止现有程序。" }
finally { $testListener.Stop() }
$testRun = [Guid]::NewGuid().ToString('N')
$testApp = Join-Path $testRoot ('.test-output\界面验证-' + $testRun)
New-Item -ItemType Directory -Path $testApp -Force | Out-Null
$testExe = Join-Path $testApp 'VinylMV.exe'
Copy-Item -Path (Join-Path $testRoot 'artifacts\publish\*') -Destination $testApp -Recurse -Force
if (-not $TestDevicePrompt) { Set-Content -LiteralPath (Join-Path $testApp 'device-performance.json') -Value '{"version":1,"decision":"declined"}' -Encoding UTF8 }
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=' + $Port + ' --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows'
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $testApp 'webview-test-profile'
$env:VINYLMV_DEVTOOLS = '1'
if (-not $Visible) { $env:VINYLMV_TEST_MODE = '1' }
try {
    $testMedia = Join-Path $testRoot ".test-output\中文路径 ' [测试]"
    if (-not $AudioPath) { $AudioPath = Join-Path $testMedia '测试音乐.mp3' }
    if (-not $BackgroundPath) { $BackgroundPath = Join-Path $testMedia '短背景.mp4' }
    $testArgs = @(('"' + $AudioPath + '"'), '--background', ('"' + $BackgroundPath + '"'))
    if ($BatchFixture) {
        $testBatch = Get-Content -LiteralPath (Join-Path $BatchFixture 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $testArgs = @('--batch') + @($testBatch.audio | ForEach-Object { '"' + $_ + '"' }) + @('--videos') + @($testBatch.videos | ForEach-Object { '"' + $_ + '"' })
    }
    $testStarted = Start-Process -FilePath $testExe -ArgumentList $testArgs -WorkingDirectory $testApp -WindowStyle Hidden -PassThru
    [PSCustomObject]@{ ProcessId = $testStarted.Id; Path = $testExe; TestPort = $Port }
} finally {
    Remove-Item Env:\WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, Env:\WEBVIEW2_USER_DATA_FOLDER, Env:\VINYLMV_DEVTOOLS
    if (-not $Visible) { Remove-Item Env:\VINYLMV_TEST_MODE }
}
