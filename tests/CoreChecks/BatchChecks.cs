using System.Text.Json;
using VinylMV.Core;

static class BatchChecks
{
    public static async Task Run(string root, DependencyService dependencies, Action<bool, string> check)
    {
        var directory = Path.Combine(root, "batch-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
        var original = Path.GetFullPath(Path.Combine(root, "..", "中文路径 ' [测试]"));
        var videoPath = Path.Combine(original, "短背景.mp4");
        var rock = new LibraryVideo("rock", videoPath, "摇滚视频", ["Rock", "电子"], 2, 640, 360);
        var pop = new LibraryVideo("pop", videoPath, "流行视频", ["Pop"], 2, 640, 360);
        var missing = rock with { Id = "missing", Path = Path.Combine(directory, "失效.mp4") };
        check(MusicGenres.Parse("Pop，ROCK / 电子; pop").SequenceEqual(new[] { "流行", "摇滚", "电子" }), "音乐风格支持别名、多标签与去重");
        check(Enumerable.Range(0, 30).All(_ => MusicGenres.Assign("a", ["摇滚"], [rock, pop, missing]).Video.Id == "rock"), "只从对应风格的可用视频随机选择");
        var fallback = Enumerable.Range(0, 100).Select(_ => MusicGenres.Assign("a", ["爵士"], [rock, pop, missing])).ToArray();
        check(fallback.All(a => !a.Matched && a.Video.Id != "missing") && fallback.Select(a => a.Video.Id).Distinct().Count() == 2, "无匹配风格时从全库随机，排除失效视频");
        bool rejected = false;
        try { MusicGenres.Assign("a", [], [missing]); } catch (IOException) { rejected = true; }
        check(rejected, "视频库没有可用素材时阻止分配");
        var sequential = new BatchBackgroundPlanner([rock, pop, missing], new(Scope: "all", Order: "sequence"));
        check(Enumerable.Range(0, 5).Select(_ => sequential.Choose([]).Video!.Id).SequenceEqual(new[] { "rock", "pop", "rock", "pop", "rock" }), "顺序分配循环遍历可用视频并排除失效文件");
        var balanced = new BatchBackgroundPlanner([rock, pop], new(Scope: "all", AvoidRepeat: true), random: new Random(29));
        var draws = Enumerable.Range(0, 8).Select(_ => balanced.Choose([]).Video!.Id).ToArray();
        check(Enumerable.Range(0, 4).All(i => draws.Skip(i * 2).Take(2).Distinct().Count() == 2), "随机减少重复时候选池用完后再循环");
        var reserved = new BatchBackgroundPlanner([rock, pop], new(Scope: "all", AvoidRepeat: true), ["rock"]);
        check(reserved.Choose([]).Video!.Id == "pop", "保留的任务分配计入减少重复，新增任务使用较少分配的视频");
        var strict = new BatchBackgroundPlanner([rock, pop, missing], new(NoMatch: "unassigned"));
        check(strict.Choose(["爵士"]).Video == null && strict.Choose([]).Reason!.Contains("没有匹配"), "严格匹配在风格缺失或不匹配时保留未分配状态");
        check(strict.Choose(["Rock"]).Video!.Id == "rock", "严格匹配仍支持风格别名");
        check(strict.Choose(["爵士"], "pop").Video!.Id == "pop", "保留已分配任务不受新策略影响");
        var styled = new BatchBackgroundPlanner([rock, pop], new(AvoidRepeat: true), ["rock", "rock"]);
        check(styled.Choose(["Rock"]).Video!.Id == "rock", "减少重复不会越过风格匹配候选范围");
        check(new BatchBackgroundPlanner([missing], new()).Choose([]).Video == null, "无可用背景时返回可说明的未分配结果");
        rejected = false;
        try { new BatchBackgroundPlanner([rock], new(Order: "invalid")); } catch (IOException) { rejected = true; }
        check(rejected, "后端拒绝非法分配策略");
        var libraryPath = Path.Combine(directory, "library.json");
        var store = new VideoLibrary(libraryPath);
        await store.UpdateAsync(items => { items.Add(rock); items.Add(pop); }, CancellationToken.None);
        var restored = await new VideoLibrary(libraryPath).LoadAsync(CancellationToken.None);
        check(restored.Count == 2 && restored[0].Genres.Contains("摇滚"), "视频库与多风格标签跨实例保存");
        await store.UpdateAsync(items => items.RemoveAll(v => v.Id == "rock"), CancellationToken.None);
        check(File.Exists(videoPath) && (await store.LoadAsync(CancellationToken.None)).Count == 1, "移除视频库条目保留原始文件");
        var media = new MediaService(dependencies);
        var audio = await media.ReadAudioAsync(Path.Combine(original, "测试音乐.mp3"), path => path, CancellationToken.None);
        var name = OutputFormats.BatchName("{序号} - {歌手} - {歌名}", 3, audio with { Title = "测试:/歌名" }, "webm");
        check(name == "003 - 拾音测试 - 测试__歌名.webm", "批量模板替换并清理文件名非法字符");
        check(OutputFormats.BatchName("CON", 1, audio, "mkv") == "_CON.mkv" && OutputFormats.FileName("歌词.mp4", "mov") == "歌词.mov", "保留名和导出容器后缀处理正确");
        using var lyrics = new LyricsService();
        var renderer = new RenderService(dependencies); var batch = new BatchRenderService(renderer, lyrics);
        var good = new RenderRequest(audio.Path, videoPath, null, audio.Title, audio.Artist, "[00:00]批量测试", .6, 100, 45, 44, 854, 480, 24, directory, "同名作品.mkv", ShowSpectrum: false, Container: "mkv");
        var progress = new List<object>();
        var results = await batch.RunAsync(new([new("bad", good with { AudioPath = Path.Combine(directory, "不存在.mp3") }), new("one", good), new("two", good)], SearchLyrics: false), progress.Add, CancellationToken.None);
        check(results.Select(r => r.Status).SequenceEqual(new[] { "failed", "completed", "completed" }), "单首失败后继续处理后续音乐");
        check(results[1].Output != results[2].Output && results.Skip(1).All(r => File.Exists(r.Output)) && results[2].Output!.EndsWith("同名作品 (2).mkv"), "同名批量作品增加序号并保留容器后缀");
        using var cancel = new CancellationTokenSource();
        var cancelled = await batch.RunAsync(new([new("stop", good with { Duration = 5, FileName = "取消作品.mkv" }), new("pending", good)], SearchLyrics: false), data =>
        {
            var record = JsonSerializer.SerializeToElement(data, AppPaths.Json);
            if (record.TryGetProperty("data", out var update) && update.TryGetProperty("event", out var kind) && kind.GetString() == "progress") cancel.Cancel();
        }, cancel.Token);
        check(cancelled.All(r => r.Status == "cancelled") && !batch.IsRunning && !renderer.IsRunning, "停止当前批量任务后终止剩余队列并释放渲染器");
        check(!Directory.EnumerateFiles(directory, ".vinyl-*").Any() && results.Skip(1).All(r => File.Exists(r.Output)), "停止批量任务清理临时视频并保留已完成作品");
        var skipped = await batch.RunAsync(new([new("no-lyrics", good with { Lyrics = "普通歌词" })], SearchLyrics: false, MissingLyrics: "skip"), _ => { }, CancellationToken.None);
        check(skipped[0].Status == "skipped", "缺失时间轴歌词可按设置跳过");
        var invalidTime = await batch.RunAsync(new([new("invalid-time", good with { Lyrics = "[00:99]错误时间\n[00:01][00:02]" })], SearchLyrics: false, MissingLyrics: "skip"), _ => { }, CancellationToken.None);
        check(invalidTime[0].Status == "skipped", "无效秒数与空时间戳不被当作可用歌词");
        var stopped = await batch.RunAsync(new([new("first-fail", good with { AudioPath = Path.Combine(directory, "不存在.mp3") }), new("not-run", good)], SearchLyrics: false, ContinueOnError: false), _ => { }, CancellationToken.None);
        check(stopped[0].Status == "failed" && stopped[1].Status == "skipped", "关闭失败后继续时停止后续任务");
        const string fixedText = "该歌曲暂无可用歌词\n请欣赏音乐";
        string? captured = null; string captureText = fixedText;
        void CaptureAss(object data)
        {
            var update = JsonSerializer.SerializeToElement(data, AppPaths.Json);
            if (captured != null || !update.TryGetProperty("data", out var detail) || !detail.TryGetProperty("event", out var kind) || kind.GetString() != "progress") return;
            foreach (var config in Directory.EnumerateFiles(AppPaths.Jobs, "config.json", SearchOption.AllDirectories))
            {
                var payload = JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(config));
                if (Path.GetDirectoryName(payload.GetProperty("outputPath").GetString()) != directory) continue;
                if (!payload.TryGetProperty("emptyLyricsText", out var placeholder) || placeholder.GetString() != captureText) continue;
                var ass = Path.Combine(Path.GetDirectoryName(config)!, "lyrics.ass");
                if (File.Exists(ass)) captured = File.ReadAllText(ass);
            }
        }
        var withMessage = await batch.RunAsync(new([new("message", good with { Lyrics = "", FileName = "固定歌词.mkv" })], SearchLyrics: false, MissingLyrics: "message", MissingLyricsText: fixedText), CaptureAss, CancellationToken.None);
        check(withMessage[0].Status == "completed" && captured?.Contains("该歌曲暂无可用歌词\\N请欣赏音乐") == true && !captured.Contains("纯音乐 ·"), "实际批量导出将自定义多行固定文字写入整首视频字幕");
        File.WriteAllText(Path.Combine(directory, "固定歌词.ass"), captured!);
        captured = null; captureText = "";
        var blank = await batch.RunAsync(new([new("blank", good with { Lyrics = "", FileName = "歌词留空.mkv" })], SearchLyrics: false), CaptureAss, CancellationToken.None);
        check(blank[0].Status == "completed" && captured != null && !captured.Split('\n').Any(line => line.StartsWith("Dialogue: 1,") && line.Contains(",歌词,,")), "实际无歌词导出不再混入默认纯音乐提示");
        File.WriteAllText(Path.Combine(directory, "歌词留空.ass"), captured!);
        rejected = false;
        try { await batch.RunAsync(new([new("empty", good)], SearchLyrics: false, MissingLyrics: "message", MissingLyricsText: " "), _ => { }, CancellationToken.None); } catch (IOException) { rejected = true; }
        check(rejected && !batch.IsRunning, "空固定文字在执行队列前被拒绝");
        await File.WriteAllTextAsync(Path.Combine(directory, "result.json"), JsonSerializer.Serialize(new { results, cancelled, skipped, invalidTime, stopped, withMessage, blank }, AppPaths.Json));
    }
}
