using System.IO;
using System.Text.Json;

namespace VinylMV.Core;

public sealed record SoftwareTheme(string Id, string Accent)
{
    public string Background => Id == "moss" ? "#111412" : Mix("#101214", Accent, .035);
    public static string Mix(string first, string second, double amount) => "#" + string.Concat(new[] { 1, 3, 5 }.Select(index =>
        ((int)Math.Round(Convert.ToInt32(first.Substring(index, 2), 16) * (1 - amount) + Convert.ToInt32(second.Substring(index, 2), 16) * amount, MidpointRounding.AwayFromZero)).ToString("x2")));
    public static readonly SoftwareTheme[] Catalog = [new("moss", "#c2dfa2"), new("teal", "#88d6c6"), new("blue", "#9cc8ff"),
        new("indigo", "#b4b8ff"), new("purple", "#ceb0f4"), new("pink", "#f2b4d1"), new("amber", "#f0ce83"),
        new("orange", "#f0b08e"), new("red", "#f0a2a4"), new("slate", "#c4ccd6")];
    public static SoftwareTheme Find(string? id) => Catalog.FirstOrDefault(theme => theme.Id == id) ?? Catalog[0];
}

public sealed class SoftwareThemeService
{
    private readonly string path;
    public SoftwareTheme Current { get; private set; } = SoftwareTheme.Catalog[0];
    public SoftwareThemeService(string path)
    {
        this.path = path;
        try { if (File.Exists(path)) Current = SoftwareTheme.Find(JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(path))?.GetValueOrDefault("theme")); }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException) { }
    }
    public async Task SaveAsync(string id, CancellationToken token)
    {
        var theme = SoftwareTheme.Catalog.FirstOrDefault(theme => theme.Id == id) ?? throw new IOException("软件主题选项无效。");
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(new { theme = id }, AppPaths.Json), token);
            File.Move(temporary, path, true); Current = theme;
        }
        finally { File.Delete(temporary); }
    }
}
