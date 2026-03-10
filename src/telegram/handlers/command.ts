import type { Context } from "grammy";
import { getJobsForChat } from "../../scheduler/persistence.js";
import { clearSession } from "../../claude/session-manager.js";

export async function startCommand(ctx: Context): Promise<void> {
  await ctx.reply(
    "Hey! I'm Crabby, your personal AI assistant. Just send me a message and I'll help out.\n\nCommands:\n/status — uptime & memory\n/reminders — list active reminders\n/new — start a fresh conversation",
  );
}

export async function statusCommand(ctx: Context): Promise<void> {
  const uptime = Math.floor(process.uptime());
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const memory = Math.round(process.memoryUsage.rss() / 1024 / 1024);

  await ctx.reply(
    `Status: Running\nUptime: ${hours}h ${minutes}m\nMemory: ${memory}MB`,
  );
}

export async function newSessionCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  clearSession(chatId);
  await ctx.reply("Fresh session started. Previous conversation context has been cleared, but my memories are still intact.");
}

export async function remindersCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const jobs = getJobsForChat(chatId);

  if (jobs.length === 0) {
    await ctx.reply("No active reminders or scheduled jobs.");
    return;
  }

  const lines = jobs.map((j) => {
    const schedule = j.cron_expression || j.run_at || "—";
    return `#${j.id} [${j.type}] ${schedule}\n  ${j.message}`;
  });

  await ctx.reply(lines.join("\n\n"));
}
