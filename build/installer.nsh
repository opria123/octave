; Custom NSIS hooks for OCTAVE installer.
;
; Problem: When the user runs auto-update (electron-updater quitAndInstall),
; the installer sometimes shows "OCTAVE cannot be closed" because lingering
; python.exe child processes spawned by the STRUM worker still hold open
; handles to files inside the install dir (resources\python\... and the
; bundled strum source).
;
; Solution: Before installing/uninstalling, kill any python.exe whose parent
; install dir matches ours. We use taskkill with a window-title-agnostic
; image-name match because PowerShell isn't guaranteed to be available in the
; minimal NSIS environment, but cmd.exe always is.

!macro customInit
  ; Best-effort: kill any leftover OCTAVE / python helpers before install.
  ; /F = force, /T = tree (children), /IM = image name. Errors are ignored
  ; (SetErrors is cleared) so a clean install where nothing is running is
  ; not treated as a failure.
  nsExec::Exec 'taskkill /F /T /IM octave.exe'
  nsExec::Exec 'taskkill /F /T /IM OCTAVE.exe'
  ; STRUM workers run under the bundled python.exe. Killing all python.exe
  ; instances on the machine is too aggressive, so target only ones that
  ; live inside our install dir tree. wmic is deprecated on Win11 but still
  ; ships; the command is wrapped in cmd /c so a missing wmic is harmless.
  nsExec::Exec 'cmd /c "for /f \"tokens=2 delims=,\" %P in (^'wmic process where ^"name=^'python.exe^' and ExecutablePath like ^'%%$INSTDIR%%^'^" get ProcessId /format:csv ^| findstr /r /c:[0-9]^') do @taskkill /F /PID %P"'
  SetErrors
  ClearErrors
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /T /IM octave.exe'
  nsExec::Exec 'taskkill /F /T /IM OCTAVE.exe'
  ClearErrors
!macroend
