using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace VinylMV.Core;

public sealed record ResourceLoad(double? Cpu, double? Gpu);
public interface IResourceMonitor : IDisposable { ResourceLoad Sample(); }

// Windows counters use English paths so discovery also works on Chinese Windows.
public sealed class ResourceMonitor : IResourceMonitor
{
    private IntPtr query, gpu;
    private ulong idle, total;
    private bool primed;
    public ResourceMonitor()
    {
        if (PdhOpenQuery(null, IntPtr.Zero, out query) == 0)
        {
            if (PdhAddEnglishCounter(query, @"\GPU Engine(*)\Utilization Percentage", IntPtr.Zero, out gpu) != 0) gpu = IntPtr.Zero;
            PdhCollectQueryData(query);
        }
        Sample();
    }
    public ResourceLoad Sample()
    {
        double? cpu = null, graphics = null;
        if (GetSystemTimes(out var nextIdle, out var kernel, out var user))
        {
            ulong nextTotal = kernel + user;
            if (primed && nextTotal > total && nextIdle >= idle) cpu = Math.Clamp(100.0 * (1 - (double)(nextIdle - idle) / (nextTotal - total)), 0, 100);
            idle = nextIdle; total = nextTotal; primed = true;
        }
        if (gpu != IntPtr.Zero && PdhCollectQueryData(query) == 0)
        {
            uint size = 0, count = 0;
            PdhGetFormattedCounterArray(gpu, 0x200, ref size, out count, IntPtr.Zero);
            if (size is > 0 and < 16_000_000)
            {
                var buffer = Marshal.AllocHGlobal((int)size);
                try
                {
                    if (PdhGetFormattedCounterArray(gpu, 0x200, ref size, out count, buffer) == 0)
                    {
                        var engines = new Dictionary<string, double>();
                        int stride = Marshal.SizeOf<CounterItem>();
                        for (int index = 0; index < count; index++)
                        {
                            var item = Marshal.PtrToStructure<CounterItem>(IntPtr.Add(buffer, stride * index));
                            var name = Marshal.PtrToStringUni(item.Name);
                            if (item.Value.Status > 1 || !double.IsFinite(item.Value.Number) || name == null || !name.Contains("eng_")) continue;
                            // Sum processes sharing the same physical engine before taking the busiest engine.
                            var key = Regex.Replace(name, @"^pid_\d+_", "");
                            engines[key] = engines.GetValueOrDefault(key) + Math.Max(0, item.Value.Number);
                        }
                        if (engines.Count > 0) graphics = Math.Clamp(engines.Values.Max(), 0, 100);
                    }
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
        }
        return new(cpu, graphics);
    }
    public void Dispose() { if (query != IntPtr.Zero) PdhCloseQuery(query); query = gpu = IntPtr.Zero; }
    [StructLayout(LayoutKind.Explicit, Size = 16)] private struct CounterValue { [FieldOffset(0)] public uint Status; [FieldOffset(8)] public double Number; }
    [StructLayout(LayoutKind.Sequential)] private struct CounterItem { public IntPtr Name; public CounterValue Value; }
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetSystemTimes(out ulong idleTime, out ulong kernelTime, out ulong userTime);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode, EntryPoint = "PdhOpenQueryW")] private static extern uint PdhOpenQuery(string? source, IntPtr data, out IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode, EntryPoint = "PdhAddEnglishCounterW")] private static extern uint PdhAddEnglishCounter(IntPtr query, string path, IntPtr data, out IntPtr counter);
    [DllImport("pdh.dll")] private static extern uint PdhCollectQueryData(IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode, EntryPoint = "PdhGetFormattedCounterArrayW")] private static extern uint PdhGetFormattedCounterArray(IntPtr counter, uint format, ref uint size, out uint count, IntPtr buffer);
    [DllImport("pdh.dll")] private static extern uint PdhCloseQuery(IntPtr query);
}

public sealed record EncoderCandidate(string Encoder, string Label, double Fps, System.Text.Json.JsonElement Settings, bool Measured = true);
public static class BatchDispatchPolicy
{
    public static EncoderCandidate? Choose(IReadOnlyList<EncoderCandidate> choices, ResourceLoad load, bool active, int threshold)
    {
        if (!active) return choices.OrderByDescending(c => c.Fps).FirstOrDefault();
        // Composition still uses CPU even when the final encode runs on the GPU.
        if (load.Cpu == null || load.Cpu >= threshold) return null;
        var ready = choices.Where(c => c.Encoder == "software" || load.Gpu is < 100 && load.Gpu < threshold).ToArray();
        if (ready.Length == 0) return null;
        double Occupancy(EncoderCandidate c) => c.Encoder == "software" ? load.Cpu.Value : load.Gpu!.Value;
        double lowest = ready.Min(Occupancy);
        return ready.Where(c => Occupancy(c) <= lowest + 10).OrderByDescending(c => c.Fps).First();
    }
}
