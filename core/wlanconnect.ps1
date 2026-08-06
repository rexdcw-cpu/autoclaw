# WlanConnect helper: connect to a (possibly hidden) WiFi by profile name,
# using the WlanConnect Win32 API with an EXPLICIT SSID so Windows performs a
# directed probe. netsh wlan connect does NOT do this for hidden SSIDs and
# fails with "not available to connect". This helper fixes that.
#
# Usage: powershell -ExecutionPolicy Bypass -File wlanconnect.ps1 -Profile ROSNET2 -Ssid ROSNET2 [-Interface WLAN] [-Timeout 30]
param(
  [string]$Profile,
  [string]$Ssid,
  [string]$Interface = "",
  [int]$Timeout = 30
)

# Trim environment so the C# compiler (Add-Type -> csc.exe) child process does
# not exceed the 65535-byte environment-block limit on bloated shells.
$keep = @('SystemRoot','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','HOMEDRIVE',
          'HOMEPATH','PATH','SystemDrive','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE',
          'OS','COMPUTERNAME','USERNAME','USERDOMAIN','LOGONSERVER','PUBLIC',
          'ALLUSERSPROFILE','ProgramData','ProgramFiles','ProgramFiles(x86)',
          'CommonProgramFiles','PATHEXT','PSModulePath')
$all = [System.Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)
foreach ($key in $all.Keys) {
  if ($keep -notcontains $key) {
    try { [System.Environment]::SetEnvironmentVariable($key, $null, [System.EnvironmentVariableTarget]::Process) } catch {}
  }
}

$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WlanConnectEx {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WLAN_CONNECTION_PARAMETERS {
        public int wlanConnectionMode;
        [MarshalAs(UnmanagedType.LPWStr)] public string strProfile;
        public IntPtr pDot11Ssid;
        public IntPtr pDesiredBssidList;
        public int dot11BssType;
        public int dwFlags;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct DOT11_SSID {
        public uint uSSIDLength;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)] public byte[] ucSSID;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WLAN_INTERFACE_INFO {
        public Guid InterfaceGuid;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strInterfaceDescription;
        public uint isState;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct WLAN_INTERFACE_INFO_LIST {
        public uint dwNumberOfItems;
        public uint dwIndex;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 1)] public WLAN_INTERFACE_INFO[] InterfaceInfo;
    }
    [DllImport("wlanapi.dll")]
    public static extern uint WlanOpenHandle(uint dwClientVersion, IntPtr pReserved, out uint pdwNegotiatedVersion, out IntPtr phClientHandle);
    [DllImport("wlanapi.dll")]
    public static extern uint WlanCloseHandle(IntPtr hClientHandle, IntPtr pReserved);
    [DllImport("wlanapi.dll")]
    public static extern uint WlanEnumInterfaces(IntPtr hClientHandle, IntPtr pReserved, out IntPtr ppInterfaceList);
    [DllImport("wlanapi.dll")]
    public static extern uint WlanConnect(IntPtr hClientHandle, ref Guid pInterfaceGuid, ref WLAN_CONNECTION_PARAMETERS pConnectionParameters, IntPtr pReserved);
}
'@
Add-Type -TypeDefinition $code

if (-not $Profile) { Write-Host "FAIL: -Profile required"; exit 2 }
if (-not $Ssid)  { $Ssid = $Profile }

$h = [IntPtr]::Zero
$ver = 0
[void][WlanConnectEx]::WlanOpenHandle(2, [IntPtr]::Zero, [ref]$ver, [ref]$h)

$ifListPtr = [IntPtr]::Zero
$rc = [WlanConnectEx]::WlanEnumInterfaces($h, [IntPtr]::Zero, [ref]$ifListPtr)
if ($rc -ne 0) { Write-Host "FAIL: WlanEnumInterfaces rc=$rc"; [void][WlanConnectEx]::WlanCloseHandle($h,[IntPtr]::Zero); exit 3 }
$ifList = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ifListPtr, [type][WlanConnectEx+WLAN_INTERFACE_INFO_LIST])

$guid = $null
if ($Interface) {
  foreach ($it in $ifList.InterfaceInfo) {
    if ($it.strInterfaceDescription -eq $Interface -or $it.strInterfaceDescription -like "*$Interface*") { $guid = $it.InterfaceGuid; break }
  }
}
if ($guid -eq $null) {
  # 未指定或指定未命中：优先选无线网卡（描述含 Wi-Fi/Wireless/WLAN/WiFi），否则取第一个。
  # 注意：-Interface 收到的是 netsh 的「接口名」(如 WLAN/Wi-Fi)，而本结构里只有
  # 接口「描述」(如 "Intel(R) Wi-Fi 6E AX211 160MHz")，两者不是一回事，故用子串/特征匹配。
  foreach ($it in $ifList.InterfaceInfo) {
    if ($it.strInterfaceDescription -match 'Wi-?Fi|Wireless|WLAN') { $guid = $it.InterfaceGuid; break }
  }
  if ($guid -eq $null) { $guid = $ifList.InterfaceInfo[0].InterfaceGuid }
}

$ssidBytes = [System.Text.Encoding]::UTF8.GetBytes($Ssid)
$ssidStruct = New-Object WlanConnectEx+DOT11_SSID
$ssidStruct.uSSIDLength = [uint32]$ssidBytes.Length
$ssidStruct.ucSSID = New-Object byte[] 32
[Array]::Copy($ssidBytes, $ssidStruct.ucSSID, $ssidBytes.Length)
$ssidPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal([System.Runtime.InteropServices.Marshal]::SizeOf($ssidStruct))
[System.Runtime.InteropServices.Marshal]::StructureToPtr($ssidStruct, $ssidPtr, $false)

$params = New-Object WlanConnectEx+WLAN_CONNECTION_PARAMETERS
$params.wlanConnectionMode = 0
$params.strProfile = $Profile
$params.pDot11Ssid = $ssidPtr
$params.pDesiredBssidList = [IntPtr]::Zero
$params.dot11BssType = 1
$params.dwFlags = 0

# 切换前先断开当前连接，避免 WLAN 服务仍在处理上一个连接状态、
# 在真实轮询任务中快速连续切网时造成 WlanConnect 竞争失败（表现为 not connected within 30s）。
[void](netsh wlan disconnect 2>$null)
Start-Sleep -Seconds 2

$rc = [WlanConnectEx]::WlanConnect($h, [ref]$guid, [ref]$params, [IntPtr]::Zero)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($ssidPtr)

if ($rc -ne 0) { Write-Host "FAIL: WlanConnect rc=$rc"; [void][WlanConnectEx]::WlanCloseHandle($h,[IntPtr]::Zero); exit 5 }

$connected = $false
for ($i=1; $i -le [math]::Floor($Timeout/2); $i++) {
  Start-Sleep -Seconds 2
  $out = (netsh wlan show interfaces | Select-String "SSID") | ForEach-Object { $_.Line }
  if (($out -join " ") -match $Ssid) { $connected = $true; break }
}
[void][WlanConnectEx]::WlanCloseHandle($h, [IntPtr]::Zero)

if ($connected) { Write-Host "OK: connected to $Ssid"; exit 0 }
else { Write-Host "FAIL: not connected to $Ssid within ${Timeout}s"; exit 6 }
