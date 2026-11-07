using System.Collections.Concurrent;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace VinylMV.Core;

public sealed record AiVideoProgress(string Phase, string Message, double? Percent = null, string? BackgroundPath = null, string? BackgroundName = null, string? Prompt = null);
public sealed record AiGeneratedBackground(LibraryVideo Video, string Prompt, bool Cached, bool Resumed, string? Warning = null);
public interface IAiBatchBackgrounds
{
    string Mode { get; }
    string Failure { get; }
    Task<AiGeneratedBackground> GenerateAsync(AiVideoSong song, Action<AiVideoProgress> progress, CancellationToken token);
}

public sealed class AiVideoService(AiVideoSettingsStore store, MediaService media, VideoLibrary library, Func<string, string> register, string defaultDirectory)
{
    public AiBackgroundRun CreateRun()
    {
        var settings = store.Current;
        if (!settings.Enabled) throw new IOException("请先在 AI 背景设置中开启生成背景。");
        settings.Validate(connection: true);
        return new(settings, media, library, register, defaultDirectory);
    }
    public static async Task<object> PreviewAsync(AiVideoSettings settings, AiVideoSong song, bool optimize, CancellationToken token)
    {
        settings.Validate();
        var prompt = AiVideoPrompt.Compose(settings, song); string? warning = null;
        if (optimize)
        {
            if (settings.OptimizerModel.Length == 0) throw new IOException("请先填写提示词优化模型。");
            using var client = new AiVideoHttp(settings);
            try { prompt = await client.OptimizeAsync(prompt, token) + "\n" + AiVideoPrompt.Constraints(settings, song.Layout); }
            catch (Exception error) when (!token.IsCancellationRequested && settings.OptimizerFallback && error is IOException or HttpRequestException)
            { warning = "文字模型优化未成功，当前使用内置构图提示词。"; }
        }
        return new { prompt, warning };
    }
}

