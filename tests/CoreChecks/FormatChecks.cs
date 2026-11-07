using System.Text.Json;
using VinylMV.Core;

static class FormatChecks
{
    public static async Task Run(string folder, DependencyService dependencies, Action<bool, string> check)
    {
        using var manifest = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(folder, "manifest.json")));
        var service = new MediaService(dependencies);
        var registered = new List<string>();
        string Register(string path) { registered.Add(path); return new Uri(path).AbsoluteUri; }
        var results = new List<object>();
        foreach (var fixture in manifest.RootElement.GetProperty("audio").EnumerateArray())
        {
            var path = fixture.GetProperty("path").GetString()!;
            registered.Clear();
            var audio = await service.ReadAudioAsync(path, Register, CancellationToken.None);
            check(audio.Duration > 7.8 && audio.Duration < 8.5 && audio.LocalLyrics?.Contains("月光") == true,
                MediaFormats.Label(path) + " 音乐读取时长与同名歌词");
            check(audio.Path == path && registered.Contains(path) && audio.PreviewConverted == fixture.GetProperty("converted").GetBoolean(),
                Path.GetFileName(path) + " 保留原始路径并选择兼容预览");
            if (fixture.GetProperty("tagged").GetBoolean())
                check(audio.Title == "湖畔来信" && audio.Artist == "拾音测试", Path.GetFileName(path) + " 读取格式或流中的中文标签");
            if (fixture.GetProperty("cover").GetBoolean()) check(File.Exists(audio.CoverPath), Path.GetFileName(path) + " 提取内嵌封面");
            var pcm = Convert.FromBase64String(await service.ReadSpectrumSamplesAsync(path, .3, CancellationToken.None));
            check(pcm.Length > 1000 && pcm.Any(b => b != 0), Path.GetFileName(path) + " 原始音频频谱读取");
            results.Add(audio);
        }
        foreach (var fixture in manifest.RootElement.GetProperty("video").EnumerateArray())
        {
            var path = fixture.GetProperty("path").GetString()!;
            registered.Clear();
            var video = await service.ReadVideoAsync(path, Register, CancellationToken.None);
            check(video.Duration > 1.8 && video.Duration < 2.5 && video.Width > 0 && video.Height > 0,
                MediaFormats.Label(path) + " 背景读取时长与尺寸");
            check(video.Path == path && registered.Contains(path) && video.PreviewConverted && new Uri(video.Url).LocalPath.EndsWith(".mp4"),
                Path.GetFileName(path) + " 原始背景保留并转换 MP4 预览");
            var repeated = await service.ReadVideoAsync(path, Register, CancellationToken.None);
            check(repeated.Url == video.Url, Path.GetFileName(path) + " 复用预览缓存");
            results.Add(video);
        }
        bool rejected = false;
        try { await service.ReadAudioAsync(manifest.RootElement.GetProperty("invalid").GetString()!, Register, CancellationToken.None); }
        catch (IOException error) { rejected = error.Message.Any(c => c is >= '\u4e00' and <= '\u9fff'); }
        check(rejected, "损坏媒体给出中文提示");
        rejected = false;
        try { await service.ReadVideoAsync(manifest.RootElement.GetProperty("audio")[1].GetProperty("path").GetString()!, Register, CancellationToken.None); }
        catch (IOException error) { rejected = error.Message.Contains("不包含视频"); }
        check(rejected, "音乐封面不会被误识别为背景视频");
        // Cancel before a preview is committed and ensure retry can finish from the same original.
        var cancelPath = Path.Combine(folder, "取消后重试.wma");
        File.Copy(Path.Combine(folder, "音乐-wma.wma"), cancelPath, true);
        using var cancel = new CancellationTokenSource();
        var cancelService = new MediaService(dependencies, _ => cancel.Cancel());
        rejected = false;
        try { await cancelService.ReadAudioAsync(cancelPath, Register, cancel.Token); }
        catch (OperationCanceledException) { rejected = true; }
        check(rejected, "取消预览准备终止解码操作");
        var retried = await service.ReadAudioAsync(cancelPath, Register, CancellationToken.None);
        check(retried.PreviewConverted && File.Exists(new Uri(retried.Url).LocalPath), "取消后可重新导入同一素材");
        await File.WriteAllTextAsync(Path.Combine(folder, "core-result.json"), JsonSerializer.Serialize(results, AppPaths.Json));
    }
}
