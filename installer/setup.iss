#define AppVersion "0.9.0"
#ifndef PublishDir
  #define PublishDir "..\artifacts\publish"
#endif
#include "prerequisites.iss"
#if Len(CoreRuntimeHash) != 64 || Len(DesktopRuntimeHash) != 64
  #error 请先运行 tools/prepare-runtime.ps1 校验运行环境
#endif

[Setup]
AppId={{4D17D9C8-6FA5-43F2-9897-B19094D4A4AF}
AppName=拾音
AppVersion={#AppVersion}
AppVerName=拾音 {#AppVersion}
AppPublisher=拾音开源项目
DefaultDirName={localappdata}\Programs\拾音
DisableDirPage=no
DisableProgramGroupPage=yes
UsePreviousAppDir=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
WizardStyle=modern
ShowLanguageDialog=no
LanguageDetectionMethod=none
SetupIconFile=..\src\VinylMV\Assets\app.ico
UninstallDisplayIcon={app}\VinylMV.exe
UninstallDisplayName=拾音
OutputDir=..\artifacts\installer
OutputBaseFilename=拾音安装程序-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
DiskSpanning=no
ArchiveExtraction=full
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
LicenseFile=许可说明.txt
InfoBeforeFile=安装说明.txt

[Languages]
Name: "chinesesimp"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: unchecked

[Files]
Source: "{#PublishDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "*.pdb,*.xml"
Source: "..\.tools\WebView2Bootstrapper.exe"; Flags: dontcopy
Source: "..\LICENSE"; DestDir: "{app}"; DestName: "开源许可.txt"; Flags: ignoreversion
Source: "..\THIRD-PARTY-NOTICES.md"; DestDir: "{app}"; DestName: "第三方组件说明.txt"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\拾音"; Filename: "{app}\VinylMV.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\拾音"; Filename: "{app}\VinylMV.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\VinylMV.exe"; Description: "启动拾音"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\runtime"

[Code]
var
  DownloadPage: TDownloadWizardPage;
  RuntimeRequired, WebViewRequired, RuntimeDownloaded: Boolean;

function HasDesktopRuntime: Boolean;
var
  Names: TArrayOfString;
  I: Integer;
  RuntimeFolder: TFindRec;
  GlobalDirectory: String;
begin
  Result := False;
  if FileExists(ExpandConstant('{app}\runtime\host\fxr\{#RuntimeVersion}\hostfxr.dll')) and
     DirExists(ExpandConstant('{app}\runtime\shared\Microsoft.WindowsDesktop.App\{#RuntimeVersion}')) then begin
    Result := True;
    exit;
  end;
  if ExpandConstant('{param:PRIVATERUNTIME|0}') = '1' then exit;
  GlobalDirectory := ExpandConstant('{commonpf64}\dotnet\shared\Microsoft.WindowsDesktop.App\');
  if FindFirst(GlobalDirectory + '10.0.*', RuntimeFolder) then begin
    try
      repeat
        if FileExists(GlobalDirectory + RuntimeFolder.Name + '\PresentationFramework.dll') then begin
          Result := True;
          break;
        end;
      until not FindNext(RuntimeFolder);
    finally
      FindClose(RuntimeFolder);
    end;
    if Result then exit;
  end;
  if RegGetValueNames(HKLM64, 'SOFTWARE\dotnet\Setup\InstalledVersions\x64\sharedfx\Microsoft.WindowsDesktop.App', Names) then
    for I := 0 to GetArrayLength(Names) - 1 do
      if Pos('10.0.', Names[I]) = 1 then begin
        Result := True;
        exit;
      end;
end;

function HasWebView: Boolean;
var
  Version: String;
  ClientKey: String;
begin
  ClientKey := 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  Result := (RegQueryStringValue(HKCU, ClientKey, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0')) or
    (RegQueryStringValue(HKLM32, ClientKey, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0')) or
    (RegQueryStringValue(HKLM64, ClientKey, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0'));
end;

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage('准备运行环境', '仅下载电脑上缺失的运行组件，请保持联网。', nil);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = wpReady then begin
    RuntimeRequired := not HasDesktopRuntime;
    WebViewRequired := not HasWebView;
    if RuntimeRequired and not RuntimeDownloaded then begin
      DownloadPage.Clear;
      DownloadPage.Add('{#CoreRuntimeUrl}', 'dotnet-runtime.zip', '{#CoreRuntimeHash}');
      DownloadPage.Add('{#DesktopRuntimeUrl}', 'windowsdesktop-runtime.zip', '{#DesktopRuntimeHash}');
      DownloadPage.Show;
      try
        try
          DownloadPage.Download;
          RuntimeDownloaded := True;
        except
          if not DownloadPage.AbortedByUser then
            SuppressibleMsgBox('运行环境下载失败，请检查网络后重试。' + #13#10 + GetExceptionMessage, mbError, MB_OK, IDOK);
          Result := False;
        end;
      finally
        DownloadPage.Hide;
      end;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
begin
  Result := '';
  try
    if RuntimeRequired then begin
      WizardForm.PreparingLabel.Caption := '正在配置本地运行环境……';
      ForceDirectories(ExpandConstant('{app}\runtime'));
      ExtractArchive(ExpandConstant('{tmp}\dotnet-runtime.zip'), ExpandConstant('{app}\runtime'), '', True, nil);
      ExtractArchive(ExpandConstant('{tmp}\windowsdesktop-runtime.zip'), ExpandConstant('{app}\runtime'), '', True, nil);
    end;
    if WebViewRequired then begin
      WizardForm.PreparingLabel.Caption := '正在安装网页界面运行组件，请稍候……';
      ExtractTemporaryFile('WebView2Bootstrapper.exe');
      if not Exec(ExpandConstant('{tmp}\WebView2Bootstrapper.exe'), '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then
        Result := '无法启动界面运行组件安装程序。'
      else if (ExitCode <> 0) and (ExitCode <> 3010) then
        Result := '界面运行组件安装失败，请检查网络后重试。错误代码：' + IntToStr(ExitCode);
    end;
  except
    Result := '运行环境配置失败：' + GetExceptionMessage;
  end;
end;
