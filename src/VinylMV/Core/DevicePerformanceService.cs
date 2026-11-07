using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace VinylMV.Core;

public sealed record BenchmarkProfile(string Container, int Width, int Height, int Fps, JsonElement? Encoding = null, int MaxParallel = 3,
    bool ShowSpectrum = true, JsonElement? Layout = null);
public sealed record DeviceSnapshot(string Cpu, int LogicalProcessors, string[] Gpus, string Fingerprint);
public sealed record BenchmarkEntry(string Encoder, string Name, bool Available, double Fps, double Seconds, string Detail, JsonElement? Settings = null,
    double AnalysisSeconds = 0, double EncodeSeconds = 0, int SpectrumFrames = 0);
public sealed record BenchmarkReport(string Key, BenchmarkProfile Profile, DateTimeOffset TestedAt, BenchmarkEntry[] Results);
public sealed record DevicePreferences(int Version = 1, string Decision = "pending", DeviceSnapshot? Device = null, BenchmarkReport[]? Reports = null);
public interface IBatchEncoderSelector
{
    Task<IReadOnlyList<EncoderCandidate>> CandidatesAsync(RenderRequest request, int maxParallel, Action<object> progress, CancellationToken token);
}

public sealed class DevicePerformanceService(DependencyService dependencies, string storePath) : IBatchEncoderSelector
{
    private Task<DeviceSnapshot>? deviceTask;
    private int running;
    public bool IsRunning => Volatile.Read(ref running) != 0;
    public async Task<DevicePreferences> StatusAsync(CancellationToken token)
    {
        var saved = await Read(token);
        if (saved.Decision != "allowed") return saved with { Reports = [], Device = null };
        var device = await Device(token);
        return saved with { Device = device, Reports = (saved.Reports ?? []).Where(r => r.Key == Key(r.Profile, device)).ToArray() };
    }
    public async Task DecideAsync(string decision, CancellationToken token)
    {
        if (decision is not ("allowed" or "declined")) throw new IOException("设备检测选项无效。");
        if (IsRunning) throw new IOException("请先停止正在进行的设备测速。");
        await Save((await Read(token)) with { Decision = decision }, token);
    }
    public static BenchmarkProfile Prepare(BenchmarkProfile profile)
    {
        if (profile.MaxParallel is < 1 or > 16 || profile.Fps is not (24 or 30 or 60) ||
            (profile.Width, profile.Height) is not ((854, 480) or (1280, 720) or (1920, 1080))) throw new IOException("设备测速参数无效。");
        OutputFormats.Validate(profile.Container);
        var settings = profile.Encoding is { ValueKind: JsonValueKind.Object } value ? JsonNode.Parse(value.GetRawText())!.AsObject() : new JsonObject();
        if (!settings.TryGetPropertyValue("threads", out var threads) || threads?.GetValue<int>() == 0)
            settings["threads"] = Math.Clamp(Environment.ProcessorCount / profile.MaxParallel, 1, 64);
        return profile with { Encoding = JsonSerializer.SerializeToElement(settings) };
    }
    public static string Key(BenchmarkProfile profile, DeviceSnapshot device)
    {
        var prepared = Prepare(profile);
        var pairs = prepared.Encoding!.Value.EnumerateObject().Where(p => p.Name != "encoder").OrderBy(p => p.Name)
            .Select(p => p.Name + ":" + p.Value.GetRawText());
        var text = $"bench-v2-spectrum|{device.Fingerprint}|{profile.Container}|{profile.Width}|{profile.Height}|{profile.Fps}|" + string.Join("|", pairs) + "|" + SpectrumKey(profile);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    }
    private static string SpectrumKey(BenchmarkProfile profile)
    {
        if (!profile.ShowSpectrum) return "spectrum-off";
        if (profile.Layout is not { ValueKind: JsonValueKind.Object } layout || !layout.TryGetProperty("cards", out var cards) || cards.ValueKind != JsonValueKind.Array)
            return "spectrum-default";
        var relevant = cards.EnumerateArray().Where(c => c.ValueKind == JsonValueKind.Object && c.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String && id.GetString() is "spectrum" or "progress")
            .OrderBy(c => c.GetProperty("id").GetString()).Select(c => c.EnumerateObject().OrderBy(p => p.Name).ToDictionary(p => p.Name, p => p.Value));
        return JsonSerializer.Serialize(relevant, AppPaths.Json);
    }
    public async Task<BenchmarkReport> BenchmarkAsync(BenchmarkProfile requested, bool refresh, Action<object> progress, CancellationToken token)
    {
        if (Interlocked.CompareExchange(ref running, 1, 0) != 0) throw new IOException("设备测速正在进行。");
        string? job = null;
        try
        {
            var saved = await Read(token);
            if (saved.Decision != "allowed") throw new IOException("请先同意检测当前设备，再进行性能测速。");
            var profile = Prepare(requested);
            var device = await Device(token);
            var key = Key(requested, device);
            var cached = (saved.Reports ?? []).FirstOrDefault(r => r.Key == key);
            if (!refresh && cached != null) return cached;
            var deps = dependencies.Current ?? await dependencies.DetectAsync(token);
            if (!deps.Ready) throw new IOException("请先完成依赖安装。");
            var module = Path.Combine(RendererBundle.Validate(AppContext.BaseDirectory), "device_benchmark.py");
            if (!File.Exists(module)) throw new IOException("缺少设备测速组件，请使用新版安装包修复。");
            job = Path.Combine(AppPaths.Cache, "benchmark-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(job);
            var config = Path.Combine(job, "profile.json");
            await File.WriteAllTextAsync(config, JsonSerializer.Serialize(profile, AppPaths.Json), token);
            using var process = new Process { StartInfo = ProcessRunner.StartInfo(deps.Python.Path!, ["-B", "-u", module, "--ffmpeg", deps.Ffmpeg.Path!, "--config", config]) };
            process.Start();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            timeout.CancelAfter(TimeSpan.FromMinutes(4));
            using var registration = timeout.Token.Register(() => { try { process.Kill(true); } catch (InvalidOperationException) { } });
            var errors = process.StandardError.ReadToEndAsync();
            BenchmarkEntry[]? entries = null; string? error = null;
            try
            {
                while (await process.StandardOutput.ReadLineAsync(timeout.Token) is { } line)
                {
                    using var record = JsonDocument.Parse(line);
                    var data = record.RootElement;
                    progress(data.Clone());
                    if (data.GetProperty("event").GetString() == "complete") entries = data.GetProperty("results").Deserialize<BenchmarkEntry[]>(AppPaths.Json);
                    if (data.GetProperty("event").GetString() == "error") error = data.GetProperty("message").GetString();
                }
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                try { process.Kill(true); } catch (InvalidOperationException) { }
                await process.WaitForExitAsync(CancellationToken.None);
                token.ThrowIfCancellationRequested(); throw new IOException("设备测速超时，请在设备空闲后重试。");
            }
            await errors; token.ThrowIfCancellationRequested();
            if (process.ExitCode != 0 || entries == null) throw new IOException(error ?? "设备测速失败，请检查编码参数。");
            var report = new BenchmarkReport(key, requested, DateTimeOffset.UtcNow, entries);
            await Save(saved with { Device = device, Reports = (saved.Reports ?? []).Where(r => r.Key != key).Append(report).TakeLast(32).ToArray() }, token);
            return report;
        }
        finally
        {
            try
            {
                if (job != null && Directory.Exists(job))
                    for (int attempt = 0; attempt < 3; attempt++)
                    {
                        try { Directory.Delete(job, true); break; }
                        catch (IOException) when (attempt < 2) { await Task.Delay(100); }
                    }
            }
            finally { Volatile.Write(ref running, 0); }
        }
    }
    public async Task<IReadOnlyList<EncoderCandidate>> CandidatesAsync(RenderRequest request, int maxParallel, Action<object> progress, CancellationToken token)
    {
        var profile = new BenchmarkProfile(request.Container, request.Width, request.Height, request.Fps, request.Encoding, maxParallel, request.ShowSpectrum, request.Layout);
        var saved = await Read(token);
        if (saved.Decision != "allowed") return [Manual(request)];
        var report = await BenchmarkAsync(profile, false, progress, token);
        var candidates = report.Results.Where(r => r.Available && r.Fps > 0 && r.Settings.HasValue)
            .Select(r => new EncoderCandidate(r.Encoder, Label(r.Encoder), r.Fps, r.Settings!.Value)).ToArray();
        return candidates.Length > 0 ? candidates : throw new IOException("此输出参数没有测速通过的编码器，请调整编码设置后重试。");
    }
    public static string Label(string encoder) => encoder switch { "nvenc" => "GPU · 英伟达 NVENC", "qsv" => "GPU · 英特尔 QSV", "amf" => "GPU · AMD AMF", _ => "CPU · 软件编码" };
    public static EncoderCandidate Manual(RenderRequest request)
    {
        var value = request.Encoding ?? JsonSerializer.SerializeToElement(new { encoder = "software" });
        var backend = value.TryGetProperty("encoder", out var e) ? e.GetString() ?? "software" : "software";
        return new(backend, Label(backend) + "（手动）", 1, value, false);
    }
    private async Task<DevicePreferences> Read(CancellationToken token)
    {
        if (!File.Exists(storePath)) return new();
        try { return JsonSerializer.Deserialize<DevicePreferences>(await File.ReadAllTextAsync(storePath, token), AppPaths.Json) ?? new(); }
        catch (JsonException) { return new(); }
    }
    private async Task Save(DevicePreferences value, CancellationToken token)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(storePath))!);
        var temporary = storePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(value, AppPaths.Json), token); File.Move(temporary, storePath, true); }
        finally { File.Delete(temporary); }
    }
    private Task<DeviceSnapshot> Device(CancellationToken token)
    {
        if (deviceTask == null || deviceTask.IsCanceled || deviceTask.IsFaulted) deviceTask = Detect(token);
        return deviceTask;
    }
    private async Task<DeviceSnapshot> Detect(CancellationToken token)
    {
        var deps = dependencies.Current ?? await dependencies.DetectAsync(token);
        string cpu = Registry.GetValue(@"HKEY_LOCAL_MACHINE\HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString", null)?.ToString()?.Trim() ?? "本机处理器";
        string[] gpus = []; string gpuSignature;
        try
        {
            var detected = await Task.Run(GraphicsInventory.Read, token);
            gpus = detected.Names; gpuSignature = detected.Signature;
        }
        catch (Exception error) when (error is System.Runtime.InteropServices.COMException or DllNotFoundException or EntryPointNotFoundException or OperationCanceledException)
        { token.ThrowIfCancellationRequested(); gpuSignature = "inventory-unavailable-" + Guid.NewGuid(); }
        var file = deps.Ffmpeg.Path == null ? null : new FileInfo(deps.Ffmpeg.Path);
        var identity = $"{cpu}|{Environment.ProcessorCount}|{Environment.OSVersion}|{gpuSignature}|{file?.FullName}|{file?.Length}|{file?.LastWriteTimeUtc.Ticks}";
        return new(cpu, Environment.ProcessorCount, gpus, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity))));
    }
}
