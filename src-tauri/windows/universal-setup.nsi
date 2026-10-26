; One entry point delegates to the existing architecture-specific installers.
; Those installers retain upgrade, WebView2, shortcut and uninstall behavior.
Unicode true
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

Name "Purgeon Setup"
OutFile "${OUTPUT}"
RequestExecutionLevel admin
ManifestDPIAware true
SilentInstall silent
SetCompressor /SOLID lzma
Icon "${ICON}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "Purgeon Setup"
VIAddVersionKey /LANG=1033 "FileDescription" "Purgeon installer for x86 and x64 Windows"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright (c) 2026 Sean Shaffer"

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  ${If} ${RunningX64}
    File /oname=setup.exe "${SETUP_X64}"
  ${Else}
    File /oname=setup.exe "${SETUP_X86}"
  ${EndIf}
  IfErrors failed
  ; NSIS strips /D= from CMDLINE and stores it in INSTDIR. This wrapper has no
  ; default InstallDir, so forward an explicitly supplied directory last.
  ${GetParameters} $0
  ${If} $INSTDIR != ""
    StrCpy $0 "$0 /D=$INSTDIR"
  ${EndIf}
  ClearErrors
  ExecWait '"$PLUGINSDIR\setup.exe" $0' $1
  IfErrors failed
  SetErrorLevel $1
  Quit
failed:
  MessageBox MB_OK|MB_ICONSTOP "Purgeon Setup could not start the installer." /SD IDOK
  SetErrorLevel 1
SectionEnd
