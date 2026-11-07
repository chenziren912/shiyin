using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace VinylMV.Core;

public sealed class DependencyService
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };
    public Dependencies? Current { get; private set; }

    public async Task<Dependencies> DetectAsync(CancellationToken token = default)
    {
        var ffmpegTask = FindFfmpeg(token);
        var pythonTask = FindPython(token);
        await Task.WhenAll(ffmpegTask, pythonTask);
        return Current = new(await ffmpegTask, await pythonTask);
    }

    private static IEnumerable<string> PathCandidates(string name)
    {
        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            var cleaned = directory.Trim().Trim('"');
            if (cleaned.Length > 0) yield return Path.Combine(cleaned, name);
        }
    }

    private static async Task<Dependency> FindFfmpeg(CancellationToken token)
    {
        var candidates = new List<string>();
        var managed = Path.Combine(AppPaths.Tools, "ffmpeg");
        if (Directory.Exists(managed)) candidates.AddRange(Directory.EnumerateFiles(managed, "ffmpeg.exe", SearchOption.AllDirectories));
        candidates.AddRange(PathCandidates("ffmpeg.exe"));
        foreach (var common in new[] { @"C:\ffmpeg\bin\ffmpeg.exe", Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WinGet", "Links", "ffmpeg.exe") }) candidates.Add(common);
        foreach (var path in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (!File.Exists(path) || !File.Exists(Path.Combine(Path.GetDirectoryName(path)!, "ffprobe.exe"))) continue;
            try
            {
                var version = await ProcessRunner.RunAsync(path, ["-version"], token, 10);
                var filters = await ProcessRunner.RunAsync(path, ["-hide_banner", "-filters"], token, 10);
                var encoders = await ProcessRunner.RunAsync(path, ["-hide_banner", "-encoders"], token, 10);
                if (version.Code == 0 && filters.Output.Contains(" ass ") && filters.Output.Contains(" rotate ")
                    && filters.Output.Contains(" alimiter ") && filters.Output.Contains(" alphamerge ")
                    && encoders.Output.Contains(" libx264 ") && encoders.Output.Contains(" aac "))
                {
                    var number = Regex.Match(version.Output, @"ffmpeg version (\S+)").Groups[1].Value;
                    return new("FFmpeg", true, Path.GetFullPath(path), "FFmpeg " + number, "已检测到视频编码、字幕与音量限制组件");
                }
            }
            catch (Exception ex) when (ex is IOException or System.ComponentModel.Win32Exception or OperationCanceledException) { token.ThrowIfCancellationRequested(); }
        }
        return new("FFmpeg", false, null, "未安装或组件不完整", "需要包含 ffprobe、libass、libx264 的 Windows 64 位版本");
    }

    private static async Task<Dependency> FindPython(CancellationToken token)
    {
        var candidates = new List<string>();
        var managed = Path.Combine(AppPaths.Tools, "python", "python.exe"); candidates.Add(managed);
        candidates.AddRange(PathCandidates("python.exe").Where(p => !p.Contains("WindowsApps", StringComparison.OrdinalIgnoreCase)));
        var programs = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Python");
        if (Directory.Exists(programs)) candidates.AddRange(Directory.EnumerateDirectories(programs).Select(p => Path.Combine(p, "python.exe")));
        foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            using var python = hive.OpenSubKey(@"Software\Python\PythonCore");
            if (python == null) continue;
            foreach (var version in python.GetSubKeyNames())
            {
                using var install = python.OpenSubKey(version + @"\InstallPath");
                if (install?.GetValue("ExecutablePath") is string exe) candidates.Add(exe);
                else if (install?.GetValue("") is string directory) candidates.Add(Path.Combine(directory, "python.exe"));
            }
        }
        foreach (var path in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (!File.Exists(path)) continue;
            try
            {
                var result = await ProcessRunner.RunAsync(path, ["-c", "import sys,json,zlib,subprocess; print('.'.join(map(str,sys.version_info[:3]))); sys.exit(0 if sys.version_info >= (3,9) and sys.version_info < (4,0) else 1)"], token, 10);
                if (result.Code == 0) return new("Python", true, Path.GetFullPath(path), "Python " + result.Output.Trim(), "版本兼容，渲染器仅使用标准库");
            }
            catch (Exception ex) when (ex is IOException or System.ComponentModel.Win32Exception or OperationCanceledException) { token.ThrowIfCancellationRequested(); }
        }
        return new("Python", false, null, "未检测到兼容版本", "支持 Python 3.9 及以上；缺失时安装 3.14 系列正式版");
    }

    public async Task InstallMissingAsync(IProgress<DownloadProgress> progress, CancellationToken token)
    {
        var state = await DetectAsync(token);
        using var downloader = new AdaptiveDownloader();
        if (!state.Ffmpeg.Ready)
        {
            const string url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
            progress.Report(new("FFmpeg", 0, 0, 0, 0, 0, "正在获取最新正式版信息"));
            var checksum = await Http.GetStringAsync(url + ".sha256", token);
            var expected = Regex.Match(checksum, @"\b[0-9a-fA-F]{64}\b").Value;
            if (expected.Length != 64) throw new IOException("无法获取 FFmpeg 官方构建的校验信息。");
            var archive = Path.Combine(AppPaths.Downloads, "ffmpeg.zip");
            await downloader.DownloadAsync(new(url), archive, "FFmpeg", progress, token);
            await using (var stream = File.OpenRead(archive))
            {
                var actual = Convert.ToHexString(await SHA256.HashDataAsync(stream, token));
                if (!actual.Equals(expected, StringComparison.OrdinalIgnoreCase)) { File.Delete(archive); throw new IOException("FFmpeg 的 SHA-256 校验失败，请重新下载。"); }
            }
            progress.Report(new("FFmpeg", 0, 0, 0, 0, 0, "校验通过，正在解压"));
            var folder = Path.Combine(AppPaths.Tools, "ffmpeg", Guid.NewGuid().ToString("N"));
            await Task.Run(() => ZipFile.ExtractToDirectory(archive, folder), token);
            File.Delete(archive);
        }
        if (!state.Python.Ready)
        {
            progress.Report(new("Python", 0, 0, 0, 0, 0, "正在查找 Python 3.14 系列最新可用安装包"));
            var listing = await Http.GetStringAsync("https://www.python.org/ftp/python/", token);
            var versions = Regex.Matches(listing, "href=\"(3\\.14\\.\\d+)/\"")
                .Select(m => m.Groups[1].Value).Distinct().OrderByDescending(v => Version.Parse(v)).ToArray();
            Uri? installer = null;
            foreach (var version in versions)
            {
                var candidate = new Uri($"https://www.python.org/ftp/python/{version}/python-{version}-amd64.exe");
                using var request = new HttpRequestMessage(HttpMethod.Head, candidate);
                using var response = await Http.SendAsync(request, token);
                if (response.IsSuccessStatusCode) { installer = candidate; break; }
            }
            if (installer == null) throw new IOException("未找到可用的 Python 3.14 正式版安装包，请稍后再试或手动安装 Python。");
            var setup = Path.Combine(AppPaths.Downloads, "python-setup.exe");
            await downloader.DownloadAsync(installer, setup, "Python", progress, token);
            progress.Report(new("Python", 0, 0, 0, 0, 0, "正在验证 Python 软件基金会数字签名"));
            await VerifyPythonSignature(setup, token);
            var target = Path.Combine(AppPaths.Tools, "python");
            var info = ProcessRunner.StartInfo(setup, ["/quiet", "InstallAllUsers=0", "PrependPath=0", "Include_test=0", "Include_launcher=0", "Include_pip=0", "Include_doc=0", "Shortcuts=0", "AssociateFiles=0", "TargetDir=" + target]);
            using var process = System.Diagnostics.Process.Start(info) ?? throw new IOException("无法启动 Python 安装程序。");
            progress.Report(new("Python", 0, 0, 0, 0, 0, "正在安装 Python，请稍候（安装阶段无法取消）"));
            // Do not terminate Windows Installer mid-transaction. Honor cancellation immediately afterwards.
            var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync(); await Task.WhenAll(stdout, stderr);
            if (process.ExitCode != 0 && process.ExitCode != 3010) throw new IOException("Python 安装失败，退出代码：" + process.ExitCode);
            File.Delete(setup);
            token.ThrowIfCancellationRequested();
        }
        var final = await DetectAsync(token);
        if (!final.Ready) throw new IOException("依赖安装后仍未通过检测，请查看设置中的组件状态。");
    }

    private static async Task VerifyPythonSignature(string path, CancellationToken token)
    {
        var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
        var info = ProcessRunner.StartInfo(powershell, ["-NoProfile", "-NonInteractive", "-Command", "$s=Get-AuthenticodeSignature -LiteralPath $env:VINYLMV_VERIFY_PATH; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'Python Software Foundation'){exit 2}"]);
        info.Environment["VINYLMV_VERIFY_PATH"] = path;
        using var process = System.Diagnostics.Process.Start(info) ?? throw new IOException("无法检查数字签名。");
        await process.WaitForExitAsync(token);
        if (process.ExitCode != 0) { File.Delete(path); throw new IOException("Python 安装包的数字签名或发布者验证失败，已拒绝执行。"); }
    }
}
