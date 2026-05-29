# Changelog

All notable changes to GMS Scroller. Paste the relevant section into the GitHub
release body when publishing — that text is shown to users in the in-app update
prompt.

## [Unreleased]

### Added
- Automatic update check on startup, with an in-app prompt showing the changelog
  and Download & Install / Later options (via `electron-updater` + GitHub Releases).
- Bundled "Screen Capturer Recorder" audio driver — installed automatically on
  first install (skipped on updates if already present).
- GitHub Actions release pipeline: pushing a `vX.Y.Z` tag builds the Windows
  installer and publishes a draft GitHub release.
