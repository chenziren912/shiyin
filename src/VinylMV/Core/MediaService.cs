using System.IO;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace VinylMV.Core;

public sealed class MediaService(DependencyService dependencies, Action<string>? report = null)
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> previewLocks = new();

    public async Task<string> ReadSpectrumSamplesAsync(string path, double seconds, CancellationToken token, double historySeconds = .3)
    {
        if (!double.IsFinite(seconds) || seconds is < 0 or > 43200) throw new IOException("预览时间无效。");
        if (seconds == 0) return "";
        var deps = dependencies.Current ?? await dependencies.DetectAsync(token);
        if (!deps.Ffmpeg.Ready) throw new IOException("请先准备 FFmpeg。");
        if (!double.IsFinite(historySeconds)) throw new IOException("音频分析时长无效。");
        var length = Math.Min(Math.Clamp(historySeconds, .3, 3), seconds);
        string Number(double value) => value.ToString("0.######", System.Globalization.CultureInfo.InvariantCulture);
        using var process = new System.Diagnostics.Process { StartInfo = ProcessRunner.StartInfo(deps.Ffmpeg.Path!, ["-v", "error", "-nostdin", "-ss", Number(seconds - length), "-i", path, "-t", Number(length), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"]) };
        process.Start();
        using var registration = token.Register(() => { try { process.Kill(true); } catch (InvalidOperationException) { } });
        var errorTask = process.StandardError.ReadToEndAsync(token);
        using var output = new MemoryStream();
        await process.StandardOutput.BaseStream.CopyToAsync(output, token);
        await process.WaitForExitAsync(token);
        var error = await errorTask;
        token.ThrowIfCancellationRequested();
        if (process.ExitCode != 0) throw new IOException("无法读取当前时刻的音频曲线。" + error[..Math.Min(300, error.Length)]);
        return Convert.ToBase64String(output.ToArray());
    }

    private async Task<JsonDocument> Probe(string path, CancellationToken token)
    {
        var deps = dependencies.Current ?? await dependencies.DetectAsync(token);
        if (!deps.Ffmpeg.Ready) throw new InvalidOperationException("请先安装 FFmpeg。");
        var probe = Path.Combine(Path.GetDirectoryName(deps.Ffmpeg.Path)!, "ffprobe.exe");
        var result = await ProcessRunner.RunAsync(probe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", path], token);
        if (result.Code != 0) throw new IOException("无法读取媒体文件，请检查文件是否完整。");
        return JsonDocument.Parse(result.Output);
    }

    public async Task<AudioInfo> ReadAudioAsync(string path, Func<string, string> register, CancellationToken token)
    {
        using var metadata = await Probe(path, token);
        var root = metadata.RootElement;
        var stream = root.GetProperty("streams").EnumerateArray().FirstOrDefault(s => s.GetProperty("codec_type").GetString() == "audio");
        if (stream.ValueKind != JsonValueKind.Object) throw new IOException("选择的文件不包含音频。");
        var format = root.GetProperty("format");
        double duration = MediaDuration(format, stream);
        if (duration <= 0 || duration > 43200) throw new IOException("音频时长无效或超过 12 小时。");
        string Tag(string name) => ReadTag(format, name) is { Length: > 0 } tag ? tag : ReadTag(stream, name);
        var title = Tag("title"); var artist = Tag("artist");
        if (string.IsNullOrWhiteSpace(artist)) artist = Tag("album_artist");
        if (string.IsNullOrWhiteSpace(title))
        {
            var parts = Path.GetFileNameWithoutExtension(path).Split(" - ", 2);
            if (parts.Length == 2) { artist = string.IsNullOrWhiteSpace(artist) ? parts[0] : artist; title = parts[1]; }
            else title = parts[0];
        }
        string? cover = null;
        var picture = root.GetProperty("streams").EnumerateArray().FirstOrDefault(IsCover);
        if (picture.ValueKind == JsonValueKind.Object)
        {
            var target = Path.Combine(AppPaths.Cache, Guid.NewGuid().ToString("N") + ".png");
            var result = await ProcessRunner.RunAsync(dependencies.Current!.Ffmpeg.Path!, ["-v", "error", "-y", "-i", path, "-an", "-map", "0:" + picture.GetProperty("index").GetInt32(), "-vf", "scale=640:640:force_original_aspect_ratio=decrease", "-frames:v", "1", "-update", "1", target], token);
            if (result.Code == 0 && File.Exists(target)) cover = target;
        }
        string? lyrics = null;
        var local = Path.ChangeExtension(path, ".lrc");
        if (File.Exists(local) && new FileInfo(local).Length < 2_000_000) lyrics = ReadLyrics(local);
        else if (Tag("lyrics").Contains('[')) lyrics = Tag("lyrics");
        register(path); // Authorize the original for export even when preview uses a copy.
        var preview = NativeAudio(path, stream) ? path : await PreparePreview(path, false, token);
        if (preview != path)
        {
            // Raw AAC and some other containers only report an estimated source duration.
            using var prepared = await Probe(preview, token);
            var measured = Duration(prepared.RootElement.GetProperty("format"));
            if (measured > 0) duration = measured;
        }
        return new(path, register(preview), title.Trim(), artist.Trim(), Tag("album"), duration, cover, cover != null ? register(cover) : null, lyrics, MediaFormats.Label(path), preview != path, Tag("genre"));
    }

    public async Task<VideoInfo> ReadVideoAsync(string path, Func<string, string> register, CancellationToken token, bool preparePreview = true)
    {
        using var metadata = await Probe(path, token);
        var video = metadata.RootElement.GetProperty("streams").EnumerateArray().FirstOrDefault(s => s.GetProperty("codec_type").GetString() == "video" && !IsCover(s));
        if (video.ValueKind != JsonValueKind.Object) throw new IOException("选择的文件不包含视频。");
        var duration = MediaDuration(metadata.RootElement.GetProperty("format"), video);
        if (duration <= 0 || duration > 43200) throw new IOException("视频时长无效或超过 12 小时。");
        register(path);
        var preview = !preparePreview || NativeVideo(path, video) ? path : await PreparePreview(path, true, token);
        return new(path, register(preview), Path.GetFileName(path), duration, video.GetProperty("width").GetInt32(), video.GetProperty("height").GetInt32(), MediaFormats.Label(path), preview != path);
    }

    private static bool IsCover(JsonElement stream) => stream.TryGetProperty("disposition", out var d) && d.TryGetProperty("attached_pic", out var a) && a.GetInt32() == 1;
    private static string ReadTag(JsonElement owner, string name) => owner.TryGetProperty("tags", out var tags)
        ? tags.EnumerateObject().FirstOrDefault(p => p.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).Value is var value && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "" : "";
    private static bool NativeAudio(string path, JsonElement stream)
    {
        var codec = stream.TryGetProperty("codec_name", out var c) ? c.GetString() : "";
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".mp3" => codec == "mp3", ".m4a" => codec == "aac", ".flac" => codec == "flac",
            ".ogg" or ".opus" => codec is "vorbis" or "opus", ".wav" => codec is "pcm_s16le" or "pcm_s24le" or "pcm_f32le", _ => false
        };
    }
    private static bool NativeVideo(string path, JsonElement stream) => (Path.GetExtension(path).ToLowerInvariant() is ".mp4" or ".m4v")
        && stream.TryGetProperty("codec_name", out var codec) && codec.GetString() == "h264"
        && stream.TryGetProperty("pix_fmt", out var pixel) && pixel.GetString() == "yuv420p";

    private async Task<string> PreparePreview(string path, bool video, CancellationToken token)
    {
        var source = new FileInfo(path);
        var signature = $"preview-v1|{source.FullName}|{source.Length}|{source.LastWriteTimeUtc.Ticks}|{video}";
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(signature)));
        var target = Path.Combine(AppPaths.Cache, "preview-" + key + (video ? ".mp4" : ".m4a"));
        var gate = previewLocks.GetOrAdd(key, _ => new(1, 1));
        await gate.WaitAsync(token);
        string? partial = null;
        try
        {
            if (File.Exists(target) && new FileInfo(target).Length > 0) return target;
            report?.Invoke(video ? "正在准备兼容的视频预览，较长的视频可能需要一些时间…" : "正在准备兼容的音乐预览…");
            partial = Path.Combine(AppPaths.Cache, "preview-" + Guid.NewGuid().ToString("N") + (video ? ".mp4" : ".m4a"));
            var arguments = new List<string> { "-v", "error", "-nostdin", "-y", "-i", path };
            if (video)
                arguments.AddRange(["-map", "0:V:0", "-an", "-sn", "-dn", "-vf", "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=30", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p", "-threads", "2"]);
            else
                arguments.AddRange(["-map", "0:a:0", "-vn", "-sn", "-dn", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000"]);
            arguments.AddRange(["-map_metadata", "-1", "-movflags", "+faststart", partial]);
            var deps = dependencies.Current ?? await dependencies.DetectAsync(token);
            var result = await ProcessRunner.RunAsync(deps.Ffmpeg.Path!, arguments, token, timeoutSeconds: 7200);
            token.ThrowIfCancellationRequested();
            if (result.Code != 0 || !File.Exists(partial) || new FileInfo(partial).Length == 0)
                throw new IOException(video ? "无法准备视频预览，请检查文件是否完整或更新 FFmpeg。" : "无法解码此音乐格式，请检查文件是否完整或更新 FFmpeg。");
            File.Move(partial, target, true); partial = null;
            return target;
        }
        finally
        {
            if (partial != null) { try { File.Delete(partial); } catch (IOException) { } }
            gate.Release();
        }
    }

    public static string ReadLyrics(string path)
    {
        if (new FileInfo(path).Length > 2_000_000) throw new IOException("歌词文件过大，请选择小于 2 MB 的 LRC 文件。");
        var bytes = File.ReadAllBytes(path);
        try { return new System.Text.UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF'); }
        catch (System.Text.DecoderFallbackException)
        {
            System.Text.Encoding.RegisterProvider(System.Text.CodePagesEncodingProvider.Instance);
            return System.Text.Encoding.GetEncoding(936).GetString(bytes);
        }
    }

    private static double Duration(JsonElement owner) => owner.TryGetProperty("duration", out var value) && double.TryParse(value.GetString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var duration) && double.IsFinite(duration) && duration > 0 ? duration : 0;
    private static double MediaDuration(JsonElement format, JsonElement stream) => Duration(format) is > 0 and var duration ? duration : Duration(stream);
}
