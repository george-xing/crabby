import type { Context, NextFunction } from "grammy";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

export async function authMiddleware(
  ctx: Context,
  next: NextFunction,
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  // Callback queries from whitelisted users (inline keyboard buttons)
  if (ctx.callbackQuery) {
    if (config.telegram.allowedUserIds.includes(userId)) {
      await next();
    }
    return;
  }

  const chatType = ctx.chat?.type;

  // Group chats: must be whitelisted group + whitelisted user
  if (chatType === "group" || chatType === "supergroup") {
    const groupId = ctx.chat!.id;
    if (!config.telegram.allowedGroupIds.includes(groupId)) return;
    if (!config.telegram.allowedUserIds.includes(userId)) return;

    // Strip @mentions from text for cleaner processing
    if (ctx.message && "text" in ctx.message && ctx.message.text) {
      const botUsername = ctx.me.username;
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
