#ifndef PayloadDir
  #define PayloadDir ".build\1.0\dist\Mainline"
#endif
#ifndef ReleaseDir
  #define ReleaseDir "..\downloads"
#endif

[Setup]
AppId={{0DF72060-3E71-4A97-86B4-33B4B8BE1080}
AppName=Mainline
AppVersion=1.0
AppVerName=Mainline 安装版 1.0
AppPublisher=Mainline Project
AppPublisherURL=https://github.com/qinq3132-cmyk/MainLine
DefaultDirName={localappdata}\Programs\Mainline
DefaultGroupName=Mainline
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#ReleaseDir}
OutputBaseFilename=Mainline-Setup-1.0
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Mainline 安装版
UninstallDisplayIcon={app}\Mainline.exe
CloseApplications=yes
CloseApplicationsFilter=Mainline.exe
RestartApplications=no
SetupLogging=yes
VersionInfoVersion=1.0.0.0
VersionInfoDescription=Mainline Installed Edition Setup
VersionInfoProductName=Mainline Installed Edition
VersionInfoProductVersion=1.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; Flags: unchecked

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Mainline"; Filename: "{app}\Mainline.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Mainline"; Filename: "{app}\Mainline.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Mainline.exe"; Description: "打开 Mainline"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\Mainline.exe"; Parameters: "--uninstall-background-task"; Flags: runhidden waituntilterminated skipifdoesntexist; RunOnceId: "MainlineBackgroundCleanup"

[Code]
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    if not UninstallSilent then
      MsgBox('程序已卸载。本地任务、聊天、笔记、附件、密钥和备份已保留。仅清理指向本安装位置的后台任务，其他版本的后台任务保持不变。', mbInformation, MB_OK);
end;
