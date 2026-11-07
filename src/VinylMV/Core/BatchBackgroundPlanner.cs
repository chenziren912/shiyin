using System.IO;

namespace VinylMV.Core;

public sealed record BatchBackgroundOptions(string Scope = "genre", string Order = "random", bool AvoidRepeat = false, string NoMatch = "library")
{
    public void Validate()
    {
        if (Scope is not ("genre" or "all") || Order is not ("random" or "sequence") || NoMatch is not ("library" or "unassigned"))
            throw new IOException("背景分配设置无效。");
    }
}

public sealed record BackgroundChoice(LibraryVideo? Video, bool Matched, string? Reason = null);

// One planner per queue pass. Preserved assignments count towards repeat avoidance.
public sealed class BatchBackgroundPlanner
{
    private readonly LibraryVideo[] available;
    private readonly BatchBackgroundOptions options;
    private readonly Random random;
    private readonly Dictionary<string, int> uses = new();
    private readonly Dictionary<string, int> cursors = new();

    public BatchBackgroundPlanner(IReadOnlyList<LibraryVideo> library, BatchBackgroundOptions options, IEnumerable<string>? preserved = null, Random? random = null)
    {
        options.Validate(); this.options = options; this.random = random ?? Random.Shared;
        available = library.Where(v => v.Available).ToArray();
        foreach (var id in preserved ?? []) uses[id] = uses.GetValueOrDefault(id) + 1;
    }

    public BackgroundChoice Choose(IEnumerable<string> genres, string? keepVideoId = null)
    {
        var wanted = MusicGenres.Normalize(genres).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var matching = available.Where(v => MusicGenres.Normalize(v.Genres).Any(wanted.Contains)).ToArray();
        var kept = available.FirstOrDefault(v => v.Id == keepVideoId);
        var pool = options.Scope == "genre" && matching.Length > 0 ? matching : available;
        string key = string.Join("\n", pool.Select(v => v.Id));
        if (kept != null)
        {
            int position = Array.IndexOf(pool, kept);
            if (position >= 0) cursors[key] = position + 1;
            return new(kept, matching.Contains(kept));
        }
        if (available.Length == 0) return new(null, false, "视频库没有可用视频");
        if (options.Scope == "genre" && matching.Length == 0 && options.NoMatch == "unassigned")
            return new(null, false, "没有匹配风格的视频，请修改风格、视频库或分配设置");
        int least = options.AvoidRepeat ? pool.Min(v => uses.GetValueOrDefault(v.Id)) : 0;
        var eligible = options.AvoidRepeat ? pool.Where(v => uses.GetValueOrDefault(v.Id) == least).ToArray() : pool;
        LibraryVideo chosen;
        if (options.Order == "random") chosen = eligible[random.Next(eligible.Length)];
        else
        {
            int cursor = cursors.GetValueOrDefault(key) % pool.Length;
            chosen = Enumerable.Range(0, pool.Length).Select(i => pool[(cursor + i) % pool.Length]).First(eligible.Contains);
        }
        cursors[key] = Array.IndexOf(pool, chosen) + 1;
        uses[chosen.Id] = uses.GetValueOrDefault(chosen.Id) + 1;
        return new(chosen, matching.Contains(chosen));
    }
}
