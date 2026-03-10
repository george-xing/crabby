import { spawn, type ChildProcess } from "node:child_process";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  content?: string;
  session_id?: string;
  result?: string;
  [key: string]: unknown;
}

export interface ClaudeOptions {
  prompt: string;
  systemPrompt?: string;
  resumeSessionId?: string;
  cwd?: string;
  timeoutMs?: number;
}

export function spawnClaude(
  options: ClaudeOptions,
  onEvent: (event: ClaudeStreamEvent) => void,
): Promise<{ sessionId: string | null; result: string }> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", options.prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "--dangerously-skip-permissions",
      "--disallowedTools", "mcp__claude_ai_Google_Calendar__*",
    ];

    if (options.systemPrompt) {
      args.push("--system-prompt", options.systemPrompt);
    }

    if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
    }

    const env: Record<string, string> = { ...process.env } as Record<
      string,
      string
    >;
    // Allow spawning Claude from within a Claude Code session
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    if (config.claude.configDir) {
      env.CLAUDE_CONFIG_DIR = config.claude.configDir;
    }

    logger.info({ args }, "Spawning Claude subprocess");

    const child: ChildProcess = spawn("claude", args, {
      cwd: options.cwd || process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    logger.info({ pid: child.pid }, "Claude subprocess started");

    // Close stdin immediately — we pass everything via args
    child.stdin?.end();

    let sessionId: string | null = null;
    let result = "";
    let buffer = "";

    const timeoutMs = options.timeoutMs || 5 * 60 * 1000;
    let lastActivity = Date.now();

    const timeoutCheck = setInterval(() => {
      if (Date.now() - lastActivity > timeoutMs) {
        logger.warn("Claude subprocess timed out, killing");
        child.kill("SIGTERM");
        clearInterval(timeoutCheck);
        reject(new Error("Claude subprocess timed out"));
      }
    }, 10_000);

    child.stdout?.on("data", (data: Buffer) => {
      lastActivity = Date.now();
      const chunk = data.toString();
      logger.debug({ chunkLen: chunk.length }, "Claude stdout chunk");
      buffer += chunk;

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event: ClaudeStreamEvent = JSON.parse(line);
          onEvent(event);

          if (event.type === "system" && event.subtype === "init" && event.session_id) {
            sessionId = event.session_id;
          }

          if (event.type === "result" && typeof event.result === "string") {
            result = event.result;
          }
        } catch {
          logger.debug({ line }, "Non-JSON line from Claude");
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      lastActivity = Date.now();
      const text = data.toString().trim();
      if (text) {
        logger.warn({ stderr: text }, "Claude stderr");
      }
    });

    child.on("close", (code) => {
      clearInterval(timeoutCheck);

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const event: ClaudeStreamEvent = JSON.parse(buffer);
          onEvent(event);
          if (event.type === "result" && typeof event.result === "string") {
            result = event.result;
          }
        } catch {
          // ignore
        }
      }

      if (code !== 0) {
        logger.error({ code }, "Claude exited with non-zero code");
        reject(new Error(`Claude exited with code ${code}`));
        return;
      }

      resolve({ sessionId, result });
    });

    child.on("error", (err) => {
      clearInterval(timeoutCheck);
      logger.error({ err }, "Failed to spawn Claude");
      reject(err);
    });
  });
}
