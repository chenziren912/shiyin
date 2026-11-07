using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Microsoft.Win32;
using VinylMV.Core;

namespace VinylMV;

public sealed class LayoutEditorWindow : Window
{
    private readonly WebView2 web = new();
    private readonly CancellationTokenSource lifetime = new();
    private CancellationTokenSource? sampleCancellation;
    public JsonElement? Result { get; private set; }

    public LayoutEditorWindow(JsonElement snapshot, CoreWebView2Environment environment,
        EventHandler<CoreWebView2WebResourceRequestedEventArgs> serveMedia, MediaService media, Func<string, string> register, SoftwareTheme theme)
    {
        Title = "更多设置 · 画面卡片";
        Width = 1640; Height = 1020; MinWidth = 1120; MinHeight = 720;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        if (Environment.GetEnvironmentVariable("VINYLMV_TEST_MODE") == "1") { WindowStartupLocation = WindowStartupLocation.Manual; Left = -20000; Top = -20000; ShowInTaskbar = false; }
        var background = (Color)ColorConverter.ConvertFromString(theme.Background);
        Background = new SolidColorBrush(background);
        web.DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, background.R, background.G, background.B);
        Content = web;
        Closed += (_, _) => { lifetime.Cancel(); sampleCancellation?.Cancel(); web.Dispose(); lifetime.Dispose(); };
        Loaded += async (_, _) =>
        {
            try
            {
                await web.EnsureCoreWebView2Async(environment);
                var core = web.CoreWebView2;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                core.Settings.AreDevToolsEnabled = Environment.GetEnvironmentVariable("VINYLMV_DEVTOOLS") == "1";
                core.SetVirtualHostNameToFolderMapping("app.vinyl.local", Path.Combine(AppContext.BaseDirectory, "Web"), CoreWebView2HostResourceAccessKind.DenyCors);
                core.AddWebResourceRequestedFilter("https://media.vinyl.local/*", CoreWebView2WebResourceContext.All);
                core.WebResourceRequested += serveMedia;
                core.NavigationStarting += (_, e) => { if (e.Uri != "https://app.vinyl.local/editor.html") e.Cancel = true; };
                core.NewWindowRequested += (_, e) => e.Handled = true;
                core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
                core.WebMessageReceived += async (_, e) =>
                {
                    if (e.Source != "https://app.vinyl.local/editor.html") return;
                    string? id = null;
                    try
                    {
                        using var message = JsonDocument.Parse(e.WebMessageAsJson);
                        id = message.RootElement.GetProperty("id").GetString();
                        var action = message.RootElement.GetProperty("action").GetString();
                        var payload = message.RootElement.GetProperty("payload");
                        object? result = null;
                        switch (action)
                        {
                            case "bootstrapEditor": result = snapshot; break;
                            case "sampleAudio":
                                sampleCancellation?.Cancel();
                                using (var current = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
                                {
                                    sampleCancellation = current;
                                    try
                                    {
                                        var audio = snapshot.GetProperty("audio");
                                        if (audio.ValueKind != JsonValueKind.Null)
                                            result = new { pcm = await media.ReadSpectrumSamplesAsync(audio.GetProperty("path").GetString()!, payload.GetProperty("seconds").GetDouble(), current.Token,
                                                payload.TryGetProperty("historySeconds", out var history) ? history.GetDouble() : .3) };
                                    }
                                    finally { if (sampleCancellation == current) sampleCancellation = null; }
                                }
                                break;
                            case "pickCover":
                                var picker = new OpenFileDialog { Title = "选择歌曲封面", Filter = "封面图片|*.png;*.jpg;*.jpeg;*.webp", CheckFileExists = true };
                                if (picker.ShowDialog(this) == true) result = new { path = picker.FileName, url = register(picker.FileName) };
                                break;
                            case "saveEditor": Result = payload.Clone(); _ = Dispatcher.BeginInvoke(new Action(() => DialogResult = true)); return;
                            case "closeEditor": _ = Dispatcher.BeginInvoke(new Action(Close)); return;
                            default: throw new IOException("不支持的编辑操作。");
                        }
                        Reply(new { id, ok = true, data = result });
                    }
                    catch (OperationCanceledException) { Reply(new { id, ok = false, error = "已跳过上一帧", cancelled = true }); }
                    catch (Exception error) { Reply(new { id, ok = false, error = "编辑操作未完成：" + error.Message }); }
                };
                core.Navigate("https://app.vinyl.local/editor.html");
            }
            catch (Exception error)
            {
                MessageBox.Show(this, "无法打开更多设置：" + error.Message, "拾音", MessageBoxButton.OK, MessageBoxImage.Error);
                Close();
            }
        };
    }

    private void Reply(object value)
    {
        if (!lifetime.IsCancellationRequested && web.CoreWebView2 != null)
            web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(value, AppPaths.Json));
    }
}
