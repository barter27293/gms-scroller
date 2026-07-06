; GMS Scroller — custom NSIS installer pages and hooks.
;
; Macro injection points (called by electron-builder's NSIS templates):
;
;   customWelcomePage        — replaces the default MUI welcome page with an
;                              app description (assistedInstaller.nsh)
;   customPageAfterChangeDir — adds the audio driver explanation page before
;                              the install progress page (assistedInstaller.nsh)
;   customHeader             — defines the AudioDriverPage dialog function at
;                              the top-level script scope (installer.nsi)
;   customInstall            — silently installs the audio driver on fresh
;                              installs; skipped if already present (installSection.nsh)

; ── Welcome page ──────────────────────────────────────────────────────────────

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to GMS Scroller"
  !define MUI_WELCOMEPAGE_TEXT "GMS Scroller automatically scrolls your PDF transcript in sync with what you hear on the GMS audio site.$\r$\n$\r$\nHow it works:$\r$\n  - Load a PDF transcript into the app$\r$\n  - GMS Scroller listens to your computer audio in real time$\r$\n  - On-device speech recognition follows along$\r$\n  - The matching paragraph is highlighted and scrolled into view$\r$\n$\r$\nClick Next to continue with the installation."
  !insertmacro MUI_PAGE_WELCOME
!macroend

; ── Audio driver explanation page declaration ─────────────────────────────────

!macro customPageAfterChangeDir
  Page custom AudioDriverPage
!macroend

; ── Audio driver explanation page function ────────────────────────────────────

!macro customHeader
  ; customHeader is injected into BOTH the installer and uninstaller scripts.
  ; The page function is only referenced by the installer; defining it in the
  ; uninstaller pass trips NSIS's "function not referenced" warning-as-error.
  !ifndef BUILD_UNINSTALLER
  Function AudioDriverPage
    ; Skip this page if the driver folder is already present (update or reinstall)
    ${if} ${FileExists} "$PROGRAMFILES64\Screen Capturer Recorder\*.*"
      Abort
    ${endif}
    ${if} ${FileExists} "$PROGRAMFILES32\Screen Capturer Recorder\*.*"
      Abort
    ${endif}

    !insertmacro MUI_HEADER_TEXT "Audio Driver Required" "GMS Scroller needs a small system driver to capture audio output."

    nsDialogs::Create 1018
    Pop $0

    ${NSD_CreateLabel} 0 0 100% 130u "To follow along with audio playback, GMS Scroller will install Screen Capturer Recorder - a free, open-source Windows audio driver by Roger Pack.$\r$\n$\r$\nThis driver lets the app capture your computer audio output without affecting your speakers, headphones, or any other software.$\r$\n$\r$\nWhat to expect:$\r$\n  * A Windows security prompt (UAC) will appear - please click Yes to allow$\r$\n  * This only happens on first install; app updates will not reinstall the driver$\r$\n  * Source: github.com/rdp/screen-capture-recorder-to-video-windows-free$\r$\n$\r$\nClick Next to continue."
    Pop $1

    nsDialogs::Show
  FunctionEnd
  !endif
!macroend

; ── Install hook ───────────────────────────────────────────────────────────────

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