public sealed class AiBackgroundRun : IAiBatchBackgrounds, IDisposable
{
    private sealed record Manifest(string Id, string Prompt, string? File = null, bool Complete = false, bool Failed = false);
    private readonly AiVideoSettings settings;
    private readonly MediaService media;
    private readonly VideoLibrary library;
    private readonly Func<string, string> register;
    private readonly string directory;
    private readonly AiVideoHttp client;
    private readonly SemaphoreSlim slots;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> locks = new();
    public string Mode => settings.Mode;
    public string Failure => settings.Failure;
    public AiBackgroundRun(AiVideoSettings settings, MediaService media, VideoLibrary library, Func<string, string> register, string defaultDirectory)
    {
        this.settings = settings; this.media = media; this.library = library; this.register = register;
        directory = settings.Directory.Length > 0 ? settings.Directory : defaultDirectory;
        client = new(settings); slots = new(settings.MaxConcurrent, settings.MaxConcurrent);
    }
    public async Task<AiGeneratedBackground> GenerateAsync(AiVideoSong song, Action<AiVideoProgress> progress, CancellationToken token)
    {
        string basePrompt = AiVideoPrompt.Compose(settings, song);
        var identity = new { version = 1, basePrompt, settings.BaseUrl, settings.Model, settings.Protocol, settings.CreatePath, settings.RequestJson, settings.ExtraJson,
            settings.Seconds, settings.Size, settings.Fps, settings.Seed, settings.GenerateAudio, settings.Optimize, settings.OptimizerModel, settings.OptimizerBaseUrl, settings.OptimizerPath, settings.Temperature, settings.MaxTokens, settings.TokenField };
        string key = Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(identity, AppPaths.Json))).ToLowerInvariant();
        string manifestPath = Path.Combine(directory, ".tasks", key + ".json");
        var gate = locks.GetOrAdd(key, _ => new(1, 1));
        progress(new("ai_waiting", "正在等待 AI 生成名额"));
        await gate.WaitAsync(token);
        try
        {
            Manifest? manifest = null;
            try { if (File.Exists(manifestPath)) manifest = JsonSerializer.Deserialize<Manifest>(await File.ReadAllTextAsync(manifestPath, token), AppPaths.Json); }
            catch (JsonException) { /* Preserve damaged metadata; this explicit run may submit a new task. */ }
            if (settings.ReuseCache && manifest is { Complete: true, File: not null } && SafeCachedPath(manifest.File) && File.Exists(manifest.File))
            {
                try
                {
                    var cached = await media.ReadVideoAsync(manifest.File, register, token, preparePreview: false);
                    var video = Video(cached, song, key);
                    string? warning = await AddLibrary(video, token);
                    progress(new("ai_ready", "已复用本地 AI 背景", 100, video.Path, video.Name, manifest.Prompt));
                    return new(video, manifest.Prompt, true, false, warning);
                }
                catch (IOException) { /* Invalid cached media is never passed to the renderer. */ }
            }
            await slots.WaitAsync(token);
            try { return await Generate(manifest is { Complete: false, Failed: false } ? manifest : null, manifestPath, key, basePrompt, song, progress, token); }
            finally { slots.Release(); }
        }
        finally { gate.Release(); }
    }
    private bool SafeCachedPath(string file) => Path.GetFullPath(file).StartsWith(Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    private LibraryVideo Video(VideoInfo video, AiVideoSong song, string key) => new("ai-" + key[..20] + "-" + Path.GetFileNameWithoutExtension(video.Path).Split('-').Last(), video.Path,
        "AI 背景 · " + song.Title[..Math.Min(song.Title.Length, 180)], MusicGenres.Parse(song.Genres), video.Duration, video.Width, video.Height);
    private async Task<string?> AddLibrary(LibraryVideo video, CancellationToken token)
    {
        if (!settings.AddToLibrary) return null;
        try { await library.UpdateAsync(items => { if (!items.Any(item => item.Path.Equals(video.Path, StringComparison.OrdinalIgnoreCase))) items.Add(video); }, token); return null; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return "背景已生成，但未能加入视频库；原视频保留。"; }
    }
    private static async Task SaveManifest(string path, Manifest value, CancellationToken token)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(value, AppPaths.Json), token); token.ThrowIfCancellationRequested(); File.Move(temporary, path, true); }
        finally { File.Delete(temporary); }
    }
    private async Task<AiGeneratedBackground> Generate(Manifest? pending, string manifestPath, string key, string basePrompt, AiVideoSong song, Action<AiVideoProgress> progress, CancellationToken token)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(TimeSpan.FromMinutes(settings.TimeoutMinutes));
        var workToken = deadline.Token;
        string? partial = null, warning = null;
        bool resumed = pending is { Id.Length: > 0 };
        try
        {
            string prompt = pending?.Prompt ?? basePrompt;
            if (pending == null && settings.Optimize && string.IsNullOrWhiteSpace(song.Prompt))
            {
                progress(new("ai_prompting", "正在优化背景提示词"));
                try { prompt = await client.OptimizeAsync(prompt, workToken) + "\n" + AiVideoPrompt.Constraints(settings, song.Layout); }
                catch (Exception error) when (!workToken.IsCancellationRequested && settings.OptimizerFallback && error is IOException or HttpRequestException)
                { warning = "提示词优化失败，已使用内置构图提示词"; prompt = basePrompt; }
            }
            JsonNode result;
            string id;
            if (resumed)
            {
                id = pending!.Id; progress(new("ai_generating", "正在继续查询已提交的 AI 视频任务", Prompt: prompt));
                result = await client.JsonAsync(HttpMethod.Get, AiVideoHttp.Endpoint(settings.BaseUrl, settings.PollPath, id), null, workToken);
            }
            else
            {
                progress(new("ai_generating", "正在提交 AI 视频生成任务", Prompt: prompt));
                HttpContent Content()
                {
                    if (settings.Protocol == "json") return AiVideoHttp.JsonContent(AiVideoHttp.Body(settings, prompt));
                    var form = new MultipartFormDataContent();
                    foreach (var pair in new Dictionary<string, string> { ["model"] = settings.Model, ["prompt"] = prompt, ["seconds"] = settings.Seconds.ToString(), ["size"] = settings.Size }) form.Add(new StringContent(pair.Value), pair.Key);
                    foreach (var pair in (JsonObject)JsonNode.Parse(settings.ExtraJson)!)
                    {
                        if (pair.Key is "model" or "prompt" or "seconds" or "size") throw new IOException("附加参数不能覆盖模型、提示词、时长或尺寸，请修改对应设置。");
                        form.Add(new StringContent(pair.Value is JsonValue ? AiVideoHttp.Text(pair.Value) : pair.Value?.ToJsonString() ?? "null"), pair.Key);
                    }
                    return form;
                }
                result = await client.JsonAsync(HttpMethod.Post, AiVideoHttp.Endpoint(settings.BaseUrl, settings.CreatePath), Content, workToken);
                id = AiVideoHttp.Text(AiVideoHttp.ReadPath(result, settings.IdPath));
                if (id.Length > 500) throw new IOException("AI 服务返回的任务编号过长。");
                if (id.Length > 0) await SaveManifest(manifestPath, new(id, prompt), CancellationToken.None);
            }
            string? downloadUrl = null;
            while (true)
            {
                workToken.ThrowIfCancellationRequested();
                string status = AiVideoHttp.Text(AiVideoHttp.ReadPath(result, settings.StatusPath));
                bool IsState(string states) => states.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Contains(status, StringComparer.OrdinalIgnoreCase);
                if (IsState(settings.FailureStates))
                {
                    if (id.Length > 0) await SaveManifest(manifestPath, new(id, prompt, Failed: true), workToken);
                    throw new IOException("AI 视频任务生成失败，请在服务商后台查看原因或调整提示词。");
                }
                string url = AiVideoHttp.Text(AiVideoHttp.ReadPath(result, settings.UrlPath));
                if (IsState(settings.SuccessStates) || status.Length == 0 && url.Length > 0)
                {
                    downloadUrl = url.Length > 0 ? url : settings.ContentPath.Length > 0 && id.Length > 0 ? AiVideoHttp.Endpoint(settings.BaseUrl, settings.ContentPath, id).AbsoluteUri : null;
                    if (downloadUrl == null) throw new IOException("任务完成但没有可下载的视频，请检查结果 URL 或内容下载路径。");
                    break;
                }
                if (id.Length == 0 || settings.PollPath.Length == 0) throw new IOException("AI 服务没有返回可查询的任务编号或视频地址，请检查响应字段映射。");
                double? percent = double.TryParse(AiVideoHttp.Text(AiVideoHttp.ReadPath(result, settings.ProgressPath)), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var number) && double.IsFinite(number) ? Math.Clamp(number, 0, 99) : null;
                progress(new("ai_generating", "AI 正在生成背景视频" + (percent.HasValue ? $" · {percent:0}%" : "，等待服务完成"), percent, Prompt: prompt));
                await Task.Delay(TimeSpan.FromSeconds(settings.PollSeconds), workToken);
                result = await client.JsonAsync(HttpMethod.Get, AiVideoHttp.Endpoint(settings.BaseUrl, settings.PollPath, id), null, workToken);
            }
            Directory.CreateDirectory(directory);
            string target = Path.Combine(directory, key[..16] + "-" + Guid.NewGuid().ToString("N")[..10] + ".mp4");
            partial = target + ".part";
            progress(new("ai_downloading", "正在下载 AI 背景视频", 0, Prompt: prompt));
            await client.DownloadAsync(AiVideoHttp.Endpoint(settings.BaseUrl, downloadUrl), partial, percent => progress(new("ai_downloading", "正在下载 AI 背景视频", percent)), workToken);
            progress(new("ai_checking", "正在验证 AI 背景视频"));
            var metadata = await media.ReadVideoAsync(partial, _ => "", workToken, preparePreview: false);
            workToken.ThrowIfCancellationRequested(); File.Move(partial, target); partial = null;
            var video = Video(metadata with { Path = target, Name = Path.GetFileName(target) }, song, key);
            register(target);
            await SaveManifest(manifestPath, new(id, prompt, target, Complete: true), workToken);
            string? libraryWarning = await AddLibrary(video, workToken);
            if (libraryWarning != null) warning = (warning == null ? "" : warning + "；") + libraryWarning;
            progress(new("ai_ready", "AI 背景已就绪", 100, video.Path, video.Name, prompt));
            return new(video, prompt, false, resumed, warning);
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { throw new IOException("AI 背景任务等待超时；已提交的任务会保留编号，重试时优先继续查询。"); }
        finally { if (partial != null) { try { File.Delete(partial); } catch (IOException) { } } }
    }
    public void Dispose() { client.Dispose(); slots.Dispose(); foreach (var value in locks.Values) value.Dispose(); }
}
