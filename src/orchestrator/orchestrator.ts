import type { Api } from "grammy";
import { spawnClaude } from "../claude/subprocess.js";
import { getSessionId, saveSessionId, getMessageCount, saveMessage, getRecentMessages, pruneMessages } from "../claude/session-manager.js";
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

function buildContextPreamble(chatId: number, userPrompt: string): string {
  const messages = getRecentMessages(chatId, 10);
  if (messages.length === 0) return userPrompt;

  const MAX_CHARS = 4000;
  let budget = MAX_CHARS;
  const selected: Array<{ role: string; content: string }> = [];

  // Build from newest first to prioritize recent context
  for (let i = messages.length - 1; i >= 0 && budget > 0; i--) {
    const msg = messages[i];
    const line = `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`;
    if (line.length > budget) break;
    selected.unshift(msg);
    budget -= line.length + 1;
  }

  if (selected.length === 0) return userPrompt;

  let preamble = "[Previous conversation context -- session was refreshed]\n\n";
  for (const msg of selected) {
    preamble += `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}\n\n`;
  }
  preamble += "[New message follows]\n\n" + userPrompt;
  return preamble;
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
    const messageCount = getMessageCount(chatId);
    const systemPrompt = buildSystemPrompt(chatId, messageCount);

    // Record user message before spawning
    saveMessage(chatId, "user", text);

    let result = "";

    try {
      // Try with session resume first
      const response = await spawnClaude(
        {
          prompt: text,
          systemPrompt,
          resumeSessionId: resumeSessionId || undefined,
        },
        (event) => streamer.onEvent(event),
      );

      if (response.sessionId) {
        saveSessionId(chatId, response.sessionId);
      }
      result = response.result;
    } catch (err) {
      // If resume failed, retry without resume (fresh session)
      if (resumeSessionId) {
        logger.warn({ chatId }, "Resume failed, retrying with fresh session");
        streamer.reset();

        // Notify user
        await api.sendMessage(chatId, "(Session refreshed — continuing with recent context)");

        // Inject recent conversation history into the prompt
        const augmentedPrompt = buildContextPreamble(chatId, text);

        const response = await spawnClaude(
          {
            prompt: augmentedPrompt,
            systemPrompt,
          },
          (event) => streamer.onEvent(event),
        );

        if (response.sessionId) {
          saveSessionId(chatId, response.sessionId);
        }
        result = response.result;
      } else {
        throw err;
      }
    }

    // Record assistant response
    if (result) {
      saveMessage(chatId, "assistant", result);
    }
    pruneMessages(chatId, 20);
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
