; Uninstalling Purgeon also removes the scheduled tasks it created: Start with Windows and
; Scheduled Maintenance. Both live in Task Scheduler's \Purgeon\ folder (\SweepUninstall\ in
; versions from before the rename).
!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'schtasks.exe /Delete /TN "\Purgeon\Start at Sign-in" /F'
  Pop $0
  nsExec::Exec 'schtasks.exe /Delete /TN "\Purgeon\Weekly Maintenance" /F'
  Pop $0
  nsExec::Exec 'schtasks.exe /Delete /TN "\SweepUninstall\Start at Sign-in" /F'
  Pop $0
  nsExec::Exec 'schtasks.exe /Delete /TN "\SweepUninstall\Weekly Maintenance" /F'
  Pop $0
!macroend
