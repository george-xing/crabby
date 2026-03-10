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

# Install build tools (for better-sqlite3 native addon)
COPY package*.json ./
RUN apt-get update && \
    apt-get install -y python3 make g++ gosu && \
    npm ci --omit=dev && \
    apt-get purge -y python3 make g++ && apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY scripts/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Create non-root user (Claude Code refuses --dangerously-skip-permissions as root)
# Entrypoint runs as root to fix volume perms, then drops to crabby user
RUN useradd -m -s /bin/sh crabby && \
    chown -R crabby:crabby /app

ENTRYPOINT ["/docker-entrypoint.sh"]
