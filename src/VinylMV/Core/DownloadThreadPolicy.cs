namespace VinylMV.Core;

public sealed class DownloadThreadPolicy
{
    private double? previousAdditionSpeed;
    public int StagnantAdditions { get; private set; }
    public bool Frozen => StagnantAdditions >= AdaptiveDownloader.MaximumStagnantAdditions;

    // Called once per completed three-second bandwidth measurement window.
    public bool ShouldAdd(double speed, int currentThreads)
    {
        if (previousAdditionSpeed is { } previous)
        {
            StagnantAdditions = speed - previous > AdaptiveDownloader.MeaningfulGain ? 0 : StagnantAdditions + 1;
            previousAdditionSpeed = null;
        }
        if (speed >= AdaptiveDownloader.TargetSpeed || Frozen || currentThreads >= AdaptiveDownloader.MaximumThreads) return false;
        previousAdditionSpeed = speed;
        return true;
    }
}
