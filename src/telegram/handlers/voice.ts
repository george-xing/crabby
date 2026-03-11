import type { Context } from "grammy";
import { config } from "../../config.js";
import { handleMessage } from "../../orchestrator/orchestrator.js";
import { logger } from "../../utils/logger.js";

export async function voiceHandler(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const voice = ctx.message?.voice;
  if (!voice) return;

  if (!config.openai.apiKey) {
    await ctx.reply("Voice messages aren't set up yet (missing OpenAI API key).");
    return;
  }

  if (voice.duration > 600) {
    await ctx.reply("That voice message is too long (max ~10 minutes). Try a shorter one.");
    return;
  }

  try {
    // Download voice file from Telegram
    const file = await ctx.api.getFile(voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;

    const audioResponse = await fetch(fileUrl);
    if (!audioResponse.ok) {
      throw new Error(`Failed to download voice file: ${audioResponse.status}`);
    }
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

    // Transcribe with Whisper API
    const transcription = await transcribeAudio(audioBuffer, file.file_path || "voice.ogg");

    if (!transcription.trim()) {
      await ctx.reply("I couldn't make out any words in that voice message. Could you try again?");
      return;
    }

    // Build prompt with group chat context if applicable
    let prompt = `[Voice message] ${transcription}`;
    const isGroupChat = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
    if (isGroupChat) {
      const senderName = ctx.from?.first_name || "Someone";
      prompt = `[Group chat — ${senderName} — voice message] ${transcription}`;
    }

    await handleMessage(chatId, prompt, ctx.api);
  } catch (err) {
    logger.error({ err, chatId }, "Voice transcription failed");
    await ctx.reply("Sorry, I couldn't process that voice message. Try again or type your message instead.");
  }
}

async function transcribeAudio(audioBuffer: Buffer, filename: string): Promise<string> {
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: "audio/ogg" });
  formData.append("file", blob, filename);
  formData.append("model", "whisper-1");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Whisper API error ${response.status}: ${errorText}`);
  }

  const result = (await response.json()) as { text: string };
  return result.text;
}
