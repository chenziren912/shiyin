using System.Collections.Concurrent;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace VinylMV.Core;

public sealed record BatchRenderItem(string Id, RenderRequest Request, string Album = "", string Genres = "", string AiPrompt = "");
public sealed record BatchRequest(BatchRenderItem[] Items, bool SearchLyrics = true, string MissingLyrics = "instrumental", bool ContinueOnError = true,
    string MissingLyricsText = "该歌曲暂无可用歌词", int MaxParallel = 3, bool AutoEncoder = true, int ResourceThreshold = 85, bool UseAiBackgrounds = false);
public sealed record BatchResult(string Id, string Status, string? Output = null, string? Message = null, string? Encoder = null);

public sealed class BatchRenderService(IRenderWorker renderer, LyricsService lyrics, IBatchEncoderSelector? optimization = null,
    Func<IResourceMonitor>? monitorFactory = null, int rampMilliseconds = 1500)
{
    public bool IsRunning { get; private set; }
    public async Task<IReadOnlyList<BatchResult>> RunAsync(BatchRequest request, Action<object> progress, CancellationToken token, IAiBatchBackgrounds? aiBackgrounds = null)
    {
        if (IsRunning || renderer.IsRunning) throw new IOException("已有生成任务正在运行。");
        if (request.Items.Length is < 1 or > 500 || request.Items.Select(i => i.Id).Distinct().Count() != request.Items.Length)
            throw new IOException("批量任务应包含 1–500 首音乐，且任务标识不能重复。");
        if (request.MaxParallel is < 1 or > 16 || request.ResourceThreshold is < 50 or > 95) throw new IOException("批量并发设置无效。");
        if (request.UseAiBackgrounds && aiBackgrounds == null) throw new IOException("AI 背景服务尚未配置。");
        if (request.MissingLyrics is not ("instrumental" or "message" or "skip")) throw new IOException("缺失歌词处理选项无效。");
        if (request.MissingLyrics == "message" && (string.IsNullOrWhiteSpace(request.MissingLyricsText) || request.MissingLyricsText.Length > 300))
            throw new IOException("固定歌词文字应为 1–300 个字符，不能只有空白。");
        IsRunning = true;
        var results = new BatchResult?[request.Items.Length];
        var active = new Dictionary<Task<BatchResult>, int>();
        var failedHardware = new ConcurrentDictionary<string, byte>();
        var plans = new List<IReadOnlyList<EncoderCandidate>>();
        var reportCache = new Dictionary<string, IReadOnlyList<EncoderCandidate>>();
        var progressLock = new object();
        void Report(object value) { lock (progressLock) progress(value); }
        int next = 0; bool stop = false;
        try
        {
            // Calibrate distinct profiles before competing exports distort the measurement.
            foreach (var item in request.Items)
            {
                token.ThrowIfCancellationRequested();
                var profile = new BenchmarkProfile(item.Request.Container, item.Request.Width, item.Request.Height, item.Request.Fps, item.Request.Encoding, request.MaxParallel,
                    item.Request.ShowSpectrum, item.Request.Layout);
                // Keep per-row manual backends distinct when automatic detection was declined or disabled.
                string key = DevicePerformanceService.Key(profile, new("", 0, [], "queue")) + "|" + DevicePerformanceService.Manual(item.Request).Encoder;
                if (!reportCache.TryGetValue(key, out var choices))
                {
                    if (request.AutoEncoder && optimization != null)
                    {
                        Report(new { item.Id, status = "optimizing", message = "正在匹配本机编码性能记录，缺少记录时进行短片测速" });
                        choices = await optimization.CandidatesAsync(item.Request, request.MaxParallel, data => Report(new { item.Id, status = "optimizing", data }), token);
                    }
                    else choices = [DevicePerformanceService.Manual(item.Request)];
                    if (choices.Count == 0) throw new IOException("没有可用于当前参数的编码器。");
                    reportCache[key] = choices;
                }
                plans.Add(choices);
            }
            using var monitor = await Task.Run(() => monitorFactory?.Invoke() ?? new ResourceMonitor(), token);
            DateTimeOffset lastLaunch = DateTimeOffset.MinValue;
            while (next < request.Items.Length || active.Count > 0)
            {
                foreach (var task in active.Keys.Where(t => t.IsCompleted).ToArray())
                {
                    var index = active[task]; active.Remove(task); results[index] = await task;
                    if (results[index]!.Status == "failed" && !request.ContinueOnError) stop = true;
                }
                if (token.IsCancellationRequested || stop)
                {
                    while (next < request.Items.Length)
                    {
                        var pending = new BatchResult(request.Items[next].Id, token.IsCancellationRequested ? "cancelled" : "skipped",
                            Message: token.IsCancellationRequested ? "任务未执行" : "已有任务失败，已停止新增任务");
                        results[next++] = pending; Report(pending);
                    }
                }
                var load = await Task.Run(monitor.Sample);
                Report(new { @event = "scheduler", active = active.Count, pending = request.Items.Length - next, maximum = request.MaxParallel,
                    cpu = load.Cpu, gpu = load.Gpu, waiting = active.Count > 0 && next < request.Items.Length });
                if (next < request.Items.Length && active.Count < request.MaxParallel &&
                    (active.Count == 0 || (DateTimeOffset.UtcNow - lastLaunch).TotalMilliseconds >= rampMilliseconds))
                {
                    var candidates = plans[next].Where(c => !failedHardware.ContainsKey(c.Encoder)).ToArray();
                    var chosen = BatchDispatchPolicy.Choose(candidates, load, active.Count > 0, request.ResourceThreshold);
                    if (chosen != null)
                    {
                        int index = next++;
                        active.Add(RunOne(index, chosen), index); lastLaunch = DateTimeOffset.UtcNow;
                        continue;
                    }
                    if (active.Count == 0)
                    {
                        var failed = new BatchResult(request.Items[next].Id, "failed", Message: "当前参数的可用编码器均已失败，请重新检测或修改设置。");
                        results[next++] = failed; Report(failed); stop = !request.ContinueOnError; continue;
                    }
                }
                if (active.Count > 0) await Task.WhenAny(active.Keys.Cast<Task>().Append(Task.Delay(Math.Min(1000, Math.Max(20, rampMilliseconds)))));
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        finally
        {
            foreach (var pair in active) results[pair.Value] = await pair.Key;
            IsRunning = false;
            Report(new { @event = "scheduler", active = 0, pending = 0, maximum = request.MaxParallel, stopped = true });
        }
        for (int index = 0; index < results.Length; index++)
            if (results[index] == null) { results[index] = new(request.Items[index].Id, "cancelled", Message: "任务未执行"); Report(results[index]!); }
        return results.Select(r => r!).ToArray();

        async Task<BatchResult> RunOne(int index, EncoderCandidate chosen)
        {
            var item = request.Items[index]; string? warning = null;
            try
            {
                var render = item.Request with { Encoding = chosen.Settings };
                if (!HasLyrics(render.Lyrics)) render = render with { Lyrics = "" };
                Report(new { item.Id, status = "preparing", encoder = chosen.Label, message = "正在准备歌词与素材" });
                if (string.IsNullOrWhiteSpace(render.Lyrics) && request.SearchLyrics)
                {
                    try
                    {
                        var matches = await lyrics.SearchAsync(render.Title, render.Artist, item.Album, render.Duration, null, token);
                        var match = matches.FirstOrDefault(m => m.Score >= 65 && HasLyrics(m.SyncedLyrics));
                        if (match != null) render = render with { Lyrics = match.SyncedLyrics! };
                    }
                    catch (Exception error) when (!token.IsCancellationRequested && error is IOException or JsonException or System.Net.Http.HttpRequestException)
                    { warning = "在线歌词匹配失败"; }
                }
                if (string.IsNullOrWhiteSpace(render.Lyrics))
                {
                    if (request.MissingLyrics == "skip") return Finish(new(item.Id, "skipped", Message: "没有时间轴歌词，已按设置跳过"));
                    bool message = request.MissingLyrics == "message";
                    render = render with { EmptyLyricsText = message ? request.MissingLyricsText.Trim() : "" };
                    warning = (warning == null ? "" : warning + "；") + (message ? "没有时间轴歌词，已显示自定义固定文字" : "没有时间轴歌词，已导出无歌词画面");
                }
                if (request.UseAiBackgrounds && aiBackgrounds != null && (aiBackgrounds.Mode == "all" || string.IsNullOrWhiteSpace(render.BackgroundPath) || !File.Exists(render.BackgroundPath)))
                {
                    try
                    {
                        var generated = await aiBackgrounds.GenerateAsync(new(render.Title, render.Artist, item.Genres, render.Lyrics, render.Duration, render.Layout, item.AiPrompt),
                            value => Report(new { item.Id, status = value.Phase, message = value.Message, ai = value }), token);
                        render = render with { BackgroundPath = generated.Video.Path };
                        if (generated.Warning != null) warning = (warning == null ? "" : warning + "；") + generated.Warning;
                    }
                    catch (Exception error) when (!token.IsCancellationRequested && error is IOException or System.Net.Http.HttpRequestException or UnauthorizedAccessException)
                    {
                        if (aiBackgrounds.Failure == "skip") return Finish(new(item.Id, "skipped", Message: "AI 背景生成失败，已按设置跳过此音乐"));
                        if (aiBackgrounds.Failure == "library" && !string.IsNullOrWhiteSpace(render.BackgroundPath) && File.Exists(render.BackgroundPath))
                        {
                            warning = (warning == null ? "" : warning + "；") + "AI 背景未成功，已回退已分配的视频库背景";
                            Report(new { item.Id, status = "ai_fallback", message = warning });
                        }
                        else throw new IOException(error.Message + (aiBackgrounds.Failure == "library" ? "；没有可用的视频库背景可供回退。" : ""));
                    }
                }
                string output;
                try { output = await renderer.Fork().RenderAsync(render, Update, token); }
                catch (IOException) when (request.AutoEncoder && chosen.Measured && chosen.Encoder != "software" && !token.IsCancellationRequested && plans[index].Any(c => c.Encoder == "software"))
                {
                    failedHardware.TryAdd(chosen.Encoder, 0);
                    chosen = plans[index].First(c => c.Encoder == "software");
                    render = render with { Encoding = chosen.Settings };
                    warning = (warning == null ? "" : warning + "；") + "硬件编码失败，已回退 CPU";
                    Report(new { item.Id, status = "rendering", encoder = chosen.Label, message = "硬件编码失败，正在使用 CPU 重试" });
                    output = await renderer.Fork().RenderAsync(render, Update, token);
                }
                return Finish(new(item.Id, "completed", output, warning, chosen.Label));
                void Update(object data) => Report(new { item.Id, status = "rendering", encoder = chosen.Label, data });
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return Finish(new(item.Id, "cancelled", Message: "已停止当前任务", Encoder: chosen.Label)); }
            catch (Exception error)
            {
                var message = error.Message.Any(c => c is >= '\u4e00' and <= '\u9fff') ? error.Message : "生成失败，请检查素材与输出目录。";
                return Finish(new(item.Id, "failed", Message: message, Encoder: chosen.Label));
            }
            BatchResult Finish(BatchResult value) { Report(value); return value; }
        }
    }
    private static bool HasLyrics(string? value) => (value ?? "").Split('\n').Any(line =>
    {
        var time = Regex.Match(line, @"\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\]");
        return time.Success && !string.IsNullOrWhiteSpace(Regex.Replace(line[(time.Index + time.Length)..], @"\[[^\]]*\]", ""));
    });
}
