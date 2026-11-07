using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace VinylMV.Core;

public sealed class AiVideoHttp : IDisposable
{
    private readonly AiVideoSettings settings;
    private readonly HttpClient http;
    public AiVideoHttp(AiVideoSettings settings)
    {
        this.settings = settings;
        http = new(new SocketsHttpHandler { AllowAutoRedirect = false, PooledConnectionLifetime = TimeSpan.FromMinutes(5) }) { Timeout = Timeout.InfiniteTimeSpan };
    }
    public static Uri BaseUri(string url)
    {
        if (!Uri.TryCreate(url.Trim().TrimEnd('/') + "/", UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0)
            throw new IOException("API 地址应为 HTTP / HTTPS 根地址，不能包含账号、查询参数或片段。");
        return uri;
    }
    public static Uri Endpoint(string baseUrl, string path, string? id = null)
    {
        path = path.Replace("{id}", Uri.EscapeDataString(id ?? ""));
        // A leading slash is relative to the host; other paths preserve the configured /v1/ prefix.
        var uri = new Uri(BaseUri(baseUrl), path);
        if (uri.Scheme is not ("http" or "https") || uri.UserInfo.Length > 0) throw new IOException("AI 接口或下载地址仅支持 HTTP / HTTPS。");
        return uri;
    }
    private static bool SameOrigin(Uri first, Uri second) => first.Scheme == second.Scheme && first.IdnHost.Equals(second.IdnHost, StringComparison.OrdinalIgnoreCase) && first.Port == second.Port;
    private async Task<HttpResponseMessage> Send(HttpMethod method, Uri uri, Func<HttpContent>? content, bool authenticate, CancellationToken token)
    {
        bool safe = method == HttpMethod.Get;
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                Uri target = uri;
                for (int redirect = 0; ; redirect++)
                {
                    using var message = new HttpRequestMessage(method, target);
                    if (content != null) message.Content = content();
                    if (authenticate && SameOrigin(BaseUri(settings.BaseUrl), target))
                    {
                        if (settings.AuthHeader.Length > 0 && settings.ApiKey.Length > 0) message.Headers.TryAddWithoutValidation(settings.AuthHeader, settings.AuthPrefix + settings.ApiKey);
                        foreach (var header in (JsonObject)JsonNode.Parse(settings.HeadersJson)!)
                            message.Headers.TryAddWithoutValidation(header.Key, header.Value!.GetValue<string>().Replace("{apiKey}", settings.ApiKey));
                    }
                    var response = await http.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, token);
                    if ((int)response.StatusCode is >= 300 and < 400 && response.Headers.Location != null)
                    {
                        var location = new Uri(target, response.Headers.Location); response.Dispose();
                        if (!safe || redirect >= 4 || location.Scheme is not ("http" or "https") || location.UserInfo.Length > 0 || target.Scheme == "https" && location.Scheme != "https") throw new IOException("AI 接口重定向无效，请填写最终接口地址。");
                        target = location; continue;
                    }
                    if (response.IsSuccessStatusCode) return response;
                    int status = (int)response.StatusCode;
                    var retryAfter = response.Headers.RetryAfter?.Delta?.TotalSeconds ?? 0;
                    response.Dispose();
                    if (safe && attempt < settings.ReadRetries && (status == 429 || status >= 500))
                    { await Task.Delay(TimeSpan.FromSeconds(Math.Clamp(retryAfter > 0 ? retryAfter : Math.Pow(2, attempt), 1, 60)), token); break; }
                    throw new IOException($"AI 接口请求失败（HTTP {status}）。请检查服务地址、密钥、模型权限和额度。");
                }
            }
            catch (HttpRequestException) when (safe && attempt < settings.ReadRetries) { await Task.Delay(TimeSpan.FromSeconds(Math.Min(8, Math.Pow(2, attempt))), token); }
            catch (HttpRequestException) { throw new IOException(safe ? "AI 接口网络连接失败。" : "AI 创建请求连接中断，服务端可能已受理；请核对服务商任务记录后再重试。"); }
        }
    }
    public async Task<JsonNode> JsonAsync(HttpMethod method, Uri url, Func<HttpContent>? content, CancellationToken token)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token); timeout.CancelAfter(TimeSpan.FromSeconds(settings.HttpTimeoutSeconds));
        try
        {
            using var response = await Send(method, url, content, true, timeout.Token);
            await using var input = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var bytes = new MemoryStream(); byte[] buffer = new byte[32768]; int count;
            while ((count = await input.ReadAsync(buffer, timeout.Token)) > 0)
            { if (bytes.Length + count > 2_000_000) throw new IOException("AI 接口返回的 JSON 过大。"); await bytes.WriteAsync(buffer.AsMemory(0, count), timeout.Token); }
            try { return JsonNode.Parse(bytes.ToArray()) ?? throw new IOException("AI 接口未返回有效 JSON。"); }
            catch (System.Text.Json.JsonException) { throw new IOException("AI 接口返回的内容不是有效 JSON，请检查接口协议与路径。"); }
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { throw new IOException("AI 接口请求超时，请检查网络或增加单次请求等待时间。"); }
    }
    public async Task DownloadAsync(Uri url, string target, Action<double?> progress, CancellationToken token)
    {
        using var headerTimeout = CancellationTokenSource.CreateLinkedTokenSource(token); headerTimeout.CancelAfter(TimeSpan.FromSeconds(settings.HttpTimeoutSeconds));
        using var response = await Send(HttpMethod.Get, url, null, true, headerTimeout.Token);
        var type = response.Content.Headers.ContentType?.MediaType ?? "";
        if (type.Contains("json") || type.Contains("text") || type.Contains("html")) throw new IOException("AI 下载地址返回了文本而不是视频，请检查结果 URL 映射。");
        long limit = settings.DownloadLimitMb * 1_000_000L;
        long? total = response.Content.Headers.ContentLength;
        if (total > limit) throw new IOException("AI 背景视频超过设置的下载大小上限。");
        await using var input = await response.Content.ReadAsStreamAsync(token);
        await using var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true);
        byte[] buffer = new byte[65536]; long received = 0; int count; var reported = DateTimeOffset.MinValue;
        while ((count = await input.ReadAsync(buffer, token)) > 0)
        {
            received += count; if (received > limit) throw new IOException("AI 背景视频超过设置的下载大小上限。");
            await output.WriteAsync(buffer.AsMemory(0, count), token);
            if ((DateTimeOffset.UtcNow - reported).TotalMilliseconds >= 200) { progress(total > 0 ? received * 100d / total.Value : null); reported = DateTimeOffset.UtcNow; }
        }
        if (received < 32 || total.HasValue && received != total) throw new IOException("AI 背景视频下载不完整。");
        await output.FlushAsync(token); progress(100);
    }
    public async Task<string[]> ModelsAsync(CancellationToken token)
    {
        if (string.IsNullOrWhiteSpace(settings.ModelsPath)) throw new IOException("此服务未设置模型列表路径，请手动填写模型。");
        var result = await JsonAsync(HttpMethod.Get, Endpoint(settings.BaseUrl, settings.ModelsPath), null, token);
        var array = result is JsonObject owner ? owner["data"] as JsonArray ?? owner["models"] as JsonArray : result as JsonArray;
        if (array == null) throw new IOException("接口未返回模型列表，请手动填写模型。");
        return array.Select(item => item is JsonObject ? Text(item["id"]) : Text(item)).Where(id => id.Length > 0 && id.Length <= 150).Distinct().Take(1000).ToArray();
    }
    public static string Text(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : node is JsonValue ? node.ToJsonString() : "";
    public static JsonNode? ReadPath(JsonNode root, string alternatives)
    {
        foreach (var alternative in alternatives.Split('|', StringSplitOptions.RemoveEmptyEntries))
        {
            var path = alternative.Trim(); bool pointer = path.StartsWith('/');
            var segments = pointer ? path[1..].Split('/').Select(p => p.Replace("~1", "/").Replace("~0", "~")) : Regex.Replace(path.TrimStart('$', '.'), @"\[(\d+)\]", ".$1").Split('.', StringSplitOptions.RemoveEmptyEntries);
            JsonNode? value = root;
            foreach (var segment in segments)
            {
                value = value is JsonObject owner ? owner[segment] : value is JsonArray array && int.TryParse(segment, out int index) && index >= 0 && index < array.Count ? array[index] : null;
                if (value == null) break;
            }
            if (value != null) return value;
        }
        return null;
    }
    public static JsonObject Body(AiVideoSettings settings, string prompt)
    {
        var size = settings.Size.Split('x');
        var values = new Dictionary<string, JsonNode?> { ["model"] = JsonValue.Create(settings.Model), ["prompt"] = JsonValue.Create(prompt), ["seconds"] = JsonValue.Create(settings.Seconds), ["width"] = JsonValue.Create(int.Parse(size[0])), ["height"] = JsonValue.Create(int.Parse(size[1])), ["size"] = JsonValue.Create(settings.Size), ["aspect"] = JsonValue.Create(size[0] + ":" + size[1]), ["fps"] = JsonValue.Create(settings.Fps), ["seed"] = settings.Seed < 0 ? null : JsonValue.Create(settings.Seed), ["generateAudio"] = JsonValue.Create(settings.GenerateAudio), ["negativePrompt"] = JsonValue.Create(settings.NegativePrompt) };
        JsonNode? Replace(JsonNode? node)
        {
            if (node is JsonObject owner) { var result = new JsonObject(); foreach (var item in owner) result[item.Key] = Replace(item.Value); return result; }
            if (node is JsonArray array) return new JsonArray(array.Select(Replace).ToArray());
            if (node is JsonValue value && value.TryGetValue<string>(out var text))
            {
                if (text.Length > 2 && text[0] == '{' && text[^1] == '}' && values.TryGetValue(text[1..^1], out var exact)) return exact?.DeepClone();
                return JsonValue.Create(Regex.Replace(text, @"\{([a-zA-Z]+)\}", match => values.TryGetValue(match.Groups[1].Value, out var replacement) ? Text(replacement) : throw new IOException("请求模板包含未知变量：" + match.Value)));
            }
            return node?.DeepClone();
        }
        return (JsonObject)Replace(JsonNode.Parse(settings.RequestJson))!;
    }
    public static HttpContent JsonContent(JsonNode node) => new StringContent(node.ToJsonString(), Encoding.UTF8, "application/json");
    public async Task<string> OptimizeAsync(string prompt, CancellationToken token)
    {
        var optimizer = settings with { BaseUrl = settings.OptimizerBaseUrl.Length > 0 ? settings.OptimizerBaseUrl : settings.BaseUrl, ApiKey = settings.OptimizerUseVideoKey ? settings.ApiKey : settings.OptimizerKey, AuthHeader = "Authorization", AuthPrefix = "Bearer ", HeadersJson = "{}" };
        using var client = new AiVideoHttp(optimizer);
        var body = new JsonObject { ["model"] = settings.OptimizerModel, ["messages"] = new JsonArray(new JsonObject { ["role"] = "system", ["content"] = AiVideoPrompt.System(settings) }, new JsonObject { ["role"] = "user", ["content"] = prompt }), [settings.TokenField] = settings.MaxTokens, ["stream"] = false };
        if (settings.Temperature.HasValue) body["temperature"] = settings.Temperature.Value;
        var result = await client.JsonAsync(HttpMethod.Post, Endpoint(optimizer.BaseUrl, settings.OptimizerPath), () => JsonContent(body), token);
        var content = ReadPath(result, "choices.0.message.content");
        string text = content is JsonArray array ? string.Join("", array.Select(item => item is JsonObject ? Text(item["text"]) : "")) : Text(content);
        text = Regex.Replace(text.Trim(), @"^```[^\r\n]*[\r\n]+|[\r\n]+```$", "").Trim();
        if (text.Length is < 40 or > 16000) throw new IOException("提示词优化接口未返回有效内容。");
        return text;
    }
    public void Dispose() => http.Dispose();
}
