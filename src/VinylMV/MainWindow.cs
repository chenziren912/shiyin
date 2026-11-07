using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Input;
using System.Windows.Shell;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Microsoft.Win32;
using VinylMV.Core;

namespace VinylMV;

public sealed class MainWindow : Window
{
    private readonly WebView2 web = new();
    private readonly StartupView startup;
    private readonly SoftwareThemeService softwareThemes;
    private readonly DependencyService dependencies = new();
    private readonly EncodingCapabilityService encodingCapabilities;
    private readonly DevicePerformanceService devicePerformance;
    private readonly LyricsService lyrics = new();
    private readonly MediaService media;
    private readonly RenderService renderer;
    private readonly BatchRenderService batchRenderer;
    private readonly VideoLibrary videoLibrary;
    private readonly AiVideoSettingsStore aiVideoSettings;
    private readonly AiVideoService aiVideos;
    private readonly ConcurrentDictionary<string, byte> batchOutputs = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, string> files = new();
    private readonly CancellationTokenSource lifetime = new();
    private CancellationTokenSource? downloadCancellation, renderCancellation, importCancellation, batchCancellation, benchmarkCancellation;
    private CancellationTokenSource? aiPreviewCancellation;
    private int? importCompleted, importTotal;
    private string? importItemMessage;
    private bool installing;
    private bool startupConsumed;
    private string? lastOutput;

    public MainWindow()
    {
        AppPaths.Initialize(); media = new(dependencies, ReportImportStage); renderer = new(dependencies);
        softwareThemes = new(Path.Combine(Environment.GetEnvironmentVariable("VINYLMV_TEST_MODE") == "1" ? AppContext.BaseDirectory : AppPaths.Root, "software-theme.json"));
        encodingCapabilities = new(dependencies);
        devicePerformance = new(dependencies, Path.Combine(Environment.GetEnvironmentVariable("VINYLMV_TEST_MODE") == "1" ? AppContext.BaseDirectory : AppPaths.Root, "device-performance.json"));
        batchRenderer = new(renderer, lyrics, devicePerformance);
        videoLibrary = new(Path.Combine(Environment.GetEnvironmentVariable("VINYLMV_TEST_MODE") == "1" ? AppContext.BaseDirectory : AppPaths.Root, "video-library.json"));
        var aiStorage = Environment.GetEnvironmentVariable("VINYLMV_TEST_MODE") == "1" ? AppContext.BaseDirectory : AppPaths.Root;
        aiVideoSettings = new(Path.Combine(aiStorage, "ai-video-settings.dat")); aiVideoSettings.Load();
        aiVideos = new(aiVideoSettings, media, videoLibrary, Register, Path.Combine(aiStorage, "ai-backgrounds"));
        Title = "拾音 · 滚动歌词 MV 生成器";
        Width = 1440; Height = 940; MinWidth = 1100; MinHeight = 760;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        if (Environment.GetEnvironmentVariable("VINYLMV_TEST_MODE") == "1") { WindowStartupLocation = WindowStartupLocation.Manual; Left = -20000; Top = -20000; ShowInTaskbar = false; }
        ApplySoftwareTheme();
        WindowStyle = WindowStyle.None;
        WindowChrome.SetWindowChrome(this, new WindowChrome { CaptionHeight = 0, ResizeBorderThickness = new Thickness(6), GlassFrameThickness = new Thickness(0), CornerRadius = new CornerRadius(8) });
        web.Visibility = Visibility.Hidden;
        startup = new StartupView(Close, () => { if (Mouse.LeftButton == MouseButtonState.Pressed) DragMove(); }, softwareThemes.Current);
        var shell = new System.Windows.Controls.Grid();
        shell.Children.Add(web); shell.Children.Add(startup); Content = shell;
        Loaded += Initialize;
        Closing += OnClosing;
        Closed += (_, _) => { lifetime.Cancel(); web.Dispose(); lyrics.Dispose(); lifetime.Dispose(); };
    }

