import type { Api } from "grammy";
import type { ClaudeStreamEvent } from "./subprocess.js";
import { logger } from "../utils/logger.js";

const EDIT_INTERVAL_MS = 500;
const TELEGRAM_MAX_LENGTH = 4096;

export class TelegramStreamer {
  private chatId: number;
  private messageId: number | null = null;
  private api: Api;
  private accumulatedText = "";
  private lastEditedText = "";
  private editTimer: ReturnType<typeof setInterval> | null = null;
  private finished = false;

  constructor(chatId: number, api: Api) {
    this.chatId = chatId;
    this.api = api;
  }

  async start(): Promise<void> {
    const msg = await this.api.sendMessage(this.chatId, "...");
    this.messageId = msg.message_id;

    this.editTimer = setInterval(() => {
      this.flush();
    }, EDIT_INTERVAL_MS);
  }

  onEvent(event: ClaudeStreamEvent): void {
    // Assistant messages have text in message.content[0].text
    if (event.type === "assistant") {
      const message = event.message as
        | { content?: Array<{ type: string; text?: string }> }
        | undefined;
      if (message?.content) {
        for (const block of message.content) {
          if (block.type === "text" && block.text) {
            this.accumulatedText = block.text;
          }
        }
      }
    }

    if (event.type === "result" && typeof event.result === "string") {
      this.accumulatedText = event.result;
    }
  }

  private async flush(): Promise<void> {
    if (!this.messageId) return;
    if (this.accumulatedText === this.lastEditedText) return;
    if (!this.accumulatedText.trim()) return;

    const text = this.truncateForTelegram(this.accumulatedText);

    try {
      await this.api.editMessageText(this.chatId, this.messageId, text, {
        parse_mode: undefined, // plain text during streaming to avoid parse errors
      });
      this.lastEditedText = this.accumulatedText;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Telegram throws if message content hasn't changed
      if (!errorMessage.includes("message is not modified")) {
        logger.warn({ err }, "Failed to edit streaming message");
      }
    }
  }

  reset(): void {
    this.accumulatedText = "";
    this.lastEditedText = "";
  }

  async finish(): Promise<void> {
    this.finished = true;

    if (this.editTimer) {
      clearInterval(this.editTimer);
      this.editTimer = null;
    }

    // Final flush with markdown
    if (this.messageId && this.accumulatedText.trim()) {
      const text = this.truncateForTelegram(this.accumulatedText);
      try {
        await this.api.editMessageText(this.chatId, this.messageId, text);
      } catch {
        // ignore final edit failures
      }

      // If text was truncated, send continuation
      if (this.accumulatedText.length > TELEGRAM_MAX_LENGTH) {
        await this.sendContinuations(this.accumulatedText.slice(TELEGRAM_MAX_LENGTH));
      }
    }
  }

  private truncateForTelegram(text: string): string {
    if (text.length <= TELEGRAM_MAX_LENGTH) return text;
    return text.slice(0, TELEGRAM_MAX_LENGTH - 3) + "...";
  }

  private async sendContinuations(remaining: string): Promise<void> {
    while (remaining.length > 0) {
      const chunk = remaining.slice(0, TELEGRAM_MAX_LENGTH);
      remaining = remaining.slice(TELEGRAM_MAX_LENGTH);

      try {
        await this.api.sendMessage(this.chatId, chunk, {
          reply_parameters: this.messageId
            ? { message_id: this.messageId }
            : undefined,
        });
      } catch (err) {
        logger.error({ err }, "Failed to send continuation message");
        break;
      }
    }
  }
}
