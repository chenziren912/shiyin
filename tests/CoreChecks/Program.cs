using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using VinylMV.Core;

AppPaths.Initialize();
int passed = 0;
void Check(bool condition, string name) { if (!condition) throw new Exception("检查失败：" + name); Console.WriteLine("通过：" + name); passed++; }
var policy = new DownloadThreadPolicy();
Check(!policy.ShouldAdd(5_000_000, 4), "达到 5 MB/s 不增加线程");
Check(policy.ShouldAdd(1_000_000, 4), "低于 5 MB/s 开始增加线程");
for (int i = 1; i < 10; i++) Check(policy.ShouldAdd(1_000_000, 4 + i), $"第 {i} 次无有效增速，仍可增加线程");
Check(!policy.ShouldAdd(1_000_000, 14) && policy.Frozen && policy.StagnantAdditions == 10, "连续 10 次无有效增速后冻结");
var improving = new DownloadThreadPolicy();
improving.ShouldAdd(1_000_000, 4);
improving.ShouldAdd(1_200_000, 5);
Check(improving.StagnantAdditions == 1, "恰好增加 200 KB/s 不算超过阈值");
improving.ShouldAdd(1_400_001, 6);
Check(improving.StagnantAdditions == 0, "增速超过 200 KB/s 后重新计数");
Check(!new DownloadThreadPolicy().ShouldAdd(0, 32), "最多使用 32 个线程");

var root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", ".test-output", "downloader"));
Directory.CreateDirectory(root);
var incompleteApp = Path.Combine(root, "渲染组件缺失检查");
Directory.CreateDirectory(incompleteApp);
bool incompleteRejected = false;
try { RendererBundle.Validate(incompleteApp); }
catch (IOException error) { incompleteRejected = error.Message.Contains("渲染组件不完整") && error.Message.Contains("render.py"); }
Check(incompleteRejected, "缺少渲染脚本时在启动 Python 之前给出中文修复说明");
var rendererSource = RendererBundle.Validate(Path.GetFullPath(Path.Combine(root, "..", "..", "src", "VinylMV")));
var bundleJob = Path.Combine(root, "bundle-" + Guid.NewGuid().ToString("N"));
var snapshotEntry = RendererBundle.Snapshot(rendererSource, bundleJob);
Check(File.Exists(snapshotEntry) && File.Exists(Path.Combine(bundleJob, "Renderer", "spectrum.py")) && File.Exists(Path.Combine(bundleJob, "Renderer", "lyric_layout.py")) && File.Exists(Path.Combine(bundleJob, "Renderer", "composition.py")) && File.Exists(Path.Combine(bundleJob, "Renderer", "encoding_settings.py")), "每次生成快照完整渲染组件，避免依赖原程序目录");
await using var server = new FixtureServer();
using var downloader = new AdaptiveDownloader();
var observed = new ConcurrentQueue<DownloadProgress>();
await downloader.DownloadAsync(server.Url("ranged"), Path.Combine(root, "ranged.bin"), "测试", new ImmediateProgress(p => observed.Enqueue(p)), CancellationToken.None);
Check(SHA256.HashData(File.ReadAllBytes(Path.Combine(root, "ranged.bin"))).SequenceEqual(SHA256.HashData(server.Data)), "并发分段下载内容完整且散列一致");
Check(server.PeakRequests >= 2, "实际使用多个并发请求");
await downloader.DownloadAsync(server.Url("single"), Path.Combine(root, "single.bin"), "测试", null, CancellationToken.None);
Check(File.ReadAllBytes(Path.Combine(root, "single.bin")).SequenceEqual(server.Data), "不支持 Range 时完整回退单线程");
bool corruptRejected = false;
try { await downloader.DownloadAsync(server.Url("bad"), Path.Combine(root, "bad.bin"), "测试", null, CancellationToken.None); }
catch (IOException) { corruptRejected = true; }
Check(corruptRejected && !File.Exists(Path.Combine(root, "bad.bin")), "错误 Content-Range 不产生损坏的最终文件");
var preserved = Path.Combine(root, "cancel.bin"); File.WriteAllText(preserved, "原文件");
using (var cancel = new CancellationTokenSource(150))
{
    bool cancelled = false;
    try { await downloader.DownloadAsync(server.Url("slow"), preserved, "测试", null, cancel.Token); }
    catch (OperationCanceledException) { cancelled = true; }
    Check(cancelled && File.ReadAllText(preserved) == "原文件", "取消下载保留现有文件");
}
Check(!Directory.EnumerateFiles(root, "*.part").Any(), "失败和取消后清理临时分段文件");
var dependencies = new DependencyService();
var installed = await dependencies.DetectAsync();
Check(installed.Ready, "本机 FFmpeg 与 Python 检测通过");
var source = Path.GetFullPath(Path.Combine(root, "..", "中文路径 ' [测试]", "测试音乐.mp3"));
if (File.Exists(source))
{
    var media = await new MediaService(dependencies).ReadAudioAsync(source, path => new Uri(path).AbsoluteUri, CancellationToken.None);
    Check(media.Title == "湖畔来信" && media.Artist == "拾音测试" && media.LocalLyrics?.Contains("月光") == true, "读取 MP3 中文标签和同名 LRC");
    var samples = Convert.FromBase64String(await new MediaService(dependencies).ReadSpectrumSamplesAsync(source, .2, CancellationToken.None));
    Check(samples.Length > 1000 && samples.Length <= 24000 * 4 && samples.Any(value => value != 0), "静态帧音频分析读取真实 PCM，且不播放声音");
}
if (Array.IndexOf(args, "--formats") is >= 0 and var formatIndex && args.Length > formatIndex + 1)
    await FormatChecks.Run(Path.GetFullPath(args[formatIndex + 1]), dependencies, Check);
