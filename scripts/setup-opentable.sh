#!/bin/bash
set -e

echo "=== OpenTable Credentials Setup ==="
echo ""
echo "You need to extract credentials from your browser. Steps:"
echo ""
echo "1. Log into OpenTable in your browser (opentable.com)"
echo "2. Open Dev Tools (F12) -> Network tab"
echo "3. Search for a restaurant on OpenTable"
echo "4. Find any request to opentable.com/dapi in the Network tab"
echo "5. Copy the values below from the request headers"
echo ""

read -p "X-Csrf-Token (from request headers): " OPENTABLE_CSRF_TOKEN
read -p "Cookie (full Cookie header value): " OPENTABLE_COOKIES
read -p "GPID / Diner ID (from request payload, optional): " OPENTABLE_GPID
echo ""
echo "--- Personal info (needed for booking) ---"
read -p "First name: " OPENTABLE_FIRST_NAME
read -p "Last name: " OPENTABLE_LAST_NAME
read -p "Email: " OPENTABLE_EMAIL
read -p "Phone (e.g. +12125551234): " OPENTABLE_PHONE

PROJ_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$PROJ_DIR/.env"
MCP_FILE="$PROJ_DIR/.mcp.json"

# Update .env - remove old OpenTable lines if present
if grep -q "^OPENTABLE_CSRF_TOKEN=" "$ENV_FILE" 2>/dev/null; then
  grep -v "^OPENTABLE_CSRF_TOKEN=\|^OPENTABLE_COOKIES=\|^OPENTABLE_GPID=\|^OPENTABLE_FIRST_NAME=\|^OPENTABLE_LAST_NAME=\|^OPENTABLE_EMAIL=\|^OPENTABLE_PHONE=" "$ENV_FILE" > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
fi

# Append fresh values
cat >> "$ENV_FILE" << EOF

# OpenTable
OPENTABLE_CSRF_TOKEN=$OPENTABLE_CSRF_TOKEN
OPENTABLE_COOKIES=$OPENTABLE_COOKIES
OPENTABLE_GPID=$OPENTABLE_GPID
OPENTABLE_FIRST_NAME=$OPENTABLE_FIRST_NAME
OPENTABLE_LAST_NAME=$OPENTABLE_LAST_NAME
OPENTABLE_EMAIL=$OPENTABLE_EMAIL
OPENTABLE_PHONE=$OPENTABLE_PHONE
EOF

echo "Updated $ENV_FILE"

# Update .mcp.json using node for safe JSON handling
node -e "
const fs = require('fs');
const mcp = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
const env = mcp.mcpServers['crabby-opentable'].env;
env.OPENTABLE_CSRF_TOKEN = process.argv[2];
env.OPENTABLE_COOKIES = process.argv[3];
env.OPENTABLE_GPID = process.argv[4];
env.OPENTABLE_FIRST_NAME = process.argv[5];
env.OPENTABLE_LAST_NAME = process.argv[6];
env.OPENTABLE_EMAIL = process.argv[7];
env.OPENTABLE_PHONE = process.argv[8];
fs.writeFileSync(process.argv[1], JSON.stringify(mcp, null, 2) + '\n');
" "$MCP_FILE" "$OPENTABLE_CSRF_TOKEN" "$OPENTABLE_COOKIES" "$OPENTABLE_GPID" "$OPENTABLE_FIRST_NAME" "$OPENTABLE_LAST_NAME" "$OPENTABLE_EMAIL" "$OPENTABLE_PHONE"

echo "Updated $MCP_FILE"
echo ""
echo "Done! OpenTable credentials configured."
echo ""
echo "NOTE: CSRF tokens and cookies expire. If you get auth errors,"
echo "re-run this script with fresh values from your browser."
