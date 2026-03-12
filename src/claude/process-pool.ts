import { spawn, type ChildProcess } from "node:child_process";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { AuthenticationError, isAuthError, type ClaudeStreamEvent } from "./subprocess.js";

const PROCESS_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per response

interface ManagedProcess {
  child: ChildProcess;
  createdAt: number;
  sessionId: string | null;
  busy: boolean;
  buffer: string;
  stderrBuffer: string;
}

class ClaudeProcessPool {
  private processes = new Map<number, ManagedProcess>();

  async sendMessage(
    chatId: number,
    prompt: string,
    systemPrompt: string,
    onEvent: (event: ClaudeStreamEvent) => void,
  ): Promise<{ sessionId: string | null; result: string }> {
    let proc = this.processes.get(chatId);

    if (proc) {
      if (proc.busy) {
        throw new Error("Process is busy");
      }
      if (Date.now() - proc.createdAt > PROCESS_TTL_MS) {
        logger.info({ chatId }, "Process TTL expired, killing");
        this.killProcess(chatId);
        proc = undefined;
      }
      if (proc && proc.child.exitCode !== null) {
        logger.info({ chatId }, "Process already exited, removing");
        this.processes.delete(chatId);
        proc = undefined;
      }
    }

    if (!proc) {
      proc = this.spawnProcess(chatId, systemPrompt);
      this.processes.set(chatId, proc);
    }

    proc.busy = true;
    try {
      const result = await this.writeAndWaitForResponse(proc, prompt, onEvent);
      proc.busy = false;
      return result;
    } catch (err) {
      proc.busy = false;
      this.killProcess(chatId);
      throw err;
    }
  }

  hasProcess(chatId: number): boolean {
    const proc = this.processes.get(chatId);
    if (!proc) return false;
    if (proc.child.exitCode !== null) {
      this.processes.delete(chatId);
      return false;
    }
    if (Date.now() - proc.createdAt > PROCESS_TTL_MS) {
      this.killProcess(chatId);
      return false;
    }
    return true;
  }

  private spawnProcess(chatId: number, systemPrompt: string): ManagedProcess {
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "--dangerously-skip-permissions",
      "--disallowedTools", "mcp__claude_ai_Google_Calendar__*",
      "--system-prompt", systemPrompt,
    ];

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    if (config.claude.configDir) {
      env.CLAUDE_CONFIG_DIR = config.claude.configDir;
    }

    const child = spawn("claude", args, {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    logger.info({ pid: child.pid, chatId }, "Spawned long-lived Claude process");

    const managed: ManagedProcess = {
      child,
      createdAt: Date.now(),
      sessionId: null,
      busy: false,
      buffer: "",
      stderrBuffer: "",
    };

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        managed.stderrBuffer += text + "\n";
        logger.debug({ stderr: text, chatId }, "Claude process stderr");
      }
    });

    child.on("close", (code) => {
      logger.info({ code, chatId }, "Long-lived Claude process exited");
      this.processes.delete(chatId);
    });

    return managed;
  }

  private writeAndWaitForResponse(
    proc: ManagedProcess,
    prompt: string,
    onEvent: (event: ClaudeStreamEvent) => void,
  ): Promise<{ sessionId: string | null; result: string }> {
    return new Promise((resolve, reject) => {
      let result = "";
      let resolved = false;
      let lastActivity = Date.now();

      const timeoutCheck = setInterval(() => {
        if (Date.now() - lastActivity > RESPONSE_TIMEOUT_MS) {
          cleanup();
          reject(new Error("Claude subprocess timed out"));
        }
      }, 10_000);

      // Track whether we've seen the init event for this turn
      // (each turn starts with a new system/init event)
      let seenInitForThisTurn = false;

      const onData = (data: Buffer) => {
        lastActivity = Date.now();
        proc.buffer += data.toString();
        const lines = proc.buffer.split("\n");
        proc.buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event: ClaudeStreamEvent = JSON.parse(line);

            if (event.type === "system" && event.subtype === "init" && event.session_id) {
              proc.sessionId = event.session_id;
              seenInitForThisTurn = true;
            }

            // Only forward events after init for this turn
            if (seenInitForThisTurn) {
              onEvent(event);
            }

            if (event.type === "result" && typeof event.result === "string") {
              result = event.result;
              cleanup();
              resolved = true;
              resolve({ sessionId: proc.sessionId, result });
            }
          } catch {
            logger.debug({ line }, "Non-JSON line from Claude");
          }
        }
      };

      const onError = (err: Error) => {
        if (resolved) return;
        cleanup();
        reject(err);
      };

      const onClose = (code: number | null) => {
        if (resolved) return;
        cleanup();
        if (code !== 0) {
          if (isAuthError(proc.stderrBuffer)) {
            reject(new AuthenticationError(`Authentication failed: ${proc.stderrBuffer.slice(0, 500)}`));
          } else {
            reject(new Error(`Claude exited with code ${code}`));
          }
        } else {
          resolve({ sessionId: proc.sessionId, result });
        }
      };

      const cleanup = () => {
        clearInterval(timeoutCheck);
        proc.child.stdout?.off("data", onData);
        proc.child.off("error", onError);
        proc.child.off("close", onClose);
      };

      proc.child.stdout?.on("data", onData);
      proc.child.on("error", onError);
      proc.child.on("close", onClose);

      // Write user message to stdin
      const message = JSON.stringify({
        type: "user",
        message: { role: "user", content: prompt },
      }) + "\n";

      proc.child.stdin?.write(message, (err) => {
        if (err) {
          cleanup();
          reject(new Error("Failed to write to Claude stdin"));
        }
      });
    });
  }

  killProcess(chatId: number): void {
    const proc = this.processes.get(chatId);
    if (proc) {
      try {
        proc.child.kill("SIGTERM");
      } catch {
        // ignore kill errors
      }
      this.processes.delete(chatId);
      logger.info({ chatId }, "Killed long-lived Claude process");
    }
  }

  killAll(): void {
    for (const [chatId] of this.processes) {
      this.killProcess(chatId);
    }
  }
}

export const processPool = new ClaudeProcessPool();
