using System.Collections.Concurrent;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using VinylMV.Core;

internal static class AiVideoChecks
{
    public static async Task Run(string root, string fixtureFile, DependencyService dependencies, Action<bool, string> check)
    {
        var fixture = JsonNode.Parse(await File.ReadAllTextAsync(fixtureFile))!;
        string url = fixture["baseUrl"]!.GetValue<string>();
        string directory = Path.Combine(root, "ai-video-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
        using var http = new HttpClient();
        async Task Control(string scenario, bool reset = true) { using var response = await http.PostAsync(fixture["control"]!.GetValue<string>(), new StringContent(JsonSerializer.Serialize(new { scenario, reset }), Encoding.UTF8, "application/json")); response.EnsureSuccessStatusCode(); }
        async Task<JsonNode> Status() => JsonNode.Parse(await http.GetStringAsync(fixture["status"]!.GetValue<string>()))!;
        AiVideoSettings Profile(string name) => new() { Enabled = true, BaseUrl = url, ApiKey = "fixture-key", Model = "fixture-video", Seconds = 4, PollSeconds = 1, MaxConcurrent = 1, Directory = Path.Combine(directory, name), HeadersJson = "{\"X-Fixture\":\"internal\"}", OptimizerModel = "fixture-text" };
        var settings = Profile("standard");
        var store = new AiVideoSettingsStore(Path.Combine(directory, "settings.dat"));
        await store.SaveAsync(settings, CancellationToken.None);
        check(!Encoding.UTF8.GetString(await File.ReadAllBytesAsync(Path.Combine(directory, "settings.dat"))).Contains("fixture-key"), "AI 配置与密钥通过 Windows 用户加密保存");
        var restored = new AiVideoSettingsStore(Path.Combine(directory, "settings.dat")); restored.Load();
        check(restored.Current.ApiKey == settings.ApiKey && restored.Current.BaseUrl == settings.BaseUrl && restored.Current.Public().ApiKey == "", "AI 配置重启恢复，公开设置不返回密钥");
        check(restored.Merge(settings.Public()).ApiKey == "fixture-key" && restored.Merge(settings.Public(), true).ApiKey.Length == 0, "空密钥保留与显式清除行为正确");
        bool rejected = false; try { (settings with { MaxConcurrent = 9 }).Validate(); } catch (IOException) { rejected = true; }
        check(rejected, "拒绝超出上限的 AI 生成并发");
        rejected = false; try { (settings with { Seconds = 6 }).Validate(); } catch (IOException) { rejected = true; }
        check(rejected, "标准 Videos 拒绝不支持的时长，通用接口可单独配置");
        var layout = JsonSerializer.SerializeToElement(new { cards = new[] { new { id = "lyrics", enabled = true, x = .4, y = .1, width = .55, height = .65 } } });
        var song = new AiVideoSong("Moonlight", "测试歌手", "Rock", "[00:00]Private lyric fragment", Layout: layout);
        string local = AiVideoPrompt.Compose(settings, song);
        check(local.Contains("lyrics overlay") && local.Contains("No embedded words") && !local.Contains("Private lyric fragment"), "提示词按卡片预留空间，默认不发送歌词");
        check(AiVideoPrompt.Compose(settings with { IncludeLyrics = true }, song).Contains("Private lyric fragment") && !AiVideoPrompt.CleanLyrics(song.Lyrics, 100).Contains("[00:"), "歌词参考可选并移除 LRC 时间戳");
        check(AiVideoPrompt.Compose(settings with { Language = "zh" }, song).Contains("创作一段原创滚动歌词") && AiVideoPrompt.Compose(settings, song with { Prompt = "用户手写提示词" }) == "用户手写提示词", "提供中文提示词并保留单首手写内容");
        var typed = AiVideoHttp.Body(settings with { Protocol = "json", RequestJson = "{\"prompt\":\"{prompt}\",\"duration\":\"{seconds}\",\"seed\":\"{seed}\",\"audio\":\"{generateAudio}\"}", Seed = 17 }, "带有 \" 引号的提示词\n下一行");
        check(typed["duration"]!.GetValue<int>() == 4 && typed["seed"]!.GetValue<int>() == 17 && !typed["audio"]!.GetValue<bool>() && typed["prompt"]!.GetValue<string>().Contains('"'), "通用 JSON 模板保留类型并安全处理引号和换行");
        var media = new MediaService(dependencies); var library = new VideoLibrary(Path.Combine(directory, "library.json"));
        await Control("async");
        var events = new List<AiVideoProgress>();
        AiGeneratedBackground generated;
        using (var run = new AiBackgroundRun(settings, media, library, path => path, settings.Directory))
        {
            generated = await run.GenerateAsync(song, events.Add, CancellationToken.None);
            var cached = await run.GenerateAsync(song, events.Add, CancellationToken.None);
            check(File.Exists(generated.Video.Path) && generated.Video.Duration > 0 && cached.Cached && cached.Video.Path == generated.Video.Path, "标准表单提交、异步查询、下载与真实视频校验和缓存复用通过");
        }
        var status = await Status();
        check(status["creates"]!.GetValue<int>() == 1 && status["formOk"]!.GetValue<bool>() && status["requestAuth"]!.GetValue<bool>(), "Videos 使用完整 multipart 字段且不重复创建缓存任务");
        check(!status["cdnAuth"]!.GetValue<bool>() && (await library.LoadAsync(CancellationToken.None)).Single().Genres.Contains("摇滚"), "外部下载站点不收到认证头，成片加入风格视频库");
        await Control("async");
        using (var run = new AiBackgroundRun(Profile("concurrent"), media, library, path => path, directory))
            await Task.WhenAll(Enumerable.Range(0, 3).Select(index => run.GenerateAsync(song with { Title = "并发" + index }, _ => { }, CancellationToken.None)));
        status = await Status(); check(status["peak"]!.GetValue<int>() == 1 && status["creates"]!.GetValue<int>() == 3, "多个歌曲严格遵守独立 AI 并发上限");
        await Control("nested");
        var custom = Profile("custom") with { Protocol = "json", CreatePath = "custom", PollPath = "custom/{id}", ContentPath = "", IdPath = "data.task.id", StatusPath = "data.task.state", ProgressPath = "data.task.percent", SuccessStates = "done", UrlPath = "data.result.files[0].url", RequestJson = "{\"model\":\"{model}\",\"prompt\":\"{prompt}\",\"duration\":\"{seconds}\"}" };
        using (var run = new AiBackgroundRun(custom, media, library, path => path, directory)) await run.GenerateAsync(song, _ => { }, CancellationToken.None);
        status = await Status(); check(status["lastBody"]!["duration"]!.GetValue<int>() == 4 && status["downloads"]!.GetValue<int>() == 1, "通用 JSON、嵌套任务字段、数组 URL 和自定义成功状态通过");
        await Control("instant");
        using (var run = new AiBackgroundRun(Profile("instant") with { Protocol = "json" }, media, library, path => path, directory)) await run.GenerateAsync(song, _ => { }, CancellationToken.None);
        status = await Status(); check(status["polls"]!.GetValue<int>() == 0 && !status["cdnAuth"]!.GetValue<bool>(), "同步视频 URL 可直接下载且不转发密钥");
        await Control("async");
        using (var run = new AiBackgroundRun(Profile("optimized") with { Optimize = true }, media, library, path => path, directory))
        { var optimized = await run.GenerateAsync(song, _ => { }, CancellationToken.None); check(optimized.Prompt.Contains("quiet moonlit") && optimized.Prompt.Contains("lyrics overlay"), "文字模型实际优化后补充画面约束"); }
        status = await Status(); check(status["optimized"]!.GetValue<int>() == 1, "提示词优化走独立文字模型接口");
        await Control("optim-fail");
        using (var run = new AiBackgroundRun(Profile("optim-fallback") with { Optimize = true }, media, library, path => path, directory))
        { var fallback = await run.GenerateAsync(song, _ => { }, CancellationToken.None); check(fallback.Warning?.Contains("内置") == true, "文字模型失败可回退内置提示词后继续生成"); }
        await Control("pending"); var resumeProfile = Profile("resume");
        using (var cancel = new CancellationTokenSource())
        using (var run = new AiBackgroundRun(resumeProfile, media, library, path => path, directory))
        {
            bool cancelled = false;
            try { await run.GenerateAsync(song, value => { if (value.Percent.HasValue) cancel.Cancel(); }, cancel.Token); } catch (OperationCanceledException) { cancelled = true; }
            check(cancelled && Directory.GetFiles(Path.Combine(resumeProfile.Directory, ".tasks")).Length == 1, "停止查询保留已提交任务编号");
        }
        await Control("async", false);
        using (var run = new AiBackgroundRun(resumeProfile, media, library, path => path, directory))
        { var resumed = await run.GenerateAsync(song, _ => { }, CancellationToken.None); check(resumed.Resumed && (await Status())["creates"]!.GetValue<int>() == 1, "重新运行继续旧任务，无重复提交"); }
        foreach (string failure in new[] { "failed", "invalid-media", "too-large", "drop-post" })
        {
            await Control(failure); string? error = null; var bad = Profile(failure) with { DownloadLimitMb = 1 };
            using (var run = new AiBackgroundRun(bad, media, library, path => path, directory))
            { try { await run.GenerateAsync(song, _ => { }, CancellationToken.None); } catch (IOException exception) { error = exception.Message; } }
            status = await Status();
            bool clean = !Directory.Exists(bad.Directory) || !Directory.EnumerateFiles(bad.Directory, "*.part", SearchOption.AllDirectories).Any() && !Directory.EnumerateFiles(bad.Directory, "*.mp4").Any();
            check(error != null && !error.Contains("fixture-key") && clean, "失败不留损坏视频或泄露密钥：" + failure);
            if (failure == "drop-post") check(status["creates"]!.GetValue<int>() == 1, "创建任务网络异常时不自动重发 POST");
        }
        await Control("throttle");
        using (var run = new AiBackgroundRun(Profile("throttle"), media, library, path => path, directory)) await run.GenerateAsync(song, _ => { }, CancellationToken.None);
        check((await Status())["creates"]!.GetValue<int>() == 1, "查询限速重试不增加创建任务次数");
        using (var client = new AiVideoHttp(settings)) check((await client.ModelsAsync(CancellationToken.None)).Contains("fixture-video"), "模型列表查询真实通过模拟 HTTP 接口");

        var calls = new ConcurrentBag<RenderRequest>(); var worker = new CaptureWorker(calls);
        using var lyrics = new LyricsService();
        var batch = new BatchRenderService(worker, lyrics, monitorFactory: () => new QuietMonitor(), rampMilliseconds: 1);
        var request = new RenderRequest("fixture.mp3", generated.Video.Path, null, song.Title, song.Artist, "[00:00]歌词", 1, 100, 45, 44, 854, 480, 24, directory, "fixture.mp4", ShowSpectrum: false);
        var fake = new FakeAi(generated, fail: false);
        var results = await batch.RunAsync(new([new("one", request, Genres: "Rock")], SearchLyrics: false, AutoEncoder: false, UseAiBackgrounds: true), _ => { }, CancellationToken.None, fake);
        check(results.Single().Status == "completed" && fake.Calls == 1 && calls.Single().BackgroundPath == generated.Video.Path, "批量在歌词准备后接入 AI 背景并交给渲染器");
        fake = new(generated, fail: false);
        await batch.RunAsync(new([new("skip", request with { Lyrics = "" })], SearchLyrics: false, MissingLyrics: "skip", AutoEncoder: false, UseAiBackgrounds: true), _ => { }, CancellationToken.None, fake);
        check(fake.Calls == 0, "按缺歌词策略跳过的歌曲不调用视频生成 API");
        foreach (string behavior in new[] { "library", "skip", "fail" })
        {
            fake = new(generated, fail: true) { Failure = behavior };
            results = await batch.RunAsync(new([new("fallback", request)], SearchLyrics: false, AutoEncoder: false, UseAiBackgrounds: true), _ => { }, CancellationToken.None, fake);
            check(results.Single().Status == (behavior == "library" ? "completed" : behavior == "skip" ? "skipped" : "failed"), "AI 背景失败策略正确：" + behavior);
        }
        fake = new(generated, false) { Mode = "missing" };
        await batch.RunAsync(new([new("existing", request)], SearchLyrics: false, AutoEncoder: false, UseAiBackgrounds: true), _ => { }, CancellationToken.None, fake);
        check(fake.Calls == 0, "仅缺少背景时生成的模式保留现有视频库分配");
        await File.WriteAllTextAsync(Path.Combine(directory, "result.json"), JsonSerializer.Serialize(new { passed = true, generated = generated.Video.Path, events, endpoint = url }, new JsonSerializerOptions(AppPaths.Json) { WriteIndented = true }));
        Console.WriteLine("AI 视频接口验证证据：" + directory);
    }
    private sealed class QuietMonitor : IResourceMonitor { public ResourceLoad Sample() => new(0, 0); public void Dispose() { } }
    private sealed class CaptureWorker(ConcurrentBag<RenderRequest> requests) : IRenderWorker
    { public bool IsRunning => false; public IRenderWorker Fork() => new CaptureWorker(requests); public Task<string> RenderAsync(RenderRequest request, Action<object> progress, CancellationToken token) { requests.Add(request); return Task.FromResult(Path.Combine(request.OutputDirectory, request.FileName)); } }
    private sealed class FakeAi(AiGeneratedBackground background, bool fail) : IAiBatchBackgrounds
    { public int Calls; public string Mode { get; init; } = "all"; public string Failure { get; init; } = "library"; public Task<AiGeneratedBackground> GenerateAsync(AiVideoSong song, Action<AiVideoProgress> progress, CancellationToken token) { Calls++; if (fail) throw new IOException("模拟服务失败"); return Task.FromResult(background); } }
}
