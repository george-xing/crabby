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

  // Add group chat context so Claude knows the social signal
  const isGroupChat = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  if (isGroupChat) {
    const senderName = ctx.from?.first_name || "Someone";
    const botUsername = ctx.me.username;
    // Check entities for @mention (auth middleware strips text but not entities)
    const entities = ctx.message?.entities || [];
    const wasMentioned = entities.some(
      (e) => e.type === "mention" || (e.type === "text_mention" && e.user?.username === botUsername),
    );
    const wasRepliedTo = ctx.message?.reply_to_message?.from?.id === ctx.me.id;

    if (wasMentioned || wasRepliedTo) {
      prompt = `[Group chat — ${senderName} — directed at you] ${prompt}`;
    } else {
      prompt = `[Group chat — ${senderName}] ${prompt}`;
    }
  }

  await handleMessage(chatId, prompt, ctx.api);
}
