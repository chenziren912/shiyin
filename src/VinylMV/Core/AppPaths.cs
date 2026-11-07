using System.IO;
using System.Text.Json;

namespace VinylMV.Core;

public static class AppPaths
{
    public static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VinylMV");
    public static readonly string Tools = Path.Combine(Root, "tools");
    public static readonly string Downloads = Path.Combine(Root, "downloads");
    public static readonly string Cache = Path.Combine(Root, "cache");
    public static readonly string Jobs = Path.Combine(Root, "jobs");
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = false };
    public static string DefaultOutput => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyVideos), "拾音");

    public static void Initialize()
    {
        foreach (var path in new[] { Root, Tools, Downloads, Cache, Jobs }) Directory.CreateDirectory(path);
    }
}

public sealed record Dependency(string Name, bool Ready, string? Path, string Version, string Detail);
public sealed record Dependencies(Dependency Ffmpeg, Dependency Python)
{
    public bool Ready => Ffmpeg.Ready && Python.Ready;
}
public sealed record LyricLine(double Time, string Text);
public sealed record AudioInfo(string Path, string Url, string Title, string Artist, string Album, double Duration, string? CoverPath, string? CoverUrl, string? LocalLyrics, string Format = "", bool PreviewConverted = false, string Genre = "");
public sealed record VideoInfo(string Path, string Url, string Name, double Duration, int Width, int Height, string Format = "", bool PreviewConverted = false);
public sealed record DownloadProgress(string Name, long Received, long Total, double BytesPerSecond, int Threads, int StagnantAdditions, string Status);
public sealed record RenderRequest(string AudioPath, string? BackgroundPath, string? CoverPath, string Title, string Artist, string Lyrics, double Duration, double Volume, double Brightness, int FontSize, int Width, int Height, int Fps, string OutputDirectory, string FileName, double Offset = 0, bool ShowSpectrum = true, JsonElement? Layout = null, JsonElement? Encoding = null, string Container = "mp4", string? EmptyLyricsText = null);
