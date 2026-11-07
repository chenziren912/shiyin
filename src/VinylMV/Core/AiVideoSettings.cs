using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace VinylMV.Core;

public sealed record AiVideoSettings
{
    public bool Enabled { get; init; }
    public string Mode { get; init; } = "all";
    public string Failure { get; init; } = "library";
    public string Protocol { get; init; } = "videos";
    public string BaseUrl { get; init; } = "";
    public string Model { get; init; } = "sora-2";
    public string ApiKey { get; init; } = "";
    public string AuthHeader { get; init; } = "Authorization";
    public string AuthPrefix { get; init; } = "Bearer ";
    public string HeadersJson { get; init; } = "{}";
    public string CreatePath { get; init; } = "videos";
    public string PollPath { get; init; } = "videos/{id}";
    public string ContentPath { get; init; } = "videos/{id}/content";
    public string ModelsPath { get; init; } = "models";
    public string RequestJson { get; init; } = "{\"model\":\"{model}\",\"prompt\":\"{prompt}\",\"duration\":\"{seconds}\",\"size\":\"{size}\"}";
    public string ExtraJson { get; init; } = "{}";
    public string IdPath { get; init; } = "id";
    public string StatusPath { get; init; } = "status";
    public string ProgressPath { get; init; } = "progress";
    public string UrlPath { get; init; } = "url";
    public string SuccessStates { get; init; } = "completed,succeeded,success";
    public string FailureStates { get; init; } = "failed,error,cancelled,canceled";
    public int Seconds { get; init; } = 8;
    public string Size { get; init; } = "1280x720";
    public int Fps { get; init; } = 24;
    public int Seed { get; init; } = -1;
    public bool GenerateAudio { get; init; }
    public string VisualStyle { get; init; } = "cinematic";
    public string Mood { get; init; } = "auto";
    public string Scene { get; init; } = "";
    public string Camera { get; init; } = "locked";
    public string Motion { get; init; } = "subtle";
    public string Palette { get; init; } = "";
    public bool Loop { get; init; } = true;
    public bool SafeAreas { get; init; } = true;
    public string Language { get; init; } = "en";
    public bool IncludeLyrics { get; init; }
    public int LyricsLimit { get; init; } = 800;
    public string NegativePrompt { get; init; } = "text, subtitles, logos, watermark, vinyl record, UI, flicker, flashing lights, abrupt cuts, warped geometry, unstable exposure";
    public string PromptTemplate { get; init; } = "";
    public bool Optimize { get; init; }
    public string OptimizerBaseUrl { get; init; } = "";
    public string OptimizerModel { get; init; } = "";
    public string OptimizerKey { get; init; } = "";
    public bool OptimizerUseVideoKey { get; init; } = true;
    public string OptimizerPath { get; init; } = "chat/completions";
    public double? Temperature { get; init; } = .7;
    public int MaxTokens { get; init; } = 700;
    public string TokenField { get; init; } = "max_tokens";
    public bool OptimizerFallback { get; init; } = true;
    public int MaxConcurrent { get; init; } = 2;
    public int PollSeconds { get; init; } = 5;
    public int TimeoutMinutes { get; init; } = 30;
    public int HttpTimeoutSeconds { get; init; } = 120;
    public int ReadRetries { get; init; } = 2;
    public int DownloadLimitMb { get; init; } = 512;
    public bool ReuseCache { get; init; } = true;
    public bool AddToLibrary { get; init; } = true;
    public string Directory { get; init; } = "";

