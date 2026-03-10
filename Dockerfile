FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:20-slim
WORKDIR /app

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install build tools (for better-sqlite3), dbus + gnome-keyring (for Claude auth on Linux)
COPY package*.json ./
RUN apt-get update && \
    apt-get install -y python3 make g++ dbus gnome-keyring libsecret-1-0 libsecret-tools && \
    npm ci --omit=dev && \
    apt-get purge -y python3 make g++ && apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY scripts/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Run as non-root (Claude Code refuses --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/sh crabby && \
    mkdir -p /data && \
    chown -R crabby:crabby /app /data
USER crabby

ENTRYPOINT ["/docker-entrypoint.sh"]
