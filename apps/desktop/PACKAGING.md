# ShadowShield Desktop Tray — Packaging & Release Guide (T3)

This document describes the Tauri v2 packaging configuration and release requirements for `apps/desktop`.

## 1. Current Configuration (`src-tauri/tauri.conf.json`)

- **Product Name:** `ShadowShield`
- **Bundle Identifier:** `com.shadowshield.desktop`
- **Minimum macOS Version:** `12.0` (`bundle.macOS.minimumSystemVersion`)
- **Menu-Bar Behavior:** On macOS (`#[cfg(target_os = "macos")]`), `src-tauri/src/lib.rs` sets `tauri::ActivationPolicy::Accessory` during setup so the tray application operates as a menu-bar accessory without occupying the Dock, and handles `RunEvent::Reopen` and `WindowEvent::CloseRequested` so closing the status window hides it to the tray rather than exiting.
- **Windows Support:** Development and `--no-bundle` builds on Windows remain intact (`icons/icon.ico` + `UnsupportedPlatformTransport` fallback).

## 2. macOS Release & Signing Requirements (Not Yet Executed)

No Apple Developer certificates, provisioning profiles, or notarization credentials are stored in this repository. Before distributing a macOS `.app` or `.dmg` release, a maintainer on macOS must perform the following steps:

1. **Generate `.icns` Bundle Icon (if required for release branding):**
   ```bash
   npm --prefix apps/desktop run tauri icon src-tauri/icons/icon.png
   ```
   Verify `src-tauri/icons/icon.icns` is included in `bundle.icon` on macOS builds.
2. **Code Signing:**
   Configure the Apple Developer ID Application certificate in the macOS Keychain and set:
   - `APPLE_SIGNING_IDENTITY` (e.g., `Developer ID Application: <Org> (<TeamID>)`)
3. **Notarization:**
   Configure App Store Connect API or Apple ID notarization environment variables:
   - `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_PATH` (or `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`)
4. **Build & Verify on macOS:**
   ```bash
   npm --prefix apps/desktop run tauri build
   ```
   Then verify live Unix domain socket IPC (`~/Library/Application Support/ShadowShield/run/agent.sock`), menu-bar tray icon rendering, `Show Status`, window-close persistence, and `Quit`.
