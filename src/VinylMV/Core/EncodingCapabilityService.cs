using System.IO;
using System.Text.Json;

namespace VinylMV.Core;

public sealed class EncodingCapabilityService(DependencyService dependencies)
{
    private string? cacheKey;
    private Task<JsonElement>? cached;

    public async Task<JsonElement> ReadAsync(bool refresh, CancellationToken token)
    {
        var deps = dependencies.Current ?? await dependencies.DetectAsync(token);
        if (!deps.Ready) throw new IOException("请先安装 FFmpeg 和 Python，再检测编码能力。");
        var file = new FileInfo(deps.Ffmpeg.Path!);
        var key = file.FullName + "|" + file.Length + "|" + file.LastWriteTimeUtc.Ticks;
        if (cached == null || cached.IsFaulted || cached.IsCanceled || cacheKey != key || refresh && cached.IsCompleted)
        {
            cacheKey = key;
            cached = ProbeAsync(deps, token);
        }
        return await cached;
    }

    private static async Task<JsonElement> ProbeAsync(Dependencies deps, CancellationToken token)
    {
        var module = Path.Combine(RendererBundle.Validate(AppContext.BaseDirectory), "encoding_settings.py");
        var result = await ProcessRunner.RunAsync(deps.Python.Path!, ["-B", module, "--probe", deps.Ffmpeg.Path!], token, 50);
        if (result.Code != 0) throw new IOException("无法检测编码能力，请确认 FFmpeg 可用后重新检测。");
        using var json = JsonDocument.Parse(result.Output);
        return json.RootElement.Clone();
    }
}
