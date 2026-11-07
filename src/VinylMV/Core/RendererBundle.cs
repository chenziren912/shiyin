using System.IO;

namespace VinylMV.Core;

public static class RendererBundle
{
    private static readonly string[] Required = ["render.py", "spectrum.py", "lyric_layout.py", "composition.py", "encoding_settings.py"];

    public static string Validate(string applicationDirectory)
    {
        var directory = Path.Combine(applicationDirectory, "Renderer");
        var missing = Required.Where(name => !File.Exists(Path.Combine(directory, name)) || new FileInfo(Path.Combine(directory, name)).Length == 0).ToArray();
        if (missing.Length > 0)
            throw new IOException("渲染组件不完整（缺少 " + string.Join("、", missing) + "）。请运行新版拾音安装程序，安装到当前程序所在目录以修复。当前目录：" + applicationDirectory);
        return directory;
    }

    public static string Snapshot(string sourceDirectory, string jobDirectory)
    {
        var snapshot = Path.Combine(jobDirectory, "Renderer");
        Directory.CreateDirectory(snapshot);
        try
        {
            foreach (var name in Required) File.Copy(Path.Combine(sourceDirectory, name), Path.Combine(snapshot, name));
        }
        catch (IOException error)
        {
            throw new IOException("无法准备渲染组件，请使用新版安装程序修复安装。", error);
        }
        return Path.Combine(snapshot, "render.py");
    }
}
