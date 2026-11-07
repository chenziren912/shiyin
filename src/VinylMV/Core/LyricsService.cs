using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace VinylMV.Core;

public sealed record LyricsCandidate(long Id, string Title, string Artist, string Album, double Duration, string? SyncedLyrics, string? PlainLyrics, bool Instrumental, double Score);

public sealed class LyricsService : IDisposable
{
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(20) };
    private readonly SemaphoreSlim gate = new(1, 1);
    private DateTimeOffset nextRequest;

    public LyricsService()
    {
        // This documentation link is intentional until the project has its own public repository.
        http.DefaultRequestHeaders.UserAgent.ParseAdd("VinylMV/0.1 (+https://lrclib.net/docs; personal-open-source-desktop-client)");
    }

    public async Task<IReadOnlyList<LyricsCandidate>> SearchAsync(string title, string artist, string album, double duration, string? query, CancellationToken token)
    {
        title = title.Trim(); artist = artist.Trim();
        if (string.IsNullOrWhiteSpace(query) && title.Length == 0) throw new InvalidOperationException("请输入歌名或歌手。");
        await gate.WaitAsync(token);
        try
        {
            var signature = $"{title}|{artist}|{album}|{duration:0.0}|{query}";
            var cache = Path.Combine(AppPaths.Cache, "lyrics-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(signature))) + ".json");
            if (File.Exists(cache) && File.GetLastWriteTimeUtc(cache) > DateTime.UtcNow.AddDays(-1))
            {
                try { return JsonSerializer.Deserialize<List<LyricsCandidate>>(await File.ReadAllTextAsync(cache, token), AppPaths.Json) ?? []; }
                catch (JsonException) { File.Delete(cache); }
            }
            var results = new List<LyricsCandidate>();
            if (string.IsNullOrWhiteSpace(query) && artist.Length > 0 && duration > 0)
            {
                string exact = "https://lrclib.net/api/get?track_name=" + Uri.EscapeDataString(title) + "&artist_name=" + Uri.EscapeDataString(artist) + "&album_name=" + Uri.EscapeDataString(album) + "&duration=" + Math.Round(duration).ToString(System.Globalization.CultureInfo.InvariantCulture);
                var record = await Request(exact, token);
                if (record != null) { using (record) results.Add(Parse(record.RootElement, title, artist, duration)); }
            }
            // An exact timed match avoids another network request.
            if (!results.Any(r => !string.IsNullOrWhiteSpace(r.SyncedLyrics)))
            {
                var url = "https://lrclib.net/api/search?" + (!string.IsNullOrWhiteSpace(query)
                    ? "q=" + Uri.EscapeDataString(query.Trim())
                    : "track_name=" + Uri.EscapeDataString(title) + (artist.Length > 0 ? "&artist_name=" + Uri.EscapeDataString(artist) : ""));
                using var search = await Request(url, token);
                if (search?.RootElement.ValueKind == JsonValueKind.Array)
                    foreach (var item in search.RootElement.EnumerateArray()) results.Add(Parse(item, title, artist, duration));
            }
            var ranked = results.DistinctBy(r => r.Id).OrderByDescending(r => r.Score).ToArray();
            await File.WriteAllTextAsync(cache, JsonSerializer.Serialize(ranked, AppPaths.Json), token);
            return ranked;
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { throw new IOException("歌词服务连接超时，请稍后重试，或导入本地 LRC。"); }
        finally { gate.Release(); }
    }

    private async Task<JsonDocument?> Request(string url, CancellationToken token)
    {
        var delay = nextRequest - DateTimeOffset.UtcNow;
        if (delay > TimeSpan.Zero) await Task.Delay(delay, token);
        using var response = await http.GetAsync(url, token);
        nextRequest = DateTimeOffset.UtcNow.AddMilliseconds(350);
        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        if (response.StatusCode == HttpStatusCode.TooManyRequests)
        {
            var retry = response.Headers.RetryAfter?.Delta ?? (response.Headers.RetryAfter?.Date - DateTimeOffset.UtcNow) ?? TimeSpan.FromSeconds(60);
            nextRequest = DateTimeOffset.UtcNow + (retry > TimeSpan.Zero ? retry : TimeSpan.FromSeconds(60));
            throw new IOException($"歌词服务请求较多，请在 {Math.Ceiling((nextRequest - DateTimeOffset.UtcNow).TotalSeconds)} 秒后重试，也可以导入本地歌词。");
        }
        response.EnsureSuccessStatusCode();
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
    }

    private static LyricsCandidate Parse(JsonElement item, string title, string artist, double duration)
    {
        string? Text(string key) => item.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        string track = Text("trackName") ?? "", performer = Text("artistName") ?? "";
        double seconds = item.TryGetProperty("duration", out var d) && d.ValueKind == JsonValueKind.Number ? d.GetDouble() : 0;
        string? synced = Text("syncedLyrics");
        double score = (!string.IsNullOrWhiteSpace(synced) ? 20 : 0) + (track.Equals(title, StringComparison.OrdinalIgnoreCase) ? 45 : 0)
            + (artist.Length > 0 && performer.Equals(artist, StringComparison.OrdinalIgnoreCase) ? 25 : 0)
            + (duration > 0 && Math.Abs(seconds - duration) < 4 ? 10 : 0);
        return new(item.GetProperty("id").GetInt64(), track, performer, Text("albumName") ?? "", seconds, synced, Text("plainLyrics"), item.TryGetProperty("instrumental", out var i) && i.ValueKind == JsonValueKind.True, score);
    }

    public void Dispose() { http.Dispose(); gate.Dispose(); }
}
