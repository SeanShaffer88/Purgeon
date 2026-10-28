; Closing a running Purgeon before its files are replaced. The installer drops an
; "exit-for-update" marker next to the program; the running app watches for it and
; exits through its normal quit path (log flushed, state saved). If it has not gone
; within about ten seconds (an old version without the watch, or a stuck window),
; it is ended by name as a fallback. $R9 remembers whether it had been running so
; the install step can relaunch it afterwards.
!macro PURGEON_CLOSE_RUNNING ID
  Delete "$INSTDIR\exit-for-update"
  StrCpy $R9 "0"
  nsExec::ExecToStack 'powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-Process -Name "${MAINBINARYNAME}" -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"'
  Pop $8
  Pop $6
  ${If} $8 == 0
    StrCpy $R9 "1"
    FileOpen $8 "$INSTDIR\exit-for-update" w
    FileWrite $8 "exit"
    FileClose $8
    StrCpy $R8 0
    purgeon_wait_${ID}:
      Sleep 500
      nsExec::ExecToStack 'powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-Process -Name "${MAINBINARYNAME}" -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"'
      Pop $8
      Pop $6
      ${If} $8 != 0
        Goto purgeon_done_${ID}
      ${EndIf}
      IntOp $R8 $R8 + 1
      ${If} $R8 >= 20
        nsExec::Exec 'taskkill /IM "${MAINBINARYNAME}.exe" /F'
        Pop $8
        Sleep 1000
        Goto purgeon_done_${ID}
      ${EndIf}
      Goto purgeon_wait_${ID}
    purgeon_done_${ID}:
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro PURGEON_CLOSE_RUNNING pre
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; A finished install never leaves a marker behind, and a silent install
  ; relaunches the app it closed; interactive installs offer the finish
  ; page's Run check box instead.
  Delete "$INSTDIR\exit-for-update"
  ${If} $R9 == "1"
  ${AndIf} ${Silent}
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
  ${EndIf}
!macroend

; Uninstalling Purgeon also removes the scheduled tasks it created: Start with Windows and
; Scheduled Maintenance. Both live in Task Scheduler's \Purgeon\ folder (\SweepUninstall\ in
; versions from before the rename).
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro PURGEON_CLOSE_RUNNING preun
  nsExec::Exec 'schtasks.exe /Delete /TN "\Purgeon\Start at Sign-in" /F'
  Pop $0
  nsExec::Exec 'schtasks.exe /Delete /TN "\Purgeon\Weekly Maintenance" /F'
  Pop $0
  nsExec::Exec 'schtasks.exe /Delete /TN "\SweepUninstall\Start at Sign-in" /F'
  Pop $0
  nsExec::Exec 'schtasks.exe /Delete /TN "\SweepUninstall\Weekly Maintenance" /F'
  Pop $0
!macroend
