import type { Context } from "grammy";
import { handleMessage } from "../../orchestrator/orchestrator.js";
import { logger } from "../../utils/logger.js";

export async function callbackHandler(ctx: Context): Promise<void> {
  const callbackQuery = ctx.callbackQuery;
  if (!callbackQuery?.data) return;

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // Dismiss the loading spinner immediately
  try {
    await ctx.answerCallbackQuery();
  } catch (err) {
    logger.warn({ err }, "Failed to answer callback query");
  }

  // Extract button label (strip "btn:" prefix)
  const data = callbackQuery.data;
  const selectedLabel = data.startsWith("btn:") ? data.slice(4) : data;

  // Edit the original message to show selection and remove buttons
  if (callbackQuery.message) {
    try {
      const originalText = "text" in callbackQuery.message ? callbackQuery.message.text || "" : "";
      await ctx.api.editMessageText(
        chatId,
        callbackQuery.message.message_id,
        `${originalText}\n\n-> ${selectedLabel}`,
        { reply_markup: { inline_keyboard: [] } },
      );
    } catch (err) {
      logger.debug({ err }, "Failed to edit message after button press");
    }
  }

  // Forward the selected option as a new user message
  await handleMessage(chatId, selectedLabel, ctx.api);
}
