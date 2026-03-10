import type { Context, NextFunction } from "grammy";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

export async function authMiddleware(
  ctx: Context,
  next: NextFunction,
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const chatType = ctx.chat?.type;

  // Group chats: only respond when bot is mentioned
  if (chatType === "group" || chatType === "supergroup") {
    const text = ctx.message?.text || "";
    const botUsername = ctx.me.username;
    const isMentioned =
      text.includes(`@${botUsername}`) ||
      ctx.message?.reply_to_message?.from?.id === ctx.me.id;

    if (!isMentioned) return;

    // Strip the @mention from the message text for cleaner processing
    if (ctx.message && ctx.message.text) {
      ctx.message.text = ctx.message.text
        .replace(new RegExp(`@${botUsername}\\s*`, "g"), "")
        .trim();
    }

    await next();
    return;
  }

  // DMs: whitelist check
  if (chatType === "private") {
    if (!config.telegram.allowedUserIds.includes(userId)) {
      logger.info({ userId }, "Rejected DM from non-whitelisted user");
      return;
    }

    await next();
    return;
  }
}
