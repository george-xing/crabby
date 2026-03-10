import type { Api } from "grammy";
import { spawnClaude } from "../claude/subprocess.js";
import { getSessionId, saveSessionId } from "../claude/session-manager.js";
import { buildSystemPrompt } from "../claude/system-prompt.js";
import { TelegramStreamer } from "../claude/streaming.js";
import { logger } from "../utils/logger.js";

// Per-chat processing queue to serialize messages within a chat
const chatQueues = new Map<number, Promise<void>>();

export async function handleMessage(
  chatId: number,
  text: string,
  api: Api,
): Promise<void> {
  // Serialize messages per chat
  const prev = chatQueues.get(chatId) || Promise.resolve();
  const next = prev.then(() => processMessage(chatId, text, api)).catch((err) => {
    logger.error({ err, chatId }, "Error processing message");
  });
  chatQueues.set(chatId, next);
}

async function processMessage(
  chatId: number,
  text: string,
  api: Api,
): Promise<void> {
  const streamer = new TelegramStreamer(chatId, api);

  try {
    await streamer.start();

    const resumeSessionId = getSessionId(chatId);
    const systemPrompt = buildSystemPrompt(chatId);

    try {
      // Try with session resume first
      const { sessionId } = await spawnClaude(
        {
          prompt: text,
          systemPrompt,
          resumeSessionId: resumeSessionId || undefined,
        },
        (event) => streamer.onEvent(event),
      );

      if (sessionId) {
        saveSessionId(chatId, sessionId);
      }
    } catch (err) {
      // If resume failed, retry without resume (fresh session)
      if (resumeSessionId) {
        logger.warn({ chatId }, "Resume failed, retrying with fresh session");
        streamer.reset();

        const { sessionId } = await spawnClaude(
          {
            prompt: text,
            systemPrompt,
          },
          (event) => streamer.onEvent(event),
        );

        if (sessionId) {
          saveSessionId(chatId, sessionId);
        }
      } else {
        throw err;
      }
    }
  } catch (err) {
    logger.error({ err, chatId }, "Claude subprocess failed");
    try {
      await api.sendMessage(
        chatId,
        "Sorry, I encountered an error processing your message. Please try again.",
      );
    } catch {
      // ignore send failure
    }
  } finally {
    await streamer.finish();
  }
}
