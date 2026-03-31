#!/bin/bash
# CC Gateway Client Setup
# Run this on each client machine to configure Claude Code to use the gateway.

set -e

echo "=== CC Gateway Client Setup ==="
echo ""

# Prompt for gateway URL and token
read -p "Gateway URL (e.g., https://gateway.office.com:8443): " GATEWAY_URL
read -p "Your bearer token: " BEARER_TOKEN

# Validate
if [[ -z "$GATEWAY_URL" || -z "$BEARER_TOKEN" ]]; then
  echo "Error: Gateway URL and token are required."
  exit 1
fi

# Detect shell config file
if [[ -n "$ZSH_VERSION" ]] || [[ "$SHELL" == */zsh ]]; then
  RC_FILE="$HOME/.zshrc"
elif [[ -n "$BASH_VERSION" ]] || [[ "$SHELL" == */bash ]]; then
  RC_FILE="$HOME/.bashrc"
else
  RC_FILE="$HOME/.profile"
fi

echo ""
echo "Will add to: $RC_FILE"
echo ""

# Build the env block
ENV_BLOCK="
# === CC Gateway ===
export ANTHROPIC_BASE_URL=\"$GATEWAY_URL\"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export ANTHROPIC_CUSTOM_HEADERS=\"Authorization: Bearer $BEARER_TOKEN\"
# === End CC Gateway ==="

echo "Adding environment variables:"
echo "$ENV_BLOCK"
echo ""

read -p "Continue? [y/N] " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
  # Remove old block if present
  sed -i.bak '/# === CC Gateway ===/,/# === End CC Gateway ===/d' "$RC_FILE" 2>/dev/null || true
  echo "$ENV_BLOCK" >> "$RC_FILE"
  echo "Done! Run: source $RC_FILE"
  echo ""
  echo "To verify: echo \$ANTHROPIC_BASE_URL"
else
  echo "Aborted."
fi
