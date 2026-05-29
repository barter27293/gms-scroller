; Custom NSIS hooks for the GMS Scroller installer (electron-builder).
;
; On a FRESH install, run the bundled "Setup Screen Capturer Recorder" driver
; so the `virtual-audio-capturer` DirectShow device exists for FFmpeg loopback
; capture (see src/AudioCapture.js). On UPDATES, skip it if the driver is
; already present so the user isn't re-prompted on every upgrade.
;
; The driver's own installer requests admin elevation to register the COM
; filter, so even from this per-user (non-elevated) installer the user sees a
; single UAC prompt the first time — and never again once installed.

!macro customInstall
  ; Detection: the screen-capture-recorder installer drops files under
  ; "%ProgramFiles%\Screen Capturer Recorder". If that folder exists we assume
  ; the driver is already installed and skip re-running setup.
  ;
  ; NOTE: verify this path on a machine that has the driver installed and adjust
  ; if needed. A registry probe of the driver's uninstall key is a more robust
  ; alternative if the install location differs across versions.
  ${ifNot} ${FileExists} "$PROGRAMFILES64\Screen Capturer Recorder\*.*"
  ${andIfNot} ${FileExists} "$PROGRAMFILES32\Screen Capturer Recorder\*.*"
    DetailPrint "Installing audio capture driver (screen-capture-recorder)..."
    ; The setup .exe is laid down with the app's resources during install.
    ExecWait '"$INSTDIR\resources\setup-screen-capturer-recorder.exe" /S'
  ${endIf}
!macroend