    public AiVideoSettings Public() => this with { ApiKey = "", OptimizerKey = "" };
    public void Validate(bool connection = false)
    {
        if (typeof(AiVideoSettings).GetProperties().Any(property => property.PropertyType == typeof(string) && property.GetValue(this) == null)) throw new IOException("AI 设置不能包含空值字段。");
        if (Mode is not ("all" or "missing") || Failure is not ("library" or "skip" or "fail") || Protocol is not ("videos" or "json")) throw new IOException("AI 背景策略或接口类型无效。");
        if (Seconds is < 1 or > 60 || Fps is < 8 or > 60 || Seed < -1 || MaxConcurrent is < 1 or > 8 || PollSeconds is < 1 or > 60 || TimeoutMinutes is < 1 or > 180 || HttpTimeoutSeconds is < 5 or > 600 || ReadRetries is < 0 or > 5 || DownloadLimitMb is < 1 or > 2048) throw new IOException("AI 视频时长、并发、等待或下载参数超出允许范围。");
        var size = Size.Split('x');
        if (size.Length != 2 || !int.TryParse(size[0], out int width) || !int.TryParse(size[1], out int height) || width is < 256 or > 4096 || height is < 256 or > 4096) throw new IOException("视频尺寸应为 256–4096 范围内的 宽x高，例如 1280x720。");
        if (Protocol == "videos" && (Seconds is not (4 or 8 or 12) || Size is not ("1280x720" or "720x1280" or "1792x1024" or "1024x1792"))) throw new IOException("Videos 标准接口支持 4 / 8 / 12 秒和所列四种尺寸；其他参数请使用通用 JSON 接口。");
        if (Language is not ("en" or "zh") || VisualStyle is not ("cinematic" or "realistic" or "animation" or "illustration" or "abstract") || Mood is not ("auto" or "calm" or "warm" or "melancholic" or "uplifting" or "dreamy" or "dramatic") || Camera is not ("locked" or "push" or "pan" or "orbit") || Motion is not ("subtle" or "medium" or "strong")) throw new IOException("提示词风格选项无效。");
        if (LyricsLimit is < 100 or > 2000 || MaxTokens is < 100 or > 4000 || Temperature is { } temperature && (!double.IsFinite(temperature) || temperature is < 0 or > 2) || TokenField is not ("max_tokens" or "max_completion_tokens")) throw new IOException("提示词优化参数无效。");
        foreach (var text in new[] { Scene, Palette, NegativePrompt }) if (text.Length > 3000) throw new IOException("场景、色彩或负面提示词不能超过 3000 字符。");
        if (PromptTemplate.Length > 12000 || Model.Length > 150 || OptimizerModel.Length > 150 || ApiKey.Length > 8000 || OptimizerKey.Length > 8000) throw new IOException("模型、密钥或提示词模板过长。");
        if (AuthHeader.Length > 80 || AuthPrefix.Length > 100 || AuthHeader.Any(c => !(char.IsAsciiLetterOrDigit(c) || c == '-')) || AuthPrefix.Contains('\r') || AuthPrefix.Contains('\n') || ApiKey.Contains('\r') || ApiKey.Contains('\n')) throw new IOException("认证请求头或密钥格式无效。");
        foreach (var json in new[] { HeadersJson, ExtraJson, RequestJson }) if (json.Length > 24000 || JsonNode.Parse(json) is not JsonObject) throw new IOException("高级请求配置必须为有效的 JSON 对象，且小于 24000 字符。");
        foreach (var header in (JsonObject)JsonNode.Parse(HeadersJson)!) if (header.Value is not JsonValue value || !value.TryGetValue<string>(out var text) || header.Key.Equals("Host", StringComparison.OrdinalIgnoreCase) || header.Key.Equals("Content-Length", StringComparison.OrdinalIgnoreCase) || header.Key.Any(c => !(char.IsAsciiLetterOrDigit(c) || c == '-')) || text.Contains('\n') || text.Contains('\r')) throw new IOException("附加请求头应为字符串键值对，不能修改 Host 或 Content-Length。");
        foreach (var path in new[] { CreatePath, PollPath, ContentPath, ModelsPath, OptimizerPath, IdPath, StatusPath, ProgressPath, UrlPath, SuccessStates, FailureStates }) if (path.Length > 2000 || path.Contains('\r') || path.Contains('\n')) throw new IOException("接口路径或状态映射格式无效。");
        foreach (var url in new[] { BaseUrl, OptimizerBaseUrl }) if (url.Length > 0) AiVideoHttp.BaseUri(url);
        if (Directory.Length > 0 && !Path.IsPathFullyQualified(Directory)) throw new IOException("AI 背景保存目录必须是绝对路径。");
        if (connection)
        {
            AiVideoHttp.BaseUri(BaseUrl);
            if (string.IsNullOrWhiteSpace(Model) || string.IsNullOrWhiteSpace(CreatePath)) throw new IOException("请填写视频模型与创建任务路径。");
            if (AuthHeader.Length > 0 && string.IsNullOrWhiteSpace(ApiKey)) throw new IOException("请填写视频 API 密钥，或将认证请求头留空以使用免密钥服务。");
            if (Optimize) { AiVideoHttp.BaseUri(OptimizerBaseUrl.Length > 0 ? OptimizerBaseUrl : BaseUrl); if (string.IsNullOrWhiteSpace(OptimizerModel)) throw new IOException("请填写提示词优化模型。"); }
        }
    }
}

