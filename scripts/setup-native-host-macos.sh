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
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_BINARY="$REPO_ROOT/target/debug/shadowshield-agent"

if [ ! -f "$AGENT_BINARY" ]; then
    echo "Error: Agent binary not found at $AGENT_BINARY"
    echo "Please build it first: cargo build --workspace"
    exit 1
fi

# Define Chrome Native Messaging Hosts directory for macOS
CHROME_NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_NAME="com.shadowshield.agent.json"
MANIFEST_DEST="$CHROME_NM_DIR/$MANIFEST_NAME"

echo "Setting up macOS Native Messaging Host..."
echo "Extension ID: $EXTENSION_ID"
echo "Agent Path:   $AGENT_BINARY"

# Create destination directory if it doesn't exist
mkdir -p "$CHROME_NM_DIR"

# Generate the manifest from the template in installers/macos
TEMPLATE_FILE="$REPO_ROOT/installers/macos/com.shadowshield.agent.json"

if [ ! -f "$TEMPLATE_FILE" ]; then
    echo "Error: Manifest template not found at $TEMPLATE_FILE"
    exit 1
fi

# Substitute the placeholders with actual absolute path and extension ID
# We use sed to replace the placeholder values. The template has:
# "path": "/usr/local/bin/shadowshield-agent",
# "allowed_origins": [ "chrome-extension://<EXTENSION_ID>/" ]
# Wait, let's just generate it directly since we know the exact format needed for development.

cat > "$MANIFEST_DEST" <<EOF
{
  "name": "com.shadowshield.agent",
  "description": "ShadowShield Agent Native Messaging Host",
  "path": "$AGENT_BINARY",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo "Successfully wrote native host manifest to: $MANIFEST_DEST"
echo "You can verify the configuration with:"
echo "cat \"$MANIFEST_DEST\""
