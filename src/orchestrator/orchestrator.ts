import type { Api } from "grammy";
import { spawnClaude } from "../claude/subprocess.js";
import { processPool } from "../claude/process-pool.js";
import { getSessionId, saveSessionId, getMessageCount, saveMessage, getRecentMessages, pruneMessages, getResumeFailures, incrementResumeFailures } from "../claude/session-manager.js";
import { buildSystemPrompt } from "../claude/system-prompt.js";
import { TelegramStreamer } from "../claude/streaming.js";
import { logger } from "../utils/logger.js";

// Per-chat processing queue to serialize messages within a chat
const chatQueues = new Map<number, Promise<void>>();

function currentTimePrefix(): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: process.env.TIMEZONE || "America/New_York",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `[Current time: ${timeStr}]\n\n`;
}
// Track which chats have an in-progress Claude call
const chatProcessing = new Set<number>();

export async function handleMessage(
  chatId: number,
  text: string,
  api: Api,
): Promise<void> {
  // Notify user if their message is queued behind an in-progress call
  // Skip notification for group chat messages (Claude may be silently processing)
  const isGroupMessage = text.startsWith("[Group chat");
  if (chatProcessing.has(chatId) && !isGroupMessage) {
    try {
      await api.sendMessage(chatId, "(Got it, finishing up your previous message first...)");
    } catch {
      // ignore
    }
  }

  // Serialize messages per chat
  const prev = chatQueues.get(chatId) || Promise.resolve();
  const next = prev.then(() => processMessage(chatId, text, api)).catch((err) => {
    logger.error({ err, chatId }, "Error processing message");
  });
  chatQueues.set(chatId, next);
}

function buildContextPreamble(chatId: number, userPrompt: string): string {
  const messages = getRecentMessages(chatId, 30);
  if (messages.length === 0) return userPrompt;

  const MAX_CHARS = 8000;
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
  chatProcessing.add(chatId);
  const streamer = new TelegramStreamer(chatId, api);

  try {
    await streamer.start();

    const messageCount = getMessageCount(chatId);
    const systemPrompt = buildSystemPrompt(chatId, messageCount);

    // Record user message before spawning
    saveMessage(chatId, "user", text);

    let result = "";

    // Try the long-lived process pool first (eliminates MCP startup overhead)
    try {
      const isNewProcess = !processPool.hasProcess(chatId);
      // For new processes, inject context preamble so Claude has conversation history
      const basePrompt = isNewProcess ? buildContextPreamble(chatId, text) : text;
      // Prepend current time so Claude always knows the time, even in long-lived sessions
      const prompt = currentTimePrefix() + basePrompt;

      const response = await processPool.sendMessage(
        chatId,
        prompt,
        systemPrompt,
        (event) => streamer.onEvent(event),
      );

      if (response.sessionId) {
        saveSessionId(chatId, response.sessionId);
      }
      result = response.result;
    } catch (poolErr) {
      // Process pool failed — fall back to one-shot subprocess
      logger.warn({ err: poolErr, chatId }, "Process pool failed, falling back to one-shot");
      streamer.reset();

      result = await fallbackOneShot(chatId, text, systemPrompt, messageCount, streamer);
    }

    // Check if Claude chose to stay silent (group chat behavior)
    if (result.trim() === "[SKIP]" || result.trim() === "") {
      saveMessage(chatId, "assistant", "[stayed silent]");
      pruneMessages(chatId, 50);
      // Reset streamer so finish() doesn't send [SKIP] to Telegram
      streamer.reset();
      return;
    }

    // Record assistant response
    if (result) {
      saveMessage(chatId, "assistant", result);
    }
    pruneMessages(chatId, 50);
  } catch (err) {
    logger.error({ err, chatId }, "Claude subprocess failed");
    const errorMessage = err instanceof Error ? err.message : String(err);
    let userMessage = "Sorry, I encountered an error processing your message. Please try again.";
    if (errorMessage.includes("timed out")) {
      userMessage = "Sorry, that took too long and timed out. Try a simpler request, or /new to start fresh.";
    } else if (errorMessage.includes("exited with code")) {
      userMessage = "Sorry, something went wrong. Try again, or /new to start a fresh session.";
    }
    try {
      await api.sendMessage(chatId, userMessage);
    } catch {
      // ignore send failure
    }
  } finally {
    chatProcessing.delete(chatId);
    await streamer.finish();
  }
}

/** Original one-shot subprocess logic as fallback */
async function fallbackOneShot(
  chatId: number,
  text: string,
  systemPrompt: string,
  messageCount: number,
  streamer: TelegramStreamer,
): Promise<string> {
  const resumeSessionId = getSessionId(chatId);

  const shouldRotate = messageCount > 50;
  const shouldSkipForFailures = getResumeFailures(chatId) >= 2;
  const skipResume = shouldRotate || shouldSkipForFailures;

  if (skipResume && resumeSessionId) {
    logger.info({ chatId, messageCount, rotate: shouldRotate, failures: shouldSkipForFailures }, "Skipping session resume");
  }

  try {
    if (skipResume) {
      const augmentedPrompt = buildContextPreamble(chatId, text);
      const response = await spawnClaude(
        { prompt: augmentedPrompt, systemPrompt },
        (event) => streamer.onEvent(event),
      );
      if (response.sessionId) saveSessionId(chatId, response.sessionId);
      return response.result;
    } else {
      const response = await spawnClaude(
        { prompt: text, systemPrompt, resumeSessionId: resumeSessionId || undefined },
        (event) => streamer.onEvent(event),
      );
      if (response.sessionId) saveSessionId(chatId, response.sessionId);
      return response.result;
    }
  } catch (err) {
    if (resumeSessionId && !skipResume) {
      logger.warn({ chatId }, "Resume failed, retrying with fresh session");
      incrementResumeFailures(chatId);
      streamer.reset();

      const augmentedPrompt = buildContextPreamble(chatId, text);
      const response = await spawnClaude(
        { prompt: augmentedPrompt, systemPrompt },
        (event) => streamer.onEvent(event),
      );
      if (response.sessionId) saveSessionId(chatId, response.sessionId);
      return response.result;
    }
    throw err;
  }
}