public sealed class AiVideoSettingsStore(string path)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    public AiVideoSettings Current { get; private set; } = new();
    public string? LoadError { get; private set; }
    public void Load()
    {
        try
        {
            if (!File.Exists(path)) return;
            Current = JsonSerializer.Deserialize<AiVideoSettings>(WindowsUserSecret.Unprotect(File.ReadAllBytes(path)), AppPaths.Json) ?? new();
            Current.Validate();
        }
        catch (Exception error) when (error is IOException or JsonException or CryptographicException or UnauthorizedAccessException)
        { Current = new(); LoadError = "AI 配置无法解密或读取，已保留原文件。请重新填写并保存设置。"; }
    }
    public AiVideoSettings Merge(AiVideoSettings draft, bool clearKey = false, bool clearOptimizerKey = false) => draft with
    { ApiKey = clearKey ? "" : string.IsNullOrEmpty(draft.ApiKey) ? Current.ApiKey : draft.ApiKey, OptimizerKey = clearOptimizerKey ? "" : string.IsNullOrEmpty(draft.OptimizerKey) ? Current.OptimizerKey : draft.OptimizerKey };
    public object View() => new { settings = Current.Public(), hasApiKey = Current.ApiKey.Length > 0, hasOptimizerKey = Current.OptimizerKey.Length > 0, loadError = LoadError };
    public async Task SaveAsync(AiVideoSettings settings, CancellationToken token)
    {
        settings.Validate();
        await gate.WaitAsync(token);
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            System.IO.Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
            await File.WriteAllBytesAsync(temporary, WindowsUserSecret.Protect(JsonSerializer.SerializeToUtf8Bytes(settings, AppPaths.Json)), token);
            token.ThrowIfCancellationRequested(); File.Move(temporary, path, true); Current = settings; LoadError = null;
        }
        finally { File.Delete(temporary); gate.Release(); }
    }
}

// Windows DPAPI binds configuration and credentials to the current Windows user.
internal static class WindowsUserSecret
{
    [StructLayout(LayoutKind.Sequential)] private struct Blob { public int Size; public IntPtr Data; }
    [DllImport("crypt32.dll", SetLastError = true)] private static extern bool CryptProtectData(ref Blob input, string? description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out Blob output);
    [DllImport("crypt32.dll", SetLastError = true)] private static extern bool CryptUnprotectData(ref Blob input, IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out Blob output);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    public static byte[] Protect(byte[] bytes) => Transform(bytes, true);
    public static byte[] Unprotect(byte[] bytes) => Transform(bytes, false);
    private static byte[] Transform(byte[] bytes, bool encrypt)
    {
        var input = new Blob { Size = bytes.Length, Data = Marshal.AllocHGlobal(bytes.Length) };
        var output = new Blob();
        try
        {
            Marshal.Copy(bytes, 0, input.Data, bytes.Length);
            bool success = encrypt ? CryptProtectData(ref input, null, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output) : CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output);
            if (!success) throw new CryptographicException("无法使用 Windows 用户凭据保护 AI 配置。");
            var result = new byte[output.Size]; Marshal.Copy(output.Data, result, 0, result.Length); return result;
        }
        finally { Marshal.FreeHGlobal(input.Data); if (output.Data != IntPtr.Zero) LocalFree(output.Data); }
    }
}
