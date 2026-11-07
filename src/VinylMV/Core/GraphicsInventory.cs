using System.Runtime.InteropServices;

namespace VinylMV.Core;

internal static class GraphicsInventory
{
    internal sealed record Snapshot(string[] Names, string Signature);

    // DXGI enumerates render-only adapters too. No WMI service or PowerShell process is required.
    // https://learn.microsoft.com/windows/win32/api/dxgi/nf-dxgi-idxgifactory1-enumadapters1
    public static Snapshot Read()
    {
        var factoryId = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
        Marshal.ThrowExceptionForHR(CreateDXGIFactory1(ref factoryId, out var factory));
        var names = new List<string>(); var signatures = new List<string>();
        try
        {
            var enumerate = Method<EnumAdapters>(factory, 12);
            for (uint index = 0; index < 32; index++)
            {
                int result = enumerate(factory, index, out var adapter);
                if (result == unchecked((int)0x887A0002)) break; // DXGI_ERROR_NOT_FOUND
                Marshal.ThrowExceptionForHR(result);
                try
                {
                    Marshal.ThrowExceptionForHR(Method<GetDescription>(adapter, 10)(adapter, out var description));
                    if ((description.Flags & 2) != 0) continue; // Software rasterizer, not a physical GPU.
                    string name = description.Description.Trim();
                    names.Add(name);
                    var deviceId = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
                    int supported = Method<CheckInterface>(adapter, 9)(adapter, ref deviceId, out long version);
                    // If the driver cannot expose its version, LUID conservatively invalidates across reboots.
                    string driver = supported >= 0 ? version.ToString("X16") : $"luid-{description.AdapterLuid:X16}";
                    signatures.Add($"{name}|{description.VendorId:X8}|{description.DeviceId:X8}|{description.SubSysId:X8}|{description.Revision:X8}|{driver}");
                }
                finally { Marshal.Release(adapter); }
            }
        }
        finally { Marshal.Release(factory); }
        return new(names.Distinct(StringComparer.OrdinalIgnoreCase).ToArray(), string.Join(";", signatures));
    }

    private static T Method<T>(IntPtr instance, int slot) where T : Delegate =>
        Marshal.GetDelegateForFunctionPointer<T>(Marshal.ReadIntPtr(Marshal.ReadIntPtr(instance), slot * IntPtr.Size));

    [DllImport("dxgi.dll", ExactSpelling = true)]
    private static extern int CreateDXGIFactory1(ref Guid interfaceId, out IntPtr factory);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int EnumAdapters(IntPtr factory, uint index, out IntPtr adapter);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetDescription(IntPtr adapter, out AdapterDescription description);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int CheckInterface(IntPtr adapter, ref Guid interfaceId, out long version);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct AdapterDescription
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
        public uint VendorId, DeviceId, SubSysId, Revision;
        public nuint DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
        public ulong AdapterLuid;
        public uint Flags;
    }
}
