import type { Api } from "grammy";
import type { ClaudeStreamEvent } from "./subprocess.js";
import { logger } from "../utils/logger.js";

const EDIT_INTERVAL_MS = 300;
const TELEGRAM_MAX_LENGTH = 4096;
const TYPING_INTERVAL_MS = 4000;

export class TelegramStreamer {
  private chatId: number;
  private messageId: number | null = null;
  private api: Api;
  private accumulatedText = "";
  private lastEditedText = "";
  private editTimer: ReturnType<typeof setInterval> | null = null;
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private finished = false;
  private hasContent = false;
  private creatingMessage = false;

  constructor(chatId: number, api: Api) {
    this.chatId = chatId;
    this.api = api;
  }

  async start(): Promise<void> {
    // Send typing indicator immediately for instant feedback
    try {
      await this.api.sendChatAction(this.chatId, "typing");
    } catch {
      // ignore typing indicator failures
    }

    // Keep typing indicator alive (Telegram expires it after ~5s)
    this.typingTimer = setInterval(() => {
      if (!this.hasContent) {
        this.api.sendChatAction(this.chatId, "typing").catch(() => {});
      }
    }, TYPING_INTERVAL_MS);

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
            const wasEmpty = !this.accumulatedText;
            this.accumulatedText = block.text;
            // Flush immediately on first content for minimum latency
            if (wasEmpty && this.accumulatedText) {
              this.onFirstContent();
            }
          }
        }
      }
    }

    if (event.type === "result" && typeof event.result === "string") {
      const wasEmpty = !this.accumulatedText;
      this.accumulatedText = event.result;
      if (wasEmpty && this.accumulatedText) {
        this.onFirstContent();
      }
    }
  }

  private onFirstContent(): void {
    this.hasContent = true;
    // Stop typing indicator
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
    // Flush immediately instead of waiting for next interval
    this.flush();
  }

  private async flush(): Promise<void> {
    if (this.accumulatedText === this.lastEditedText) return;
    if (!this.accumulatedText.trim()) return;

    // Create message on first flush if it hasn't been sent yet
    if (!this.messageId) {
      if (this.creatingMessage) return;
      this.creatingMessage = true;
      try {
        const text = this.truncateForTelegram(this.accumulatedText);
        const msg = await this.api.sendMessage(this.chatId, text);
        this.messageId = msg.message_id;
        this.lastEditedText = this.accumulatedText;
      } catch (err) {
        logger.warn({ err }, "Failed to send initial streaming message");
      } finally {
        this.creatingMessage = false;
      }
      return;
    }

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
    this.hasContent = false;
  }

  async finish(): Promise<void> {
    this.finished = true;

    if (this.editTimer) {
      clearInterval(this.editTimer);
      this.editTimer = null;
    }
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
    // Final flush
    if (this.accumulatedText.trim()) {
      // Ensure we have a message to edit
      if (!this.messageId && !this.creatingMessage) {
        this.creatingMessage = true;
        try {
          const text = this.truncateForTelegram(this.accumulatedText);
          const msg = await this.api.sendMessage(this.chatId, text);
          this.messageId = msg.message_id;
          this.lastEditedText = this.accumulatedText;
        } catch {
          // ignore
        } finally {
          this.creatingMessage = false;
        }
      }

      if (this.messageId) {
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
  }

  private truncateForTelegram(text: string): string {
    if (text.length <= TELEGRAM_MAX_LENGTH) return text;
    return text.slice(0, TELEGRAM_MAX_LENGTH - 3) + "...";
  }

  private splitAtBoundary(text: string, maxLen: number): [string, string] {
    if (text.length <= maxLen) return [text, ""];

    // Try to split at the last newline within the limit
    const lastNewline = text.lastIndexOf("\n", maxLen);
    if (lastNewline > maxLen * 0.5) {
      return [text.slice(0, lastNewline), text.slice(lastNewline + 1)];
    }

    // Fall back to last sentence boundary (. ! ?)
    const chunk = text.slice(0, maxLen);
    const lastSentence = Math.max(
      chunk.lastIndexOf(". "),
      chunk.lastIndexOf("! "),
      chunk.lastIndexOf("? "),
    );
    if (lastSentence > maxLen * 0.5) {
      const splitAt = lastSentence + 2;
      return [text.slice(0, splitAt), text.slice(splitAt)];
    }

    // Last resort: hard split at limit
    return [text.slice(0, maxLen), text.slice(maxLen)];
  }

  private async sendContinuations(remaining: string): Promise<void> {
    while (remaining.length > 0) {
      const [chunk, rest] = this.splitAtBoundary(remaining, TELEGRAM_MAX_LENGTH);
      remaining = rest;

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
