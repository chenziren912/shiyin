using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using VinylMV.Core;

namespace VinylMV;

internal sealed class StartupView : Grid
{
    private readonly RotateTransform spin = new();
    private readonly List<Ellipse> dots = [];
    private static SolidColorBrush Brush(string value) => new((Color)ColorConverter.ConvertFromString(value));

    public StartupView(Action close, Action drag, SoftwareTheme theme)
    {
        string Tone(double amount) => SoftwareTheme.Mix(theme.Background, theme.Accent, amount);
        Background = Brush(theme.Background);
        MouseLeftButtonDown += (_, e) => { if (e.ChangedButton == MouseButton.Left) drag(); };
        var content = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 0, 20) };
        var record = new Grid { Width = 160, Height = 160, RenderTransform = spin, RenderTransformOrigin = new Point(.5, .5) };
        record.Children.Add(new Ellipse { Fill = new RadialGradientBrush(Brush(Tone(.16)).Color, Brush(Tone(.035)).Color), Stroke = Brush(Tone(.36)), StrokeThickness = 1 });
        for (int inset = 7; inset < 47; inset += 4)
            record.Children.Add(new Ellipse { Margin = new Thickness(inset), Stroke = Brush(Tone(.26)), StrokeThickness = .7, Opacity = .65 });
        var shine = Brush(theme.Accent).Color; shine.A = 34;
        record.Children.Add(new Ellipse { Fill = new LinearGradientBrush(shine, Colors.Transparent, 45), Margin = new Thickness(1) });
        record.Children.Add(new Ellipse { Width = 62, Height = 62, Fill = Brush(theme.Accent), Stroke = Brush(SoftwareTheme.Mix(theme.Accent, "#ffffff", .2)), StrokeThickness = 1 });
        record.Children.Add(new TextBlock { Text = "拾", FontFamily = new FontFamily("Microsoft YaHei"), FontSize = 19, Foreground = Brush("#18201b"), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 0, 6) });
        record.Children.Add(new Ellipse { Width = 7, Height = 7, Fill = Brush(theme.Background), Stroke = Brush(theme.Accent), StrokeThickness = 1, Margin = new Thickness(0, 31, 0, 0) });
        content.Children.Add(record);
        content.Children.Add(new TextBlock { Text = "拾 音", FontFamily = new FontFamily("Microsoft YaHei"), FontSize = 32, Foreground = Brush(SoftwareTheme.Mix("#f1f2f3", theme.Accent, .06)), HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 27, 0, 0) });
        content.Children.Add(new TextBlock { Text = "让音乐有画面", FontFamily = new FontFamily("Microsoft YaHei"), FontSize = 12, Foreground = Brush(Tone(.68)), HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 8, 0, 0) });
        var loading = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 27, 0, 0) };
        for (int index = 0; index < 3; index++)
        {
            var dot = new Ellipse { Width = 4, Height = 4, Fill = Brush(theme.Accent), Opacity = .3, Margin = new Thickness(4, 0, 4, 0) };
            dots.Add(dot); loading.Children.Add(dot);
        }
        content.Children.Add(loading);
        content.Children.Add(new TextBlock { Text = "正在打开创作工作台", FontFamily = new FontFamily("Microsoft YaHei"), FontSize = 10, Foreground = Brush(Tone(.6)), HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 14, 0, 0) });
        Children.Add(content);
        var exit = new Button { Content = "×", Width = 46, Height = 40, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, Background = Brushes.Transparent, BorderThickness = new Thickness(0), Foreground = Brush(Tone(.68)), FontSize = 20, Cursor = Cursors.Hand, ToolTip = "关闭" };
        System.Windows.Automation.AutomationProperties.SetName(exit, "关闭拾音");
        exit.Click += (_, _) => close(); Children.Add(exit);
        Loaded += (_, _) =>
        {
            if (!SystemParameters.ClientAreaAnimation) return;
            spin.BeginAnimation(RotateTransform.AngleProperty, new DoubleAnimation(0, 360, TimeSpan.FromSeconds(8)) { RepeatBehavior = RepeatBehavior.Forever });
            for (int index = 0; index < dots.Count; index++)
                dots[index].BeginAnimation(OpacityProperty, new DoubleAnimation(.2, .9, TimeSpan.FromSeconds(.65)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever, BeginTime = TimeSpan.FromSeconds(index * .18) });
        };
        Unloaded += (_, _) =>
        {
            spin.BeginAnimation(RotateTransform.AngleProperty, null);
            foreach (var dot in dots) dot.BeginAnimation(OpacityProperty, null);
        };
    }
}
