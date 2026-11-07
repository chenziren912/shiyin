using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace VinylMV.Core;

public sealed record LibraryVideo(string Id, string Path, string Name, string[] Genres, double Duration, int Width, int Height)
{
    public bool Available => File.Exists(Path);
}
public sealed record BackgroundAssignment(string Id, LibraryVideo Video, bool Matched);

public static class MusicGenres
{
    private static readonly Dictionary<string, string> Aliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["pop"]="流行", ["rock"]="摇滚", ["jazz"]="爵士", ["classical"]="古典", ["classical music"]="古典",
        ["electronic"]="电子", ["electronica"]="电子", ["edm"]="电子", ["hip-hop"]="嘻哈", ["hip hop"]="嘻哈", ["rap"]="嘻哈",
        ["folk"]="民谣", ["country"]="乡村", ["blues"]="蓝调", ["r&b"]="节奏布鲁斯", ["rnb"]="节奏布鲁斯",
        ["ambient"]="氛围", ["instrumental"]="纯音乐", ["soundtrack"]="原声", ["metal"]="金属", ["dance"]="舞曲",
        ["(13)"]="流行", ["(17)"]="摇滚", ["(8)"]="爵士", ["(32)"]="古典", ["(52)"]="电子"
    };
    public static string[] Parse(string? value) => (value ?? "").Split([',','，',';','；','/','|','、'], StringSplitOptions.RemoveEmptyEntries)
        .Select(s => s.Trim()).Where(s => s.Length > 0).Select(s => Aliases.GetValueOrDefault(s, s.ToLowerInvariant()))
        .Select(s => s[..Math.Min(s.Length, 60)]).Distinct(StringComparer.OrdinalIgnoreCase).Take(20).ToArray();
    public static string[] Normalize(IEnumerable<string>? values) => Parse(string.Join(",", values ?? []));
    public static BackgroundAssignment Assign(string id, IEnumerable<string> genres, IReadOnlyList<LibraryVideo> library, Random? random = null)
    {
        var available = library.Where(v => v.Available).ToArray();
        if (available.Length == 0) throw new IOException("视频库中没有可用的视频，请先导入视频或修复文件路径。");
        var wanted = Normalize(genres).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var matching = available.Where(v => Normalize(v.Genres).Any(wanted.Contains)).ToArray();
        var pool = matching.Length > 0 ? matching : available;
        return new(id, pool[(random ?? Random.Shared).Next(pool.Length)], matching.Length > 0);
    }
}

public sealed class VideoLibrary(string path)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    public async Task<List<LibraryVideo>> LoadAsync(CancellationToken token)
    {
        await gate.WaitAsync(token);
        try { return await Read(token); }
        finally { gate.Release(); }
    }
    private async Task<List<LibraryVideo>> Read(CancellationToken token)
    {
        if (!File.Exists(path)) return [];
        try
        {
            var items = JsonSerializer.Deserialize<List<LibraryVideo>>(await File.ReadAllTextAsync(path, token), AppPaths.Json) ?? [];
            return items.Where(v => !string.IsNullOrWhiteSpace(v.Id) && !string.IsNullOrWhiteSpace(v.Path))
                .Select(v => v with { Genres = MusicGenres.Normalize(v.Genres) }).DistinctBy(v => v.Id).Take(5000).ToList();
        }
        catch (JsonException) { throw new IOException("视频库配置无法读取，请保留原配置并检查文件：" + path); }
    }
    public async Task<List<LibraryVideo>> UpdateAsync(Action<List<LibraryVideo>> update, CancellationToken token)
    {
        await gate.WaitAsync(token);
        string? temporary = null;
        try
        {
            var items = await Read(token); update(items);
            if (items.Count > 5000) throw new IOException("视频库最多保存 5000 个视频。");
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(path))!);
            temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(items, AppPaths.Json), token);
            token.ThrowIfCancellationRequested(); File.Move(temporary, path, true); temporary = null;
            return items;
        }
        finally { if (temporary != null) File.Delete(temporary); gate.Release(); }
    }
}

public static class OutputFormats
{
    public static readonly string[] Containers = ["mp4", "mkv", "mov", "webm"];
    public static string Validate(string value) => Containers.Contains(value) ? value : throw new IOException("不支持的导出文件格式。");
    public static string FileName(string value, string container)
    {
        Validate(container);
        var extension = System.IO.Path.GetExtension(value).TrimStart('.').ToLowerInvariant();
        return Containers.Contains(extension) ? System.IO.Path.ChangeExtension(value, container) : value + "." + container;
    }
    public static string BatchName(string pattern, int index, AudioInfo audio, string container)
    {
        if (pattern.Length is 0 or > 180) throw new IOException("命名模板应为 1–180 个字符。");
        var value = pattern.Replace("{序号}", index.ToString("D3")).Replace("{歌名}", audio.Title).Replace("{歌手}", audio.Artist)
            .Replace("{原文件名}", System.IO.Path.GetFileNameWithoutExtension(audio.Path)).Replace("{风格}", string.Join("-", MusicGenres.Parse(audio.Genre)));
        if (Regex.IsMatch(value, @"\{[^{}]*\}")) throw new IOException("命名模板包含不支持的占位符。");
        value = string.Concat(value.Select(c => System.IO.Path.GetInvalidFileNameChars().Contains(c) ? '_' : c)).Trim().TrimEnd('.', ' ');
        if (value.Length == 0) value = index.ToString("D3");
        if (Regex.IsMatch(value, @"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)", RegexOptions.IgnoreCase)) value = "_" + value;
        return FileName(value[..Math.Min(value.Length, 160)], container);
    }
}
