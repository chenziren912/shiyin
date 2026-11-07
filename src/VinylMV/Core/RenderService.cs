using System.Diagnostics;
using System.IO;
using System.Text.Json;

namespace VinylMV.Core;

public interface IRenderWorker
{
    bool IsRunning { get; }
    IRenderWorker Fork();
    Task<string> RenderAsync(RenderRequest request, Action<object> progress, CancellationToken token);
}

public sealed class RenderService(DependencyService dependencies) : IRenderWorker
{
    public bool IsRunning { get; private set; }
    public IRenderWorker Fork() => new RenderService(dependencies);

    public async Task<string> RenderAsync(RenderRequest request, Action<object> progress, CancellationToken token)
    {
        if (IsRunning) throw new InvalidOperationException("已有生成任务正在运行。");
        IsRunning = true;
        string? partial = null; string? job = null;
        try
        {
            var rendererSource = RendererBundle.Validate(AppContext.BaseDirectory);
            var deps = dependencies.Current ?? await dependencies.DetectAsync(token);
            if (!deps.Ready) throw new InvalidOperationException("请先完成依赖安装。");
            if (!File.Exists(request.AudioPath)) throw new IOException("找不到音频文件，请重新选择。");
            if (request.Volume is < 0 or > 1000 || request.Brightness is < 0 or > 100 || request.Duration <= 0 || request.Duration > 43200) throw new IOException("输出参数无效。");
            if (request.EmptyLyricsText?.Length > 300) throw new IOException("固定歌词文字不能超过 300 个字符。");
            var name = request.FileName.Trim();
            if (name.Length == 0 || name.Length > 180 || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || name.EndsWith('.') || name.EndsWith(' ')) throw new IOException("请输入有效的文件名，不能包含路径或特殊字符。");
            var container = OutputFormats.Validate(request.Container);
            name = OutputFormats.FileName(name, container);
            var directory = Path.GetFullPath(request.OutputDirectory);
            Directory.CreateDirectory(directory);
            string target = Path.Combine(directory, name);
            int suffix = 2;
            while (File.Exists(target)) target = Path.Combine(directory, Path.GetFileNameWithoutExtension(name) + $" ({suffix++})." + container);
            partial = Path.Combine(directory, ".vinyl-" + Guid.NewGuid().ToString("N") + "." + container);
            job = Path.Combine(AppPaths.Jobs, Guid.NewGuid().ToString("N")); Directory.CreateDirectory(job);
            var renderer = RendererBundle.Snapshot(rendererSource, job);
            var config = Path.Combine(job, "config.json");
            var payload = new
            {
                request.AudioPath, request.BackgroundPath, request.CoverPath, request.Title, request.Artist, request.Lyrics,
                request.Duration, request.Volume, request.Brightness, request.FontSize, request.Width, request.Height, request.Fps,
                request.Offset, request.ShowSpectrum, request.Layout, request.Encoding, request.Container, request.EmptyLyricsText, OutputPath = partial
            };
            await File.WriteAllTextAsync(config, JsonSerializer.Serialize(payload, AppPaths.Json), token);
            using var process = new Process { StartInfo = ProcessRunner.StartInfo(deps.Python.Path!, ["-B", "-u", renderer, "--config", config, "--ffmpeg", deps.Ffmpeg.Path!]) };
            process.Start();
            using var registration = token.Register(() => { try { process.Kill(true); } catch (InvalidOperationException) { } });
            var errorTask = process.StandardError.ReadToEndAsync();
            string? lastError = null;
            try
            {
                while (await process.StandardOutput.ReadLineAsync(token) is { } line)
                {
                    try
                    {
                        using var record = JsonDocument.Parse(line);
                        if (record.RootElement.TryGetProperty("event", out var e) && e.GetString() == "error") lastError = record.RootElement.GetProperty("message").GetString();
                        progress(record.RootElement.Clone());
                    }
                    catch (JsonException) { }
                }
                await process.WaitForExitAsync(token);
            }
            catch (OperationCanceledException)
            {
                try { process.Kill(true); } catch (InvalidOperationException) { }
                await process.WaitForExitAsync(CancellationToken.None);
                throw;
            }
            string errors = await errorTask;
            token.ThrowIfCancellationRequested();
            if (process.ExitCode != 0) throw new IOException(lastError ?? ("渲染失败：" + errors[^Math.Min(2000, errors.Length)..]));
            if (!File.Exists(partial) || new FileInfo(partial).Length == 0) throw new IOException("输出视频为空。");
            // Atomic moves arbitrate concurrent jobs with the same name; never overwrite a finished file.
            while (true)
            {
                try { File.Move(partial, target); break; }
                catch (IOException) when (File.Exists(target)) { target = Path.Combine(directory, Path.GetFileNameWithoutExtension(name) + $" ({suffix++})." + container); }
            }
            partial = null;
            return target;
        }
        finally
        {
            IsRunning = false;
            if (partial != null)
                for (int attempt = 0; attempt < 3; attempt++)
                {
                    try { File.Delete(partial); break; }
                    catch (IOException) { if (attempt < 2) await Task.Delay(100); }
                }
            // Keep failed job logs for diagnosis; successful jobs are safe to remove.
            if (partial == null && job != null && Directory.Exists(job)) Directory.Delete(job, true);
        }
    }
}
