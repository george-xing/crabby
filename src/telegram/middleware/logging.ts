import type { Context, NextFunction } from "grammy";
import { logger } from "../../utils/logger.js";

export async function loggingMiddleware(
  ctx: Context,
  next: NextFunction,
): Promise<void> {
  const start = Date.now();
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  const text = ctx.message?.text?.slice(0, 50);

  logger.info({ chatId, userId, text }, "Incoming message");

  await next();

  logger.info({ chatId, durationMs: Date.now() - start }, "Message handled");
}
