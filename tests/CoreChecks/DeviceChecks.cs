using System.Collections.Concurrent;
using System.Text.Json;
using VinylMV.Core;

static class DeviceChecks
{
    static JsonElement Settings(string backend = "software", double bitrate = 2) => JsonSerializer.SerializeToElement(new { encoder = backend, codec = "h264", rateControl = "vbr", bitrateMbps = bitrate, preset = "ultrafast", threads = 2 });
    static JsonElement Curve(string type = "curve", int fft = 1024, int bands = 48) => JsonSerializer.SerializeToElement(new { cards = new[] { new { id = "spectrum", visualization = type, fftSize = fft, bandCount = bands } } });
    public static async Task Run(string root, DependencyService dependencies, Action<bool, string> check)
    {
        var folder = Path.Combine(root, "devices-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(folder);
        var graphics = GraphicsInventory.Read();
        check(graphics.Names.All(n => !string.IsNullOrWhiteSpace(n)) && graphics.Signature == GraphicsInventory.Read().Signature,
            "DXGI 直接枚举显卡型号和驱动指纹，连续读取结果稳定");
        var cpu = new EncoderCandidate("software", "CPU", 25, Settings());
        var gpu = new EncoderCandidate("nvenc", "GPU", 100, Settings("nvenc"));
        check(BatchDispatchPolicy.Choose([cpu, gpu], new(5, 5), false, 85) == gpu, "首个任务使用当前参数实测更快的编码器");
        check(BatchDispatchPolicy.Choose([cpu, gpu], new(10, 70), true, 85) == cpu, "新增任务优先分配到占用较低的 CPU");
        check(BatchDispatchPolicy.Choose([cpu, gpu], new(70, 10), true, 85) == gpu, "新增任务优先分配到占用较低的 GPU");
        check(BatchDispatchPolicy.Choose([cpu, gpu], new(95, 5), true, 85) == null, "CPU 合成负载饱和时不再增加 GPU 任务");
        check(BatchDispatchPolicy.Choose([gpu], new(5, null), true, 85) == null && BatchDispatchPolicy.Choose([cpu], new(null, 0), true, 85) == null, "无法读取资源占用时不假定设备空闲");
        var identity = new DeviceSnapshot("CPU", 8, ["GPU"], "a");
        var profile = new BenchmarkProfile("mp4", 854, 480, 24, Settings());
        string key = DevicePerformanceService.Key(profile, identity);
        check(key != DevicePerformanceService.Key(profile with { Encoding = Settings(bitrate: 4) }, identity), "码率改变不会复用原参数测速结果");
        check(key != DevicePerformanceService.Key(profile with { Container = "mkv" }, identity) && key != DevicePerformanceService.Key(profile with { Fps = 30 }, identity), "容器与帧率分别参与性能记录匹配");
        check(key != DevicePerformanceService.Key(profile, identity with { Fingerprint = "driver-changed" }), "设备或驱动指纹变化使原测速失效");
        check(key == DevicePerformanceService.Key(profile with { Encoding = Settings("nvenc") }, identity), "自动对比同一参数的 CPU 和 GPU 时忽略手动选定的后端");
        check(key != DevicePerformanceService.Key(profile with { ShowSpectrum = false }, identity), "音频曲线开关分别匹配测速，不复用纯编码结果");
        var curveProfile = profile with { Layout = Curve() };
        var curveKey = DevicePerformanceService.Key(curveProfile, identity);
        check(curveKey != DevicePerformanceService.Key(profile with { Layout = Curve("mirror") }, identity) &&
            curveKey != DevicePerformanceService.Key(profile with { Layout = Curve("bars") }, identity), "平滑、镜像与柱状图分别匹配测速记录");
        check(curveKey != DevicePerformanceService.Key(profile with { Layout = Curve(fft: 4096) }, identity) &&
            curveKey != DevicePerformanceService.Key(profile with { Layout = Curve(bands: 192) }, identity), "FFT 精度与频段数改变后重新匹配测速");
        using (var monitor = new ResourceMonitor())
        {
            await Task.Delay(1200); var sample = monitor.Sample();
            check(sample.Cpu is >= 0 and <= 100 && (sample.Gpu == null || sample.Gpu is >= 0 and <= 100), "真实 Windows 资源计数器返回有效占用或明确不可读取");
        }
        using var lyrics = new LyricsService();
        var render = new RenderRequest("fixture.mp3", null, null, "测试", "测试", "[00:00]歌词", 1, 100, 45, 44, 854, 480, 24, folder, "同名.mp4", Encoding: Settings());
        var items = Enumerable.Range(0, 7).Select(i => new BatchRenderItem(i.ToString(), render)).ToArray();
        var state = new WorkState();
        var service = new BatchRenderService(new FakeWorker(state), lyrics, new Selector([cpu, gpu]), () => new LoadMonitor(new(10, 75)), 20);
        var result = await service.RunAsync(new(items, SearchLyrics: false), _ => { }, CancellationToken.None);
        check(result.All(r => r.Status == "completed") && state.Peak == 3, "智能并发默认最多三个任务，结果保持队列顺序");
        check(state.Encoders.Contains("software") && state.Encoders.Contains("nvenc"), "同一批量队列可实际调度 CPU 与 GPU 两类工作器");
        state = new();
        result = await new BatchRenderService(new FakeWorker(state), lyrics, monitorFactory: () => new LoadMonitor(new(5, 5)), rampMilliseconds: 10)
            .RunAsync(new(items, SearchLyrics: false, MaxParallel: 5), _ => { }, CancellationToken.None);
        check(state.Peak == 5, "可调整并发上限并严格封顶");
        state = new();
        var manualRows = new[] { items[0], items[1] with { Request = render with { Encoding = Settings("qsv") } } };
        result = await new BatchRenderService(new FakeWorker(state), lyrics, monitorFactory: () => new LoadMonitor(new(5, 5)), rampMilliseconds: 10)
            .RunAsync(new(manualRows, SearchLyrics: false, MaxParallel: 1, AutoEncoder: false), _ => { }, CancellationToken.None);
        check(state.Encoders.Contains("software") && state.Encoders.Contains("qsv"), "关闭自动选择后，各行不同的手动编码器不会被同参数缓存覆盖");
        state = new();
        result = await new BatchRenderService(new FakeWorker(state), lyrics, monitorFactory: () => new LoadMonitor(new(95, 95)), rampMilliseconds: 10)
            .RunAsync(new(items.Take(3).ToArray(), SearchLyrics: false), _ => { }, CancellationToken.None);
        check(state.Peak == 1 && result.All(r => r.Status == "completed"), "设备繁忙时逐首推进，不无限等待外部负载");
        state = new();
        result = await new BatchRenderService(new FakeWorker(state), lyrics, new Selector([gpu]), () => new LoadMonitor(new(5, null)), 10)
            .RunAsync(new(items.Take(3).ToArray(), SearchLyrics: false), _ => { }, CancellationToken.None);
        check(state.Peak == 1, "GPU 占用不可读时不堆叠 GPU 会话");
        state = new() { FailGpu = true };
        result = await new BatchRenderService(new FakeWorker(state), lyrics, new Selector([gpu, cpu]), () => new LoadMonitor(new(10, 90)), 20)
            .RunAsync(new(items.Take(4).ToArray(), SearchLyrics: false), _ => { }, CancellationToken.None);
        check(result.All(r => r.Status == "completed") && state.GpuFailures == 1 && result.Any(r => r.Message?.Contains("回退 CPU") == true), "硬件失败自动回退已验证 CPU，并停止后续同类硬件分配");
        state = new() { FailFirst = true };
        result = await new BatchRenderService(new FakeWorker(state), lyrics, monitorFactory: () => new LoadMonitor(new(5, 5)), rampMilliseconds: 10)
            .RunAsync(new(items, SearchLyrics: false, ContinueOnError: false), _ => { }, CancellationToken.None);
        check(result[0].Status == "failed" && result.Any(r => r.Status == "completed") && result.Any(r => r.Status == "skipped") && state.Active == 0, "失败后停止新增任务，并等待已启动任务完成");
        state = new(); using var cancel = new CancellationTokenSource();
        service = new(new FakeWorker(state), lyrics, monitorFactory: () => new LoadMonitor(new(5, 5)), rampMilliseconds: 10);
        result = await service.RunAsync(new(items, SearchLyrics: false), _ => { if (state.Active >= 3) cancel.Cancel(); }, cancel.Token);
        check(result.All(r => r.Status == "cancelled") && state.Active == 0 && !service.IsRunning, "停止并发队列终止所有活动任务和等待任务并释放状态");
        bool rejected = false;
        try { await service.RunAsync(new(items, MaxParallel: 0), _ => { }, CancellationToken.None); } catch (IOException) { rejected = true; }
        check(rejected, "后端拒绝非法并发上限");
        var performance = new DevicePerformanceService(dependencies, Path.Combine(folder, "device-performance.json"));
        check((await performance.StatusAsync(CancellationToken.None)).Decision == "pending", "首次运行保持未决定状态，不擅自开始设备测速");
        await performance.DecideAsync("declined", CancellationToken.None);
        check(!(await performance.CandidatesAsync(render, 3, _ => throw new Exception("不应测速"), CancellationToken.None))[0].Measured, "拒绝设备检测时保留手动编码且不进行测速");
        await performance.DecideAsync("allowed", CancellationToken.None);
        var report = await performance.BenchmarkAsync(profile, true, _ => { }, CancellationToken.None);
        check(report.Results.Any(r => r.Encoder == "software" && r.Available && r.Fps > 0) && report.Results.Length == 4, "真实按指定码率与格式测试 CPU 和三类硬件编码器");
        check(report.Results.Where(r => r.Available).All(r => r.AnalysisSeconds > 0 && r.EncodeSeconds > 0 && r.SpectrumFrames == 72 &&
            Math.Abs(r.Seconds - r.AnalysisSeconds - r.EncodeSeconds) < .0002), "真实测速包含音频解码、FFT、72 帧曲线绘制与合成编码，合计耗时含分析阶段");
        int updates = 0;
        var cached = await performance.BenchmarkAsync(profile, false, _ => updates++, CancellationToken.None);
        check(cached.Key == report.Key && updates == 0, "相同输出参数复用实测结果，不重复占用设备");
        var restored = await new DevicePerformanceService(dependencies, Path.Combine(folder, "device-performance.json")).StatusAsync(CancellationToken.None);
        check(restored.Decision == "allowed" && restored.Device != null && restored.Device.Gpus.SequenceEqual(graphics.Names) && restored.Reports!.Length == 1,
            "检测选择、CPU 和 GPU 信息持久化保存，重开服务复用同一设备测速记录");
        using var benchmarkCancel = new CancellationTokenSource();
        var pendingBenchmark = performance.BenchmarkAsync(profile with { Encoding = Settings(bitrate: 3) }, true, _ => { }, benchmarkCancel.Token);
        bool secondRejected = false;
        try { await performance.BenchmarkAsync(profile, true, _ => { }, CancellationToken.None); } catch (IOException) { secondRejected = true; }
        benchmarkCancel.Cancel();
        try { await pendingBenchmark; } catch (OperationCanceledException) { }
        check(secondRejected && !performance.IsRunning && (await performance.StatusAsync(CancellationToken.None)).Reports!.Length == 1, "重复发起测速被拦截，取消后释放状态且保留已完成的测速记录");
        // Three real simultaneous exports exercise atomic name arbitration, not just the scheduler fake.
        var source = Path.GetFullPath(Path.Combine(root, "..", "中文路径 ' [测试]", "测试音乐.mp3"));
        var real = render with { AudioPath = source, FileName = "并发同名.mp4", ShowSpectrum = false, Duration = .8 };
        var outputs = await Task.WhenAll(Enumerable.Range(0, 3).Select(_ => new RenderService(dependencies).RenderAsync(real, _ => { }, CancellationToken.None)));
        check(outputs.Distinct().Count() == 3 && outputs.All(File.Exists) && !Directory.EnumerateFiles(folder, ".vinyl-*").Any(), "三个真实同时导出同名作品不覆盖文件且无遗留临时视频");
        await File.WriteAllTextAsync(Path.Combine(folder, "result.json"), JsonSerializer.Serialize(new { report, restored, outputs }, AppPaths.Json));
        Console.WriteLine("设备与并发证据：" + folder);
    }
    sealed class LoadMonitor(ResourceLoad load) : IResourceMonitor { public ResourceLoad Sample() => load; public void Dispose() { } }
    sealed class Selector(IReadOnlyList<EncoderCandidate> choices) : IBatchEncoderSelector
    { public Task<IReadOnlyList<EncoderCandidate>> CandidatesAsync(RenderRequest request, int maximum, Action<object> progress, CancellationToken token) => Task.FromResult(choices); }
    sealed class WorkState
    {
        public int Active, Peak, GpuFailures, Started;
        public bool FailGpu, FailFirst;
        public ConcurrentBag<string> Encoders = [];
    }
    sealed class FakeWorker(WorkState state) : IRenderWorker
    {
        public bool IsRunning => false;
        public IRenderWorker Fork() => new FakeWorker(state);
        public async Task<string> RenderAsync(RenderRequest request, Action<object> progress, CancellationToken token)
        {
            int active = Interlocked.Increment(ref state.Active), started = Interlocked.Increment(ref state.Started);
            while (true) { int peak = state.Peak; if (active <= peak || Interlocked.CompareExchange(ref state.Peak, active, peak) == peak) break; }
            var backend = request.Encoding!.Value.GetProperty("encoder").GetString()!; state.Encoders.Add(backend);
            try
            {
                if (state.FailGpu && backend == "nvenc") { Interlocked.Increment(ref state.GpuFailures); throw new IOException("模拟硬件编码失败"); }
                await Task.Delay(state.FailFirst && started == 1 ? 80 : 400, token);
                if (state.FailFirst && started == 1) throw new IOException("模拟生成失败");
                progress(new { @event = "progress", percent = 100 }); return "fixture-" + started + ".mp4";
            }
            finally { Interlocked.Decrement(ref state.Active); }
        }
    }
}
