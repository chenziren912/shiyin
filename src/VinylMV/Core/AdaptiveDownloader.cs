using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using Microsoft.Win32.SafeHandles;

namespace VinylMV.Core;

// Each worker owns disjoint byte ranges. A final file only appears after every range succeeds.
public sealed class AdaptiveDownloader : IDisposable
{
    private readonly HttpClient http;
    public const double TargetSpeed = 5_000_000;
    public const double MeaningfulGain = 200_000;
    public const int MaximumStagnantAdditions = 10;
    public const int MaximumThreads = 32;
    private long received, transferred;

    public AdaptiveDownloader()
    {
        http = new HttpClient(new SocketsHttpHandler
        {
            AutomaticDecompression = DecompressionMethods.None, MaxConnectionsPerServer = MaximumThreads + 2,
            ConnectTimeout = TimeSpan.FromSeconds(20), PooledConnectionLifetime = TimeSpan.FromMinutes(5)
        }) { Timeout = Timeout.InfiniteTimeSpan };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("VinylMV/0.1");
        http.DefaultRequestHeaders.AcceptEncoding.ParseAdd("identity");
    }

    public async Task DownloadAsync(Uri source, string destination, string name, IProgress<DownloadProgress>? progress, CancellationToken cancellationToken)
    {
        if (source.Scheme != "https" && !source.IsLoopback) throw new InvalidOperationException("下载地址必须使用 HTTPS。");
        received = transferred = 0;
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(destination))!);
        var partial = destination + "." + Guid.NewGuid().ToString("N") + ".part";
        try
        {
            using var probeRequest = new HttpRequestMessage(HttpMethod.Get, source);
            probeRequest.Headers.Range = new RangeHeaderValue(0, 0);
            using var probeTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            probeTimeout.CancelAfter(TimeSpan.FromSeconds(30));
            using var probe = await http.SendAsync(probeRequest, HttpCompletionOption.ResponseHeadersRead, probeTimeout.Token);
            probe.EnsureSuccessStatusCode();
            var range = probe.Content.Headers.ContentRange;
            var ranged = probe.StatusCode == HttpStatusCode.PartialContent && range?.From == 0 && range.To == 0 && range.Length > 0;
            var total = ranged ? range!.Length!.Value : probe.Content.Headers.ContentLength ?? 0;
            var etag = probe.Headers.ETag is { IsWeak: false } tag ? tag : null;
            var modified = probe.Content.Headers.LastModified;
            // Release the probe connection before starting the actual transfer.
            probe.Dispose();
            if (ranged) await DownloadRanges(source, partial, name, total, etag, modified, progress, cancellationToken);
            else await DownloadSequential(source, partial, name, progress, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            File.Move(partial, destination, true);
            progress?.Report(new(name, received, received, 0, 0, 0, "下载完成，正在校验"));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { throw new IOException("连接下载源超时，请检查网络后重试。"); }
        finally { if (File.Exists(partial)) File.Delete(partial); }
    }

    private async Task DownloadRanges(Uri source, string path, string name, long total, EntityTagHeaderValue? etag, DateTimeOffset? modified, IProgress<DownloadProgress>? progress, CancellationToken token)
    {
        const long chunkSize = 1024 * 1024;
        var queue = new ConcurrentQueue<(long Start, long End)>();
        for (long start = 0; start < total; start += chunkSize) queue.Enqueue((start, Math.Min(total - 1, start + chunkSize - 1)));
        using var file = File.OpenHandle(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, FileOptions.Asynchronous | FileOptions.RandomAccess);
        RandomAccess.SetLength(file, total);
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(token);
        var workers = new List<Task>();
        var failures = new ConcurrentQueue<Exception>();
        int live = 0;
        var policy = new DownloadThreadPolicy();

        async Task Worker()
        {
            Interlocked.Increment(ref live);
            try
            {
                while (queue.TryDequeue(out var chunk))
                {
                    for (var attempt = 0; ; attempt++)
                    {
                        long written = 0;
                        try
                        {
                            using var request = new HttpRequestMessage(HttpMethod.Get, source);
                            request.Headers.Range = new RangeHeaderValue(chunk.Start, chunk.End);
                            if (etag != null) request.Headers.IfRange = new RangeConditionHeaderValue(etag);
                            else if (modified != null) request.Headers.IfRange = new RangeConditionHeaderValue(modified.Value);
                            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(stop.Token);
                            deadline.CancelAfter(TimeSpan.FromSeconds(90));
                            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
                            var contentRange = response.Content.Headers.ContentRange;
                            if (response.StatusCode != HttpStatusCode.PartialContent || contentRange?.From != chunk.Start || contentRange.To != chunk.End || contentRange.Length != total)
                                throw new IOException("服务器返回的分段范围不一致，已停止以避免文件损坏。");
                            if (etag != null && response.Headers.ETag is { } actualTag && !etag.Equals(actualTag)) throw new IOException("下载期间远程文件已更新，请重试。");
                            await using var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
                            var buffer = new byte[64 * 1024];
                            var expected = chunk.End - chunk.Start + 1;
                            while (written < expected)
                            {
                                int count = await stream.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, expected - written)), deadline.Token);
                                if (count == 0) throw new EndOfStreamException("下载分段提前结束。");
                                await RandomAccess.WriteAsync(file, buffer.AsMemory(0, count), chunk.Start + written, deadline.Token);
                                written += count;
                                Interlocked.Add(ref received, count);
                                Interlocked.Add(ref transferred, count);
                            }
                            break;
                        }
                        catch (Exception ex) when (ex is HttpRequestException or IOException or OperationCanceledException)
                        {
                            Interlocked.Add(ref received, -written);
                            stop.Token.ThrowIfCancellationRequested();
                            if (attempt >= 2) throw;
                            await Task.Delay(500 * (attempt + 1), stop.Token);
                        }
                    }
                }
            }
            catch (Exception ex) { failures.Enqueue(ex); stop.Cancel(); }
            finally { Interlocked.Decrement(ref live); }
        }

        void AddWorker() => workers.Add(Worker());
        for (int i = 0; i < Math.Min(4, (int)Math.Ceiling(total / (double)chunkSize)); i++) AddWorker();
        var watch = Stopwatch.StartNew();
        long lastTransferred = 0;
        double lastSample = 0, lastDecision = 0;
        double windowBytes = 0, windowSeconds = 0;
        while (workers.Any(t => !t.IsCompleted))
        {
            await Task.WhenAny(Task.WhenAll(workers.ToArray()), Task.Delay(500, token));
            token.ThrowIfCancellationRequested();
            double now = watch.Elapsed.TotalSeconds;
            long current = Interlocked.Read(ref transferred);
            double elapsed = Math.Max(.001, now - lastSample);
            double speed = (current - lastTransferred) / elapsed;
            windowBytes += current - lastTransferred;
            windowSeconds += elapsed;
            lastTransferred = current; lastSample = now;
            if (now - lastDecision >= 3 && !queue.IsEmpty && !stop.IsCancellationRequested)
            {
                double average = windowBytes / Math.Max(.001, windowSeconds);
                if (policy.ShouldAdd(average, Volatile.Read(ref live))) AddWorker();
                windowBytes = windowSeconds = 0; lastDecision = now;
            }
            progress?.Report(new(name, Interlocked.Read(ref received), total, speed, Volatile.Read(ref live), policy.StagnantAdditions,
                policy.Frozen ? "连续 10 次增速不足，保持当前线程" : "多线程下载中"));
        }
        await Task.WhenAll(workers);
        token.ThrowIfCancellationRequested();
        if (failures.TryDequeue(out var failure)) throw new IOException("下载失败，可重新尝试。" + failure.Message, failure);
        if (received != total) throw new IOException("下载文件长度不正确。");
        RandomAccess.FlushToDisk(file);
    }

    private async Task DownloadSequential(Uri source, string path, string name, IProgress<DownloadProgress>? progress, CancellationToken token)
    {
        using var headerDeadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        headerDeadline.CancelAfter(TimeSpan.FromSeconds(30));
        using var response = await http.GetAsync(source, HttpCompletionOption.ResponseHeadersRead, headerDeadline.Token);
        response.EnsureSuccessStatusCode();
        headerDeadline.CancelAfter(Timeout.InfiniteTimeSpan);
        var total = response.Content.Headers.ContentLength ?? 0;
        await using var input = await response.Content.ReadAsStreamAsync(token);
        await using var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true);
        var buffer = new byte[65536]; var watch = Stopwatch.StartNew(); double lastTime = 0; long lastBytes = 0;
        while (true)
        {
            using var readTimeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            readTimeout.CancelAfter(TimeSpan.FromSeconds(90));
            int count = await input.ReadAsync(buffer, readTimeout.Token);
            if (count == 0) break;
            await output.WriteAsync(buffer.AsMemory(0, count), token); received += count;
            double now = watch.Elapsed.TotalSeconds;
            if (now - lastTime >= .5)
            {
                progress?.Report(new(name, received, total, (received - lastBytes) / Math.Max(.001, now - lastTime), 1, 0, "服务器不支持分段，使用单线程下载"));
                lastTime = now; lastBytes = received;
            }
        }
        if (total > 0 && received != total) throw new IOException("下载文件长度不正确。");
        await output.FlushAsync(token);
    }

    public void Dispose() => http.Dispose();
}
