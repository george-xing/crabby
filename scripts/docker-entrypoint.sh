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
    },
    "crabby-resy": {
      "command": "node",
      "args": ["dist/mcp/resy-server/index.js"],
      "cwd": "/app",
      "env": {
        "DATA_DIR": "/data",
        "RESY_CREDENTIALS_FILE": "/data/.resy/credentials.json"
      }
    }
  }
}
MCPEOF

# 2. Fix volume permissions (entrypoint runs as root, volume mounted as root)
mkdir -p /data/.gws /data/.claude /data/.resy
chown -R crabby:crabby /data

# 3. Seed Claude Code credentials using hash-based change detection.
# Claude Code auto-refreshes OAuth tokens at runtime (consuming single-use
# refresh tokens), so we must NOT overwrite when the env var hasn't changed.
# A sidecar hash file tracks what was last seeded — if the env var changes
# (user updated it), we overwrite; otherwise we preserve runtime state.
if [ -n "$CLAUDE_OAUTH_CREDENTIALS" ]; then
  CURRENT_HASH=$(printf '%s' "$CLAUDE_OAUTH_CREDENTIALS" | sha256sum | cut -d' ' -f1)
  STORED_HASH=""
  if [ -f /data/.claude/.credentials.seeded_hash ]; then
    STORED_HASH=$(cat /data/.claude/.credentials.seeded_hash)
  fi

  if [ "$CURRENT_HASH" != "$STORED_HASH" ]; then
    printf '%s' "$CLAUDE_OAUTH_CREDENTIALS" > /data/.claude/.credentials.json
    printf '%s' "$CURRENT_HASH" > /data/.claude/.credentials.seeded_hash
    chown crabby:crabby /data/.claude/.credentials.json /data/.claude/.credentials.seeded_hash
    echo "[entrypoint] Seeded Claude credentials from env var (new or updated)"
  else
    echo "[entrypoint] Claude credentials unchanged, preserving runtime state"
  fi
elif [ ! -f /data/.claude/.credentials.json ]; then
  echo "[entrypoint] WARNING: No Claude credentials found. Set CLAUDE_OAUTH_CREDENTIALS env var and redeploy."
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

# 6. Seed Resy credentials
if [ -n "$RESY_CREDENTIALS_B64" ]; then
  echo "$RESY_CREDENTIALS_B64" | base64 -d > /data/.resy/credentials.json
  chown crabby:crabby /data/.resy/credentials.json
fi

# 7. Start the app as non-root user
exec gosu crabby node dist/index.js
