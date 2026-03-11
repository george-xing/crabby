import { Bot } from "grammy";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { authMiddleware } from "./middleware/auth.js";
import { loggingMiddleware } from "./middleware/logging.js";
import { messageHandler } from "./handlers/message.js";
import { voiceHandler } from "./handlers/voice.js";
import { callbackHandler } from "./handlers/callback.js";
import { startCommand, statusCommand, newSessionCommand, remindersCommand } from "./handlers/command.js";

export function createBot(): Bot {
  const bot = new Bot(config.telegram.botToken);

  // Middleware stack
  bot.use(loggingMiddleware);
  bot.use(authMiddleware);

  // Commands
  bot.command("start", startCommand);
  bot.command("help", startCommand);
  bot.command("status", statusCommand);
  bot.command("new", newSessionCommand);
  bot.command("reminders", remindersCommand);

  // Text messages → orchestrator
  bot.on("message:text", messageHandler);

  // Voice messages → transcribe → orchestrator
  bot.on("message:voice", voiceHandler);

  // Inline keyboard button presses
  bot.on("callback_query:data", callbackHandler);

  // Error handler
  bot.catch((err) => {
    logger.error({ err: err.error, ctx: err.ctx?.update?.update_id }, "Bot error");
  });

  return bot;
}

export async function startBot(bot: Bot): Promise<void> {
  logger.info("Starting Telegram bot with long-polling");
  await bot.start({
    onStart: () => logger.info("Bot is running"),
  });
}

export function stopBot(bot: Bot): void {
  bot.stop();
  logger.info("Bot stopped");
}
