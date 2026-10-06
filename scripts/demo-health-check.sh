#!/usr/bin/env bash
# Read-only health check for ShadowShield Presentation Demo

echo "ShadowShield Presentation Health Check"
echo "======================================"

# Check repository
if git status &> /dev/null; then
    echo "[PASS] Git repository exists and is clean or accessible."
else
    echo "[FAIL] Not inside a Git repository."
fi

# Check native host binary
if [ -f "target/debug/shadowshield-native-host" ]; then
    if [ -x "target/debug/shadowshield-native-host" ]; then
        echo "[PASS] Native host binary exists and is executable."
    else
        echo "[WARN] Native host binary exists but is NOT executable."
    fi
else
    echo "[FAIL] Native host binary not found at target/debug/shadowshield-native-host."
fi

# Check extension artifacts
EXT_FILES=("apps/extension/dist/background/service-worker.js" "apps/extension/dist/content/chatgpt-content.js" "apps/extension/dist/content/gemini-content.js")
ALL_EXT_EXIST=true
for f in "${EXT_FILES[@]}"; do
    if [ ! -f "$f" ]; then
        echo "[FAIL] Missing extension artifact: $f"
        ALL_EXT_EXIST=false
    fi
done
if [ "$ALL_EXT_EXIST" = true ]; then
    echo "[PASS] Core extension dist artifacts exist."
fi

# Check Native Messaging manifest (Chrome on Mac)
NM_MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.google.shadowshield.json"
if [ ! -f "$NM_MANIFEST" ]; then
    # Try the alternate name
    NM_MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.shadowshield.agent.json"
fi

if [ -f "$NM_MANIFEST" ]; then
    echo "[PASS] Native Messaging manifest exists."
    # check name
    if grep -q '"name": "com.shadowshield.agent"' "$NM_MANIFEST" || grep -q '"name": "com.google.shadowshield"' "$NM_MANIFEST"; then
        echo "[PASS] Native Messaging manifest has correct name."
    else
        echo "[FAIL] Native Messaging manifest name does not match."
    fi
    # check path
    if grep -q "target/debug/shadowshield-native-host" "$NM_MANIFEST"; then
        echo "[PASS] Native Messaging manifest points to correct host path."

        # Extract path and check if executable
        HOST_PATH=$(grep '"path"' "$NM_MANIFEST" | cut -d '"' -f 4)
        if [ -x "$HOST_PATH" ]; then
            echo "[PASS] Configured binary is executable."
        else
            echo "[FAIL] Configured binary in manifest is not executable or not found: $HOST_PATH"
        fi
    else
        echo "[FAIL] Native Messaging manifest path does not point to target/debug/shadowshield-native-host."
    fi
else
    echo "[FAIL] Native Messaging manifest NOT found at expected location."
fi
