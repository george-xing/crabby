#!/bin/bash
set -e

echo "=== Resy Credentials Setup ==="
echo ""
echo "Press Enter at the API key prompt to use the shared public key."
echo ""

read -p "Resy email: " RESY_EMAIL
read -s -p "Resy password: " RESY_PASSWORD
echo ""
read -p "Resy API key [VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5]: " RESY_API_KEY

if [ -z "$RESY_API_KEY" ]; then
  RESY_API_KEY="VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5"
fi

PROJ_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$PROJ_DIR/.env"
MCP_FILE="$PROJ_DIR/.mcp.json"

# Update .env
if grep -q "^RESY_API_KEY=" "$ENV_FILE" 2>/dev/null; then
  # Remove old Resy lines
  grep -v "^RESY_API_KEY=\|^RESY_EMAIL=\|^RESY_PASSWORD=" "$ENV_FILE" > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
fi

# Append fresh values
cat >> "$ENV_FILE" << EOF

# Resy
RESY_API_KEY=$RESY_API_KEY
RESY_EMAIL=$RESY_EMAIL
RESY_PASSWORD=$RESY_PASSWORD
EOF

echo "Updated $ENV_FILE"

# Update .mcp.json using node for safe JSON handling
node -e "
const fs = require('fs');
const mcp = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
mcp.mcpServers['crabby-resy'].env.RESY_API_KEY = process.argv[2];
mcp.mcpServers['crabby-resy'].env.RESY_EMAIL = process.argv[3];
mcp.mcpServers['crabby-resy'].env.RESY_PASSWORD = process.argv[4];
fs.writeFileSync(process.argv[1], JSON.stringify(mcp, null, 2) + '\n');
" "$MCP_FILE" "$RESY_API_KEY" "$RESY_EMAIL" "$RESY_PASSWORD"

echo "Updated $MCP_FILE"
echo ""
echo "Done! Resy credentials configured."
