# 第三方组件

拾音应用源码使用 MIT 许可，各依赖组件保留其自身许可。应用通过独立进程调用 FFmpeg 和 Python。

| 组件 | 使用方式 | 许可及来源 |
| --- | --- | --- |
| Microsoft.Web.WebView2 | NuGet SDK；使用系统 WebView2 运行时 | [Microsoft 许可](https://www.nuget.org/packages/Microsoft.Web.WebView2)；[运行时分发文档](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) |
| .NET | 复用本机桌面运行时，缺失时从微软下载到应用的 runtime 目录 | [MIT 许可及源码](https://github.com/dotnet/runtime)；[WPF 源码](https://github.com/dotnet/wpf) |
| Python | 检测本地版本，缺失时从 python.org 下载签名的 Windows 安装包 | [PSF 许可](https://docs.python.org/3/license.html)；[源码](https://github.com/python/cpython) |
| FFmpeg | 检测本机；缺失时从 gyan.dev 下载最新正式版 essentials 构建，不打入安装包 | gyan 构建为 GPLv3；[构建及对应源码链接](https://www.gyan.dev/ffmpeg/builds/)；[FFmpeg 许可](https://ffmpeg.org/legal.html)；[源码](https://git.ffmpeg.org/ffmpeg.git) |
| LRCLIB | 无需密钥的公开歌词查询服务，仅发送歌曲标签和关键词 | [服务文档](https://lrclib.net/docs)；歌词及用户素材的权利归各权利人所有 |
| Inno Setup | 仅开发时使用，构建中文 EXE 安装程序 | [许可及源码](https://github.com/jrsoftware/issrc)；简体中文翻译来自该仓库 |

运行时下载的 FFmpeg 压缩包保留原有许可及说明文件。Microsoft WebView2 引导程序保留微软数字签名；Python 安装包执行前验证 Python Software Foundation 数字签名；FFmpeg 下载后核对发布站点的 SHA-256。
