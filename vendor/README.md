# Vendored binaries

## setup-screen-capturer-recorder.exe

Place the official **Screen Capturer Recorder** installer here, named exactly:

```
vendor/setup-screen-capturer-recorder.exe
```

Download the latest `Setup.Screen.Capturer.Recorder.vX.X.X.exe` from:
https://github.com/rdp/screen-capture-recorder-to-video-windows-free/releases

(rename it to `setup-screen-capturer-recorder.exe`).

This file is bundled into the app via `build.extraResources` in `package.json`
and run automatically by `build/installer.nsh` during a fresh install to provide
the `virtual-audio-capturer` DirectShow device used for system-audio loopback
capture (see `src/AudioCapture.js`).

> **The build (`npm run build` / the release workflow) will fail until this file
> exists.** It is intentionally committed to the repo so CI can package it.