    private void ApplySoftwareTheme()
    {
        var color = (System.Windows.Media.Color)System.Windows.Media.ColorConverter.ConvertFromString(softwareThemes.Current.Background);
        Background = new System.Windows.Media.SolidColorBrush(color);
        web.DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, color.R, color.G, color.B);
    }

    private async void Initialize(object sender, RoutedEventArgs args)
    {
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(AppPaths.Root, "webview"));
            if (lifetime.IsCancellationRequested) return;
            await web.EnsureCoreWebView2Async(environment);
            if (lifetime.IsCancellationRequested) return;
            var core = web.CoreWebView2;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.AreDevToolsEnabled = Debugger.IsAttached || Environment.GetEnvironmentVariable("VINYLMV_DEVTOOLS") == "1";
            core.SetVirtualHostNameToFolderMapping("app.vinyl.local", Path.Combine(AppContext.BaseDirectory, "Web"), CoreWebView2HostResourceAccessKind.DenyCors);
            core.AddWebResourceRequestedFilter("https://media.vinyl.local/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += ServeMedia;
            core.WebMessageReceived += OnMessage;
            core.NavigationStarting += (_, e) => { if (!e.Uri.StartsWith("https://app.vinyl.local/", StringComparison.Ordinal)) e.Cancel = true; };
            core.NewWindowRequested += (_, e) => e.Handled = true;
            core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
            core.NavigationCompleted += (_, e) =>
            {
                if (lifetime.IsCancellationRequested) return;
                if (!e.IsSuccess)
                {
                    MessageBox.Show("无法加载创作工作台，请重新启动或重新安装程序。", "拾音", MessageBoxButton.OK, MessageBoxImage.Error);
                    Close(); return;
                }
                web.Visibility = Visibility.Visible;
                if (startup.Parent is System.Windows.Controls.Grid host) host.Children.Remove(startup);
            };
            core.Navigate("https://app.vinyl.local/index.html");
        }
        catch (Exception ex)
        {
            if (lifetime.IsCancellationRequested) return;
            MessageBox.Show("无法启动界面。请确认已安装 Microsoft Edge WebView2 运行时。\n\n" + ex.Message, "拾音", MessageBoxButton.OK, MessageBoxImage.Error);
            Close();
        }
    }

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (renderer.IsRunning || batchRenderer.IsRunning || devicePerformance.IsRunning || aiPreviewCancellation != null || installing)
        {
            if (MessageBox.Show("任务仍在进行，确定停止任务并退出吗？", "退出拾音", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) { e.Cancel = true; return; }
            if (installing) { MessageBox.Show("请先在依赖窗口取消下载，或等待安装步骤完成后退出。", "拾音"); e.Cancel = true; return; }
        }
        renderCancellation?.Cancel(); batchCancellation?.Cancel(); downloadCancellation?.Cancel(); benchmarkCancellation?.Cancel();
    }

    private string Register(string path)
    {
        var id = Guid.NewGuid().ToString("N"); files[id] = Path.GetFullPath(path);
        return "https://media.vinyl.local/" + id + "/" + Uri.EscapeDataString(Path.GetFileName(path));
    }

    private void ValidateInput(string? path)
    {
        if (path != null && !files.Values.Contains(Path.GetFullPath(path), StringComparer.OrdinalIgnoreCase)) throw new InvalidOperationException("请通过文件选择器选择输入文件。");
    }

    private void ServeMedia(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        try
        {
            var id = new Uri(e.Request.Uri).AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
            if (id == null || !files.TryGetValue(id, out var path) || !File.Exists(path)) { e.Response = web.CoreWebView2.Environment.CreateWebResourceResponse(null, 404, "Not Found", ""); return; }
            var length = new FileInfo(path).Length;
            long start = 0, end = length - 1;
            var range = e.Request.Headers.Contains("Range") ? e.Request.Headers.GetHeader("Range") : "";
            int status = 200;
            if (!string.IsNullOrWhiteSpace(range))
            {
                var match = Regex.Match(range, @"^bytes=(\d*)-(\d*)$");
                if (!match.Success || (match.Groups[1].Value.Length == 0 && match.Groups[2].Value.Length == 0)) throw new IOException("无效范围");
                if (match.Groups[1].Value.Length == 0) start = Math.Max(0, length - long.Parse(match.Groups[2].Value));
                else
                {
                    start = long.Parse(match.Groups[1].Value);
                    if (match.Groups[2].Value.Length > 0) end = Math.Min(end, long.Parse(match.Groups[2].Value));
                }
                if (start > end || start >= length) { e.Response = web.CoreWebView2.Environment.CreateWebResourceResponse(null, 416, "Range Not Satisfiable", $"Content-Range: bytes */{length}"); return; }
                status = 206;
            }
            string mime = MediaFormats.ContentType(path);
            var stream = new BoundedFileStream(path, start, end - start + 1);
            string headers = $"Content-Type: {mime}\r\nContent-Length: {end - start + 1}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: https://app.vinyl.local\r\nCache-Control: private, max-age=3600";
            if (status == 206) headers += $"\r\nContent-Range: bytes {start}-{end}/{length}";
            e.Response = web.CoreWebView2.Environment.CreateWebResourceResponse(stream, status, status == 206 ? "Partial Content" : "OK", headers);
        }
        catch { e.Response = web.CoreWebView2.Environment.CreateWebResourceResponse(null, 400, "Bad Request", ""); }
    }

    private void Emit(string eventName, object data)
    {
        if (lifetime.IsCancellationRequested) return;
        Dispatcher.BeginInvoke(() => { if (web.CoreWebView2 != null) web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { @event = eventName, data }, AppPaths.Json)); });
    }

    private async void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (e.Source != "https://app.vinyl.local/index.html") return;
        string? id = null;
        try
        {
            using var message = JsonDocument.Parse(e.WebMessageAsJson);
            id = message.RootElement.GetProperty("id").GetString();
            var action = message.RootElement.GetProperty("action").GetString();
            var payload = message.RootElement.TryGetProperty("payload", out var p) ? p : default;
            object? result = await Handle(action ?? "", payload);
            Reply(new { id, ok = true, data = result });
        }
        catch (OperationCanceledException) { Reply(new { id, ok = false, error = "操作已取消", cancelled = true }); }
        catch (Exception ex)
        {
            var explanation = ex.Message.Any(c => c is >= '\u4e00' and <= '\u9fff') ? ex.Message : ex switch
            {
                System.Net.Http.HttpRequestException => "网络连接失败，请检查网络后重试，也可以导入本地歌词。",
                UnauthorizedAccessException => "没有权限访问所选位置，请更换保存目录。",
                IOException => "无法读取或写入文件，请检查文件及保存路径。",
                _ => "操作未完成，请检查文件、参数和网络连接后重试。"
            };
            Reply(new { id, ok = false, error = explanation });
        }
    }

    private void Reply(object data)
    {
        if (!lifetime.IsCancellationRequested && web.CoreWebView2 != null) web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(data, AppPaths.Json));
    }

    private async Task<T> ImportAsync<T>(string message, Func<CancellationToken, Task<T>> read)
    {
        if (importCancellation != null) throw new InvalidOperationException("请等待当前素材导入完成，或先取消导入。");
        using var current = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        importCancellation = current;
        importCompleted = importTotal = null; importItemMessage = null;
        ReportImport(message);
        try { return await read(current.Token); }
        finally
        {
            importCancellation = null; importCompleted = importTotal = null; importItemMessage = null;
            Emit("mediaImport", new { active = false, message = "" });
        }
    }

    private void ReportImport(string message, int? completed = null, int? total = null)
    {
        if (completed.HasValue) importCompleted = completed;
        if (total.HasValue) importTotal = total;
        Emit("mediaImport", new { active = true, message, completed = importCompleted, total = importTotal });
    }

    private void ReportImportStage(string message)
    {
        if (importCancellation == null) return;
        ReportImport(importItemMessage == null ? message : importItemMessage + "\n" + message);
    }

    private sealed record Imported<T>(List<T> Items, List<string> Errors, bool Cancelled);
    private async Task<Imported<AudioInfo>> ReadBatchAudio(string[] paths, CancellationToken token)
    {
        paths = paths.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        if (paths.Length > 500) throw new IOException("一次最多导入 500 首音乐。");
        var imported = new List<AudioInfo>(); var errors = new List<string>();
        for (int index = 0; index < paths.Length; index++)
        {
            var path = paths[index];
            try
            {
                token.ThrowIfCancellationRequested();
                importItemMessage = $"正在读取第 {index + 1} / {paths.Length} 首音乐：{Path.GetFileName(path)}";
                ReportImport(importItemMessage, index, paths.Length);
                imported.Add(await media.ReadAudioAsync(Path.GetFullPath(path), Register, token));
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
            { errors.Add(Path.GetFileName(path) + "：无法读取此音乐文件。"); }
            ReportImport($"已处理第 {index + 1} / {paths.Length} 首音乐：{Path.GetFileName(path)}", index + 1, paths.Length);
        }
        return new(imported, errors, token.IsCancellationRequested);
    }
    private async Task<Imported<LibraryVideo>> ReadLibraryVideos(string[] paths, CancellationToken token)
    {
        paths = paths.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        if (paths.Length > 500) throw new IOException("一次最多导入 500 个视频。");
        var current = await videoLibrary.LoadAsync(token);
        var imported = new List<LibraryVideo>(); var errors = new List<string>();
        for (int index = 0; index < paths.Length; index++)
        {
            var path = paths[index];
            try
            {
                token.ThrowIfCancellationRequested();
                var full = Path.GetFullPath(path);
                importItemMessage = $"正在读取第 {index + 1} / {paths.Length} 个视频：{Path.GetFileName(path)}";
                ReportImport(importItemMessage, index, paths.Length);
                if (!current.Any(v => v.Path.Equals(full, StringComparison.OrdinalIgnoreCase)))
                {
                    var video = await media.ReadVideoAsync(full, Register, token, preparePreview: false);
                    imported.Add(new(Guid.NewGuid().ToString("N"), full, video.Name, [], video.Duration, video.Width, video.Height));
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
            { errors.Add(Path.GetFileName(path) + "：无法读取此视频文件。"); }
            ReportImport($"已处理第 {index + 1} / {paths.Length} 个视频：{Path.GetFileName(path)}", index + 1, paths.Length);
        }
        // Preserve already imported entries when the user cancels the remaining files.
        ReportImport("正在保存视频库…");
        await videoLibrary.UpdateAsync(items => { foreach (var video in imported) if (!items.Any(v => v.Path.Equals(video.Path, StringComparison.OrdinalIgnoreCase))) items.Add(video); }, lifetime.Token);
        return new(imported, errors, token.IsCancellationRequested);
    }
    private void EnsureIdle()
    {
        if (renderer.IsRunning || batchRenderer.IsRunning || devicePerformance.IsRunning || aiPreviewCancellation != null || importCancellation != null || installing)
            throw new IOException("请等待当前任务完成，或先停止当前任务。");
    }

    private async Task<object?> Handle(string action, JsonElement payload)
    {
        string Text(string key) => payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(key, out var v) ? v.GetString() ?? "" : "";
        switch (action)
        {
            case "bootstrap":
                var detected = await dependencies.DetectAsync(lifetime.Token);
                AudioInfo? startupAudio = null; VideoInfo? startupBackground = null;
                string? importError = null;
                Imported<AudioInfo>? batchAudio = null;
                if (!startupConsumed && detected.Ffmpeg.Ready)
                {
                    startupConsumed = true;
                    var arguments = Environment.GetCommandLineArgs().Skip(1).ToArray();
                    try
                    {
                        if (arguments.FirstOrDefault() == "--batch")
                        {
                            var split = Array.IndexOf(arguments, "--videos");
                            batchAudio = await ImportAsync("正在导入批量音乐…", token => ReadBatchAudio(arguments.Skip(1).Take(split < 0 ? arguments.Length - 1 : split - 1).ToArray(), token));
                            if (split >= 0) await ImportAsync("正在导入视频库…", token => ReadLibraryVideos(arguments.Skip(split + 1).ToArray(), token));
                        }
                        else if (arguments.Length > 0 && MediaFormats.IsAudioPath(arguments[0]) && File.Exists(arguments[0]))
                            startupAudio = await ImportAsync("正在读取音乐…", token => media.ReadAudioAsync(Path.GetFullPath(arguments[0]), Register, token));
                        if (arguments.Length > 2 && arguments[1] == "--background" && File.Exists(arguments[2]))
                            startupBackground = await ImportAsync("正在读取背景视频…", token => media.ReadVideoAsync(Path.GetFullPath(arguments[2]), Register, token));
                    }
                    catch (OperationCanceledException) when (!lifetime.IsCancellationRequested) { importError = "已取消导入素材。"; }
                    catch (IOException error) { importError = error.Message; }
                }
                return new { dependencies = detected, outputDirectory = AppPaths.DefaultOutput, version = "0.9.0", softwareTheme = softwareThemes.Current.Id, audio = startupAudio, background = startupBackground, importError, batchAudio };
            case "setSoftwareTheme":
                await softwareThemes.SaveAsync(Text("theme"), lifetime.Token); ApplySoftwareTheme(); return softwareThemes.Current;
            case "getAiVideoSettings": return aiVideoSettings.View();
            case "getAiVideoDefaults": return new AiVideoSettings().Public();
            case "saveAiVideoSettings":
                EnsureIdle();
                var aiDraft = payload.GetProperty("settings").Deserialize<AiVideoSettings>(AppPaths.Json) ?? throw new IOException("AI 背景设置无效。");
                var aiMerged = aiVideoSettings.Merge(aiDraft, payload.TryGetProperty("clearKey", out var clearKey) && clearKey.ValueKind == JsonValueKind.True,
                    payload.TryGetProperty("clearOptimizerKey", out var clearOptimizerKey) && clearOptimizerKey.ValueKind == JsonValueKind.True);
                aiMerged.Validate(aiMerged.Enabled); await aiVideoSettings.SaveAsync(aiMerged, lifetime.Token); return aiVideoSettings.View();
            case "aiVideoModels":
                EnsureIdle();
                var modelSettings = aiVideoSettings.Merge(payload.GetProperty("settings").Deserialize<AiVideoSettings>(AppPaths.Json) ?? new()); modelSettings.Validate();
                using (var modelClient = new AiVideoHttp(modelSettings)) return await modelClient.ModelsAsync(lifetime.Token);
            case "previewAiVideoPrompt":
                EnsureIdle();
                var promptSettings = payload.TryGetProperty("settings", out var promptSettingsValue) ? aiVideoSettings.Merge(promptSettingsValue.Deserialize<AiVideoSettings>(AppPaths.Json) ?? new()) : aiVideoSettings.Current;
                var song = payload.GetProperty("song").Deserialize<AiVideoSong>(AppPaths.Json) ?? throw new IOException("歌曲信息无效。");
                aiPreviewCancellation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                try { return await AiVideoService.PreviewAsync(promptSettings, song, payload.TryGetProperty("optimize", out var optimizePrompt) && optimizePrompt.ValueKind == JsonValueKind.True, aiPreviewCancellation.Token); }
                finally { aiPreviewCancellation.Dispose(); aiPreviewCancellation = null; }
            case "cancelAiVideoPreview": aiPreviewCancellation?.Cancel(); return null;
            case "getVideoLibrary":
                var library = await videoLibrary.LoadAsync(lifetime.Token);
                foreach (var video in library.Where(v => v.Available)) Register(video.Path);
                return library;
            case "pickBatchAudio":
                EnsureIdle();
                var musicPicker = new OpenFileDialog { Title = "批量选择音乐", Filter = MediaFormats.AudioFilter, Multiselect = true, CheckFileExists = true };
                return musicPicker.ShowDialog(this) == true ? await ImportAsync("正在导入批量音乐…", token => ReadBatchAudio(musicPicker.FileNames, token)) : null;
            case "pickLibraryVideos":
                EnsureIdle();
                var libraryPicker = new OpenFileDialog { Title = "导入视频库", Filter = MediaFormats.VideoFilter, Multiselect = true, CheckFileExists = true };
                return libraryPicker.ShowDialog(this) == true ? await ImportAsync("正在导入视频库…", token => ReadLibraryVideos(libraryPicker.FileNames, token)) : null;
            case "setLibraryGenres":
                EnsureIdle();
                var ids = payload.GetProperty("ids").Deserialize<string[]>() ?? [];
                var genres = MusicGenres.Parse(Text("genres"));
                return await videoLibrary.UpdateAsync(items => { for (int index = 0; index < items.Count; index++) if (ids.Contains(items[index].Id)) items[index] = items[index] with { Genres = genres }; }, lifetime.Token);
            case "removeLibraryVideos":
                EnsureIdle();
                var removedIds = payload.GetProperty("ids").Deserialize<string[]>() ?? [];
                return await videoLibrary.UpdateAsync(items => items.RemoveAll(v => removedIds.Contains(v.Id)), lifetime.Token);
            case "planBatch":
                var videos = await videoLibrary.LoadAsync(lifetime.Token);
                var backgroundOptions = payload.TryGetProperty("background", out var backgroundSettings)
                    ? backgroundSettings.Deserialize<BatchBackgroundOptions>(AppPaths.Json) ?? new() : new BatchBackgroundOptions();
                var planRows = payload.GetProperty("rows").EnumerateArray().ToArray();
                if (planRows.Length > 500) throw new IOException("批量队列最多包含 500 首音乐。");
                var planner = new BatchBackgroundPlanner(videos, backgroundOptions, planRows
                    .Where(r => r.TryGetProperty("keepVideoId", out var kept) && kept.ValueKind == JsonValueKind.String)
                    .Select(r => r.GetProperty("keepVideoId").GetString()!));
                var plan = new List<object>(); int sequence = 0;
                foreach (var row in planRows)
                {
                    var audio = row.GetProperty("audio").Deserialize<AudioInfo>(AppPaths.Json) ?? throw new IOException("音乐信息无效。");
                    ValidateInput(audio.Path);
                    var style = row.GetProperty("genres").GetString() ?? "";
                    var assigned = planner.Choose(MusicGenres.Parse(style), row.TryGetProperty("keepVideoId", out var keep) ? keep.GetString() : null);
                    if (assigned.Video != null) Register(assigned.Video.Path);
                    var container = row.GetProperty("container").GetString() ?? "mp4";
                    ++sequence;
                    int rowIndex = row.TryGetProperty("sequence", out var order) ? order.GetInt32() : sequence;
                    if (rowIndex is < 1 or > 500) throw new IOException("批量序号无效。");
                    var name = OutputFormats.BatchName(Text("pattern"), rowIndex, audio with { Genre = style }, container);
                    plan.Add(new { id = row.GetProperty("id").GetString(), videoId = assigned.Video?.Id, backgroundPath = assigned.Video?.Path, backgroundName = assigned.Video?.Name, assigned.Matched, assigned.Reason, fileName = name });
                }
                return plan;
            case "batchRender":
                EnsureIdle();
                var batch = payload.Deserialize<BatchRequest>(AppPaths.Json) ?? throw new IOException("批量任务无效。");
                foreach (var item in batch.Items) { ValidateInput(item.Request.AudioPath); ValidateInput(item.Request.BackgroundPath); ValidateInput(item.Request.CoverPath); }
                batchCancellation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                try
                {
                    using var aiRun = batch.UseAiBackgrounds ? aiVideos.CreateRun() : null;
                    return await batchRenderer.RunAsync(batch, data =>
                    {
                        if (data is BatchResult { Output: not null } completed) batchOutputs.TryAdd(completed.Output, 0);
                        Emit("batchProgress", data);
                    }, batchCancellation.Token, aiRun);
                }
                finally { batchCancellation.Dispose(); batchCancellation = null; }
            case "cancelBatch": batchCancellation?.Cancel(); return null;
            case "showBatchOutput":
                var batchOutput = Text("path");
                if (!batchOutputs.ContainsKey(batchOutput) || !File.Exists(batchOutput)) throw new IOException("找不到本次批量导出的文件。");
                Process.Start(new ProcessStartInfo("explorer.exe") { ArgumentList = { "/select,", batchOutput }, UseShellExecute = true }); return null;
            case "detectDependencies": return await dependencies.DetectAsync(lifetime.Token);
            case "getEncodingCapabilities":
                var refreshCodecs = payload.TryGetProperty("refresh", out var refreshValue) && refreshValue.ValueKind == JsonValueKind.True;
                if (refreshCodecs) EnsureIdle();
                return await encodingCapabilities.ReadAsync(refreshCodecs, lifetime.Token);
            case "getDeviceStatus": return await devicePerformance.StatusAsync(lifetime.Token);
            case "setDeviceDecision":
                EnsureIdle(); await devicePerformance.DecideAsync(Text("decision"), lifetime.Token); return null;
            case "benchmarkDevice":
                EnsureIdle();
                var profile = payload.GetProperty("profile").Deserialize<BenchmarkProfile>(AppPaths.Json) ?? throw new IOException("设备测速参数无效。");
                benchmarkCancellation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                try { return await devicePerformance.BenchmarkAsync(profile, true, data => Emit("deviceProgress", data), benchmarkCancellation.Token); }
                finally { benchmarkCancellation.Dispose(); benchmarkCancellation = null; }
            case "cancelDeviceBenchmark": benchmarkCancellation?.Cancel(); return null;
            case "editLayout":
                EnsureIdle();
                if (payload.TryGetProperty("audio", out var editorAudio) && editorAudio.ValueKind == JsonValueKind.Object) ValidateInput(editorAudio.GetProperty("path").GetString());
                if (payload.TryGetProperty("background", out var editorBackground) && editorBackground.ValueKind == JsonValueKind.Object) ValidateInput(editorBackground.GetProperty("path").GetString());
                var editor = new LayoutEditorWindow(payload.Clone(), web.CoreWebView2.Environment, ServeMedia, media, Register, softwareThemes.Current) { Owner = this };
                // A second WebView2 must open after the message callback has returned.
                await Dispatcher.InvokeAsync(() => editor.ShowDialog());
                return editor.Result;
            case "installDependencies":
                EnsureIdle();
                if (installing) throw new InvalidOperationException("依赖任务正在进行。");
                installing = true; downloadCancellation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                try { await dependencies.InstallMissingAsync(new Progress<DownloadProgress>(p => Emit("downloadProgress", p)), downloadCancellation.Token); return dependencies.Current; }
                finally { installing = false; downloadCancellation.Dispose(); downloadCancellation = null; }
            case "cancelDownload": downloadCancellation?.Cancel(); return null;
            case "pickAudio":
                EnsureIdle();
                if (importCancellation != null) throw new InvalidOperationException("请等待当前素材导入完成。");
                var audioPicker = new OpenFileDialog { Title = "选择音乐", Filter = MediaFormats.AudioFilter, CheckFileExists = true };
                return audioPicker.ShowDialog(this) == true ? await ImportAsync("正在读取音乐…", token => media.ReadAudioAsync(audioPicker.FileName, Register, token)) : null;
            case "pickBackground":
                EnsureIdle();
                var videoPicker = new OpenFileDialog { Title = "选择背景视频", Filter = MediaFormats.VideoFilter, CheckFileExists = true };
                return videoPicker.ShowDialog(this) == true ? await ImportAsync("正在读取背景视频…", token => media.ReadVideoAsync(videoPicker.FileName, Register, token)) : null;
            case "cancelMediaImport": importCancellation?.Cancel(); return null;
            case "pickCover":
                var coverPicker = new OpenFileDialog { Title = "选择歌曲封面", Filter = "封面图片|*.png;*.jpg;*.jpeg;*.webp", CheckFileExists = true };
                if (coverPicker.ShowDialog(this) != true) return null;
                return new { path = coverPicker.FileName, url = Register(coverPicker.FileName) };
            case "pickLyrics":
                var lyricPicker = new OpenFileDialog { Title = "导入时间轴歌词", Filter = "LRC 歌词|*.lrc;*.txt", CheckFileExists = true };
                return lyricPicker.ShowDialog(this) == true ? new { lyrics = MediaService.ReadLyrics(lyricPicker.FileName), name = Path.GetFileName(lyricPicker.FileName) } : null;
            case "pickOutput":
                var directoryPicker = new OpenFolderDialog { Title = "选择输出目录", InitialDirectory = Directory.Exists(Text("current")) ? Text("current") : Environment.GetFolderPath(Environment.SpecialFolder.MyVideos) };
                return directoryPicker.ShowDialog(this) == true ? directoryPicker.FolderName : null;
            case "searchLyrics":
                double duration = payload.TryGetProperty("duration", out var seconds) ? seconds.GetDouble() : 0;
                return await lyrics.SearchAsync(Text("title"), Text("artist"), Text("album"), duration, Text("query"), lifetime.Token);
            case "render":
                EnsureIdle();
                var request = JsonSerializer.Deserialize<RenderRequest>(payload, AppPaths.Json) ?? throw new InvalidOperationException("生成参数无效。");
                ValidateInput(request.AudioPath); ValidateInput(request.BackgroundPath); ValidateInput(request.CoverPath);
                renderCancellation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                try
                {
                    lastOutput = await renderer.RenderAsync(request, data => Emit("renderProgress", data), renderCancellation.Token);
                    return new { path = lastOutput, url = Register(lastOutput) };
                }
                finally { renderCancellation.Dispose(); renderCancellation = null; }
            case "cancelRender": renderCancellation?.Cancel(); return null;
            case "showOutput":
                if (lastOutput != null && File.Exists(lastOutput)) Process.Start(new ProcessStartInfo("explorer.exe") { ArgumentList = { "/select,", lastOutput }, UseShellExecute = true });
                return null;
            case "openOutput":
                if (lastOutput != null && File.Exists(lastOutput)) Process.Start(new ProcessStartInfo(lastOutput) { UseShellExecute = true });
                return null;
            case "windowMinimize": WindowState = WindowState.Minimized; return null;
            case "windowMaximize": WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized; return null;
            case "windowDrag": if (Mouse.LeftButton == MouseButtonState.Pressed) DragMove(); return null;
            case "windowClose": Close(); return null;
            default: throw new InvalidOperationException("不支持的操作。");
        }
    }
}

internal sealed class BoundedFileStream : Stream
{
    private readonly FileStream file;
    private readonly long length;
    private long position;
    private readonly long origin;
    public BoundedFileStream(string path, long offset, long count) { file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete); file.Position = origin = offset; length = count; }
    public override bool CanRead => true;
    public override bool CanSeek => true;
    public override bool CanWrite => false;
    public override long Length => length;
    public override long Position { get => position; set => Seek(value, SeekOrigin.Begin); }
    public override int Read(byte[] buffer, int offset, int count) { var read = file.Read(buffer, offset, (int)Math.Min(count, length - position)); position += read; return read; }
    public override long Seek(long offset, SeekOrigin originKind)
    {
        var target = originKind switch { SeekOrigin.Begin => offset, SeekOrigin.Current => position + offset, _ => length + offset };
        if (target < 0 || target > length) throw new IOException("读取位置无效。");
        file.Position = origin + target; return position = target;
    }
    public override void Flush() { }
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    protected override void Dispose(bool disposing) { if (disposing) file.Dispose(); base.Dispose(disposing); }
}
