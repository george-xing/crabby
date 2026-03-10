import cron from "node-cron";
import { Bot } from "grammy";
import { spawnClaude } from "../claude/subprocess.js";
import { buildSystemPrompt } from "../claude/system-prompt.js";
import { logger } from "../utils/logger.js";
import {
  initSchedulerDb,
  getActiveJobs,
  getDueReminders,
  disableJob,
  type ScheduledJob,
} from "./persistence.js";

const activeTasks = new Map<number, ReturnType<typeof cron.schedule>>();

let botInstance: Bot;

export function initScheduler(bot: Bot): void {
  botInstance = bot;
  initSchedulerDb();
  rehydrateJobs();

  // Check for due one-shot reminders every 30 seconds
  cron.schedule("*/30 * * * * *", () => {
    processReminders().catch((err) =>
      logger.error({ err }, "Error processing reminders"),
    );
  });

  logger.info("Scheduler initialized");
}

function rehydrateJobs(): void {
  const jobs = getActiveJobs();
  let loaded = 0;

  for (const job of jobs) {
    if (job.cron_expression && cron.validate(job.cron_expression)) {
      scheduleRecurringJob(job);
      loaded++;
    }
  }

  logger.info({ loaded, total: jobs.length }, "Rehydrated scheduled jobs");
}

export function scheduleRecurringJob(job: ScheduledJob): void {
  if (!job.cron_expression) return;

  // Stop existing task if re-scheduling
  const existing = activeTasks.get(job.id);
  if (existing) existing.stop();

  const task = cron.schedule(job.cron_expression, () => {
    executeJob(job).catch((err) =>
      logger.error({ err, jobId: job.id }, "Error executing scheduled job"),
    );
  });

  activeTasks.set(job.id, task);
  logger.info({ jobId: job.id, cron: job.cron_expression, type: job.type }, "Scheduled recurring job");
}

export function unscheduleJob(jobId: number): void {
  const task = activeTasks.get(jobId);
  if (task) {
    task.stop();
    activeTasks.delete(jobId);
  }
}

async function processReminders(): Promise<void> {
  const due = getDueReminders();
  for (const reminder of due) {
    try {
      await deliverReminder(reminder);
      disableJob(reminder.id); // One-shot: disable after delivery
    } catch (err) {
      logger.error({ err, id: reminder.id }, "Failed to deliver reminder");
    }
  }
}

async function deliverReminder(job: ScheduledJob): Promise<void> {
  logger.info({ jobId: job.id, chatId: job.chat_id }, "Delivering reminder");

  await botInstance.api.sendMessage(
    job.chat_id,
    `Reminder: ${job.message}`,
  );
}

async function executeJob(job: ScheduledJob): Promise<void> {
  logger.info({ jobId: job.id, type: job.type, chatId: job.chat_id }, "Executing scheduled job");

  if (job.type === "briefing") {
    await executeBriefing(job);
  } else {
    // recurring reminder — just send the message
    await botInstance.api.sendMessage(job.chat_id, `Reminder: ${job.message}`);
  }
}

async function executeBriefing(job: ScheduledJob): Promise<void> {
  const systemPrompt = buildSystemPrompt();
  const prompt = job.message || "Give me my morning briefing: today's calendar events, any important emails, and a quick weather summary.";

  try {
    const { result } = await spawnClaude(
      { prompt, systemPrompt, timeoutMs: 3 * 60 * 1000 },
      () => {}, // No streaming for scheduled jobs
    );

    if (result) {
      await botInstance.api.sendMessage(job.chat_id, result, {
        parse_mode: "Markdown",
      });
    }
  } catch (err) {
    logger.error({ err, jobId: job.id }, "Briefing generation failed");
    await botInstance.api.sendMessage(
      job.chat_id,
      "I couldn't generate your briefing this time. I'll try again tomorrow.",
    );
  }
}

export function stopScheduler(): void {
  for (const [id, task] of activeTasks) {
    task.stop();
    activeTasks.delete(id);
  }
  logger.info("Scheduler stopped");
}
