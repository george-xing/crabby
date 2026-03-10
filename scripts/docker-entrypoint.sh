#!/bin/sh
set -e

# 1. Write production .mcp.json
cat > /app/.mcp.json << 'MCPEOF'
{
  "mcpServers": {
    "crabby-memory": {
      "command": "node",
      "args": ["dist/mcp/memory-server/index.js"],
      "cwd": "/app",
      "env": {
        "DATA_DIR": "/data"
      }
    },
    "gws": {
      "command": "node",
      "args": ["dist/mcp/gws-server/index.js"],
      "cwd": "/app",
      "env": {
        "GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE": "/data/.gws/credentials.json",
        "GOOGLE_WORKSPACE_CLI_CONFIG_DIR": "/data/.gws"
      }
    },
    "crabby-scheduler": {
      "command": "node",
      "args": ["dist/mcp/scheduler-server/index.js"],
      "cwd": "/app",
      "env": {
        "DATA_DIR": "/data"
      }
    }
  }
}
MCPEOF

# 2. Fix volume permissions (entrypoint runs as root, volume mounted as root)
mkdir -p /data/.gws /data/.claude
chown -R crabby:crabby /data

# 3. Start dbus and gnome-keyring for Claude Code credential storage (as crabby)
export DBUS_SESSION_BUS_ADDRESS=$(gosu crabby dbus-daemon --session --fork --print-address)
eval $(echo '' | gosu crabby gnome-keyring-daemon --unlock --components=secrets 2>/dev/null) || true

# 4. Seed Claude Code OAuth credentials into gnome-keyring
if [ -n "$CLAUDE_OAUTH_CREDENTIALS" ]; then
  echo -n "$CLAUDE_OAUTH_CREDENTIALS" | gosu crabby secret-tool store --label="Claude Code-credentials" service "Claude Code-credentials" account "Claude Code-credentials" 2>/dev/null || true
fi

# 5. Seed gws credentials
if [ -n "$GWS_CREDENTIALS_B64" ]; then
  echo "$GWS_CREDENTIALS_B64" | base64 -d > /data/.gws/credentials.json
fi
if [ -n "$GWS_CLIENT_SECRET_B64" ]; then
  echo "$GWS_CLIENT_SECRET_B64" | base64 -d > /data/.gws/client_secret.json
fi
if [ -n "$GWS_TOKEN_CACHE_B64" ]; then
  echo "$GWS_TOKEN_CACHE_B64" | base64 -d > /data/.gws/token_cache.json
fi
chown -R crabby:crabby /data/.gws

# 6. Start the app as non-root user
exec gosu crabby node dist/index.js