if (args.Contains("--batch")) await BatchChecks.Run(root, dependencies, Check);
if (args.Contains("--device")) await DeviceChecks.Run(root, dependencies, Check);
if (Array.IndexOf(args, "--ai-video") is >= 0 and var aiIndex && args.Length > aiIndex + 1)
    await AiVideoChecks.Run(root, Path.GetFullPath(args[aiIndex + 1]), dependencies, Check);
if (args.Contains("--online"))
{
    using var lyricsService = new LyricsService();
    var matches = await lyricsService.SearchAsync("Imagine", "John Lennon", "", 0, "Imagine John Lennon", CancellationToken.None);
    Check(matches.Any(match => !string.IsNullOrWhiteSpace(match.SyncedLyrics)), "真实 LRCLIB 免密钥查询返回时间轴歌词");
}
Console.WriteLine($"全部 {passed} 项核心检查通过。");

sealed class ImmediateProgress(Action<DownloadProgress> report) : IProgress<DownloadProgress> { public void Report(DownloadProgress value) => report(value); }

sealed class FixtureServer : IAsyncDisposable
{
    private readonly TcpListener listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource cancellation = new();
    private readonly Task accept;
    private readonly ConcurrentBag<Task> clients = new();
    private int active, peak;
    public byte[] Data { get; } = new byte[6 * 1024 * 1024 + 17];
    public int PeakRequests => peak;
    public FixtureServer() { new Random(519).NextBytes(Data); listener.Start(); accept = Accept(); }
    public Uri Url(string route) => new($"http://127.0.0.1:{((IPEndPoint)listener.LocalEndpoint).Port}/{route}");
    private async Task Accept()
    {
        try { while (!cancellation.IsCancellationRequested) { var client = await listener.AcceptTcpClientAsync(cancellation.Token); clients.Add(Respond(client)); } }
        catch (OperationCanceledException) { }
    }
    private async Task Respond(TcpClient client)
    {
        using (client)
        {
            int current = Interlocked.Increment(ref active);
            while (true) { int old = peak; if (old >= current || Interlocked.CompareExchange(ref peak, current, old) == old) break; }
            try
            {
                using var stream = client.GetStream();
                using var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
                string first = await reader.ReadLineAsync(cancellation.Token) ?? "";
                var route = first.Split(' ').ElementAtOrDefault(1) ?? "/";
                string? range = null;
                while (await reader.ReadLineAsync(cancellation.Token) is { Length: > 0 } header)
                    if (header.StartsWith("Range:", StringComparison.OrdinalIgnoreCase)) range = header[6..].Trim();
                int start = 0, end = Data.Length - 1;
                bool partial = range != null && route != "/single";
                if (partial) { var parts = range![6..].Split('-'); start = int.Parse(parts[0]); end = int.Parse(parts[1]); }
                if (route == "/slow") await Task.Delay(1000, cancellation.Token);
                else await Task.Delay(20, cancellation.Token);
                int rangeStart = route == "/bad" && start != end ? start + 1 : start;
                string headers = $"HTTP/1.1 {(partial ? "206 Partial Content" : "200 OK")}\r\nContent-Length: {end - start + 1}\r\nETag: \"fixture\"\r\nConnection: close\r\n";
                if (partial) headers += $"Content-Range: bytes {rangeStart}-{end}/{Data.Length}\r\n";
                await stream.WriteAsync(Encoding.ASCII.GetBytes(headers + "\r\n"), cancellation.Token);
                for (int offset = start; offset <= end; offset += 65536)
                    await stream.WriteAsync(Data.AsMemory(offset, Math.Min(65536, end - offset + 1)), cancellation.Token);
            }
            catch (Exception ex) when (ex is IOException or OperationCanceledException or SocketException) { }
            finally { Interlocked.Decrement(ref active); }
        }
    }
    public async ValueTask DisposeAsync() { cancellation.Cancel(); listener.Stop(); await accept; await Task.WhenAll(clients); cancellation.Dispose(); }
}
