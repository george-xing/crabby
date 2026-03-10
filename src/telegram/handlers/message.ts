import type { Context } from "grammy";
import { handleMessage } from "../../orchestrator/orchestrator.js";

export async function messageHandler(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  if (!text) return;

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // If replying to a specific message, include that as context
  let prompt = text;
  const replyText = ctx.message?.reply_to_message?.text;
  if (replyText) {
    prompt = `[Replying to: "${replyText}"]\n\n${text}`;
  }

  await handleMessage(chatId, prompt, ctx.api);
}
