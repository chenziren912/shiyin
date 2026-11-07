using System.IO;

namespace VinylMV.Core;

public static class MediaFormats
{
    public const string AudioFilter = "音乐文件|*.mp3;*.wav;*.flac;*.m4a;*.aac;*.ogg;*.opus;*.wma;*.aif;*.aiff;*.ape;*.wv;*.alac;*.ac3;*.dts;*.mka;*.mp2|所有文件|*.*";
    public const string VideoFilter = "背景视频|*.mp4;*.mkv;*.webm;*.mov;*.avi;*.m4v;*.wmv;*.flv;*.ts;*.mts;*.m2ts;*.mpg;*.mpeg;*.vob;*.ogv;*.3gp;*.3g2;*.mxf|所有文件|*.*";
    private static readonly HashSet<string> AudioExtensions = new(".mp3 .wav .flac .m4a .aac .ogg .opus .wma .aif .aiff .ape .wv .alac .ac3 .dts .mka .mp2".Split(' '), StringComparer.OrdinalIgnoreCase);
    public static bool IsAudioPath(string path) => AudioExtensions.Contains(Path.GetExtension(path));
    public static string Label(string path) => Path.GetExtension(path).TrimStart('.').ToUpperInvariant();
    public static string ContentType(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".mp3" or ".mp2" => "audio/mpeg", ".wav" => "audio/wav", ".flac" => "audio/flac",
        ".m4a" or ".alac" => "audio/mp4", ".aac" => "audio/aac", ".ogg" or ".opus" => "audio/ogg",
        ".wma" => "audio/x-ms-wma", ".aif" or ".aiff" => "audio/aiff", ".ac3" => "audio/ac3",
        ".mka" => "audio/x-matroska", ".mp4" or ".m4v" => "video/mp4", ".webm" => "video/webm",
        ".mov" => "video/quicktime", ".mkv" => "video/x-matroska", ".avi" => "video/x-msvideo",
        ".wmv" => "video/x-ms-wmv", ".flv" => "video/x-flv", ".ts" or ".mts" or ".m2ts" => "video/mp2t",
        ".mpg" or ".mpeg" or ".vob" => "video/mpeg", ".ogv" => "video/ogg", ".3gp" => "video/3gpp",
        ".3g2" => "video/3gpp2", ".mxf" => "application/mxf", ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg", ".webp" => "image/webp", _ => "application/octet-stream"
    };
}
