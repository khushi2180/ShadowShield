#!/usr/bin/env bash
set -e

# ShadowShield — macOS Native Messaging Host Setup Script
# Use this script to set up the development environment for Chrome Native Messaging.

if [ -z "$1" ]; then
    echo "Error: Extension ID argument is required."
    echo "Usage: ./scripts/setup-native-host-macos.sh <EXTENSION_ID>"
    echo ""
    echo "To find your Extension ID:"
    echo "1. Open Chrome and go to chrome://extensions/"
    echo "2. Enable 'Developer mode'"
    echo "3. Load unpacked extension from apps/extension/"
    echo "4. Copy the generated ID"
    exit 1
fi

EXTENSION_ID="$1"

# Reject placeholders
if [[ "$EXTENSION_ID" == "test-ext-id" || "$EXTENSION_ID" == "YOUR_ACTUAL_EXTENSION_ID" || "$EXTENSION_ID" == "YOUR_REAL_EXTENSION_ID" || "$EXTENSION_ID" == "CURRENT_EXTENSION_ID" ]]; then
    echo "Error: Please provide a real Extension ID, not a placeholder."
    exit 1
fi

# Validate extension ID format (32 lowercase a-p characters)
if ! [[ "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
    echo "Error: Invalid Extension ID format. Must be 32 lowercase characters (a-p)."
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_BINARY="$REPO_ROOT/target/debug/shadowshield-native-host"

if [ ! -f "$AGENT_BINARY" ]; then
    echo "Error: Native host binary not found at $AGENT_BINARY"
    echo "Please build it first: cargo build --workspace"
    exit 1
fi

if [ ! -x "$AGENT_BINARY" ]; then
    echo "Error: Binary is not executable: $AGENT_BINARY"
    exit 1
fi

# Define Chrome Native Messaging Hosts directory for macOS
CHROME_NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_NAME="com.shadowshield.agent.json"
MANIFEST_DEST="$CHROME_NM_DIR/$MANIFEST_NAME"

echo "Setting up macOS Native Messaging Host..."
echo "Agent Path:   $AGENT_BINARY"

# Create destination directory if it doesn't exist
mkdir -p "$CHROME_NM_DIR"

# Generate the manifest from the template in installers/macos/native-messaging
TEMPLATE_FILE="$REPO_ROOT/installers/macos/native-messaging/com.shadowshield.agent.json"

if [ ! -f "$TEMPLATE_FILE" ]; then
    echo "Error: Manifest template not found at $TEMPLATE_FILE"
    exit 1
fi

# Substitute the placeholders with actual absolute path and extension ID
sed -e "s|<REPLACE_WITH_ABSOLUTE_PATH_TO_NATIVE_HOST_BINARY>|$AGENT_BINARY|g" \
    -e "s|<REPLACE_WITH_EXTENSION_ID>|$EXTENSION_ID|g" \
    "$TEMPLATE_FILE" > "$MANIFEST_DEST"

echo "Successfully wrote native host manifest to: $MANIFEST_DEST"
echo "You can verify the configuration with:"
echo "cat \"$MANIFEST_DEST\""
