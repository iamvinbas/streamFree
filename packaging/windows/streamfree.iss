; Windows installer for streamFree (Inno Setup 6).
;   iscc /DAppVersion=0.3.1 /DExePath=..\..\target\x86_64-pc-windows-msvc\release\streamfree.exe packaging\windows\streamfree.iss
; Installs per user (no administrator rights), adds Start menu and optional
; desktop shortcuts that open the app window, and registers an uninstaller.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef ExePath
  #define ExePath "..\..\target\release\streamfree.exe"
#endif

[Setup]
AppId={{B4C6E6A2-5D1F-4F7E-9C3A-6D5EFC2026AA}
AppName=streamFree
AppVersion={#AppVersion}
AppVerName=streamFree {#AppVersion}
AppPublisher=iamvinbas
AppPublisherURL=https://github.com/iamvinbas/streamFree
AppSupportURL=https://github.com/iamvinbas/streamFree/issues
DefaultDirName={localappdata}\Programs\streamFree
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\..\dist
OutputBaseFilename=streamFree-Windows-Setup
SetupIconFile=..\icons\streamfree.ico
UninstallDisplayIcon={app}\streamfree.exe
UninstallDisplayName=streamFree
LicenseFile=..\..\LICENSE
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "italian"; MessagesFile: "compiler:Languages\Italian.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#ExePath}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; --app opens streamFree's own window. The program detaches from its
; console at start, so the shortcut starts it minimized to avoid a flash.
Name: "{autoprograms}\streamFree"; Filename: "{app}\streamfree.exe"; Parameters: "--app"; WorkingDir: "{app}"; Flags: runminimized
Name: "{autodesktop}\streamFree"; Filename: "{app}\streamfree.exe"; Parameters: "--app"; WorkingDir: "{app}"; Flags: runminimized; Tasks: desktopicon

[Run]
Filename: "{app}\streamfree.exe"; Parameters: "--app"; Description: "{cm:LaunchProgram,streamFree}"; Flags: nowait postinstall skipifsilent runminimized
