# ShadowShield Native Messaging Installation

This directory contains the Native Messaging manifest templates required to register the ShadowShield background agent with the browser.

## macOS

### Chrome / Chromium

1. Modify `macos/native-messaging/com.shadowshield.agent.json` to ensure the `path` correctly points to the absolute path of the built `shadowshield-agent` binary.
2. Copy the manifest file to the correct directory:
   ```bash
   cp macos/native-messaging/com.shadowshield.agent.json ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/
   ```
*(For system-wide installation, use `/Library/Google/Chrome/NativeMessagingHosts/`)*

## Windows

### Chrome / Chromium

1. Modify `windows/native-messaging/com.shadowshield.agent.json` to ensure the `path` points to the absolute path of the built `shadowshield-agent.exe` (use double backslashes `\\`).
2. Register the manifest in the Windows Registry. You can run the following command in Command Prompt (as Administrator for system-wide, or as regular user for current user):
   ```cmd
   REG ADD "HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.shadowshield.agent" /ve /t REG_SZ /d "C:\path\to\ShadowShield\installers\windows\native-messaging\com.shadowshield.agent.json" /f
   ```

## Allowed Origins

Ensure the `allowed_origins` array in the manifest contains the actual extension ID assigned by the browser (e.g., `chrome-extension://<EXTENSION_ID>/`).
