/**
 * Reservation monitor runner.
 * Polls for availability and auto-books matching slots.
 *
 * Two modes:
 * - Casual: every 60s, check for cancellation pickups
 * - Snipe: tight polling (every 1-2s for 30s) at restaurant drop time
 */
import cron from "node-cron";
import Database from "better-sqlite3";
import path from "node:path";
import type { Bot } from "grammy";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  initResyDb,
  searchVenues,
  findVenueByName,
  getSlotDetails,
  bookSlot,
  ensureFreshAuth,
  setSnipeMode,
} from "./client.js";
import type { ResySlot } from "./types.js";

let db: Database.Database;
let botInstance: Bot;
let casualTask: ReturnType<typeof cron.schedule> | null = null;
const snipeTasks = new Map<string, ReturnType<typeof cron.schedule>>();

interface MonitorRow {
  id: number;
  chat_id: number;
  venue_name: string;
  venue_id: number | null;
  lat: number;
  long: number;
  party_size: number;
  time_start: string;
  time_end: string;
  date_start: string;
  date_end: string;
  days_of_week: string | null;
  drop_time: string | null;
  drop_advance_days: number | null;
  enabled: number;
}

export function initResyMonitor(bot: Bot): void {
  botInstance = bot;

  const dataDir = config.dataDir;
  initResyDb(dataDir);

  const dbPath = path.join(dataDir, "crabby.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  // Ensure table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS resy_monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      venue_name TEXT NOT NULL,
      venue_id INTEGER,
      lat REAL NOT NULL DEFAULT 40.7128,
      long REAL NOT NULL DEFAULT -74.0060,
      party_size INTEGER NOT NULL,
      time_start TEXT NOT NULL,
      time_end TEXT NOT NULL,
      date_start TEXT NOT NULL,
      date_end TEXT NOT NULL,
      days_of_week TEXT,
      drop_time TEXT,
      drop_advance_days INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      booked_resy_token TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Start casual polling every 60 seconds
  casualTask = cron.schedule("*/60 * * * * *", () => {
    processCasualMonitors().catch((err) =>
      logger.error({ err }, "Error processing Resy monitors"),
    );
  });

  // Schedule snipe jobs for existing monitors
  scheduleSnipeJobs();

  logger.info("Resy monitor initialized");
}

export function stopResyMonitor(): void {
  if (casualTask) {
    casualTask.stop();
    casualTask = null;
  }
  for (const [key, task] of snipeTasks) {
    task.stop();
    snipeTasks.delete(key);
  }
  logger.info("Resy monitor stopped");
}

// --- Casual mode ---

async function processCasualMonitors(): Promise<void> {
  const monitors = getActiveMonitors();
  const today = new Date().toISOString().slice(0, 10);

  for (const monitor of monitors) {
    // Skip monitors that only use snipe mode (have drop_time but date hasn't expired)
    // Still do casual checks for cancellation pickups even if they have drop_time

    // Auto-disable if date range has passed
    if (monitor.date_end < today) {
      disableMonitor(monitor.id);
      logger.info({ monitorId: monitor.id }, "Monitor expired, disabled");
      try {
        await botInstance.api.sendMessage(
          monitor.chat_id,
          `Resy monitor #${monitor.id} for ${monitor.venue_name} has expired (date range ended). No reservation was booked.`,
        );
      } catch {
        // ignore notification failure
      }
      continue;
    }

    try {
      await checkMonitor(monitor);
    } catch (err) {
      logger.error({ err, monitorId: monitor.id }, "Error checking monitor");
    }
  }
}

async function checkMonitor(monitor: MonitorRow): Promise<void> {
  // Resolve venue_id if missing
  if (!monitor.venue_id) {
    const venue = await findVenueByName(monitor.venue_name);
    if (venue) {
      db.prepare("UPDATE resy_monitors SET venue_id = ? WHERE id = ?").run(venue.id, monitor.id);
      monitor.venue_id = venue.id;
    } else {
      logger.debug({ monitorId: monitor.id, venue: monitor.venue_name }, "Venue not found yet");
      return;
    }
  }

  // Get dates to check
  const datesToCheck = getMonitorDates(monitor);
  if (datesToCheck.length === 0) return;

  for (const day of datesToCheck) {
    try {
      const result = await searchVenues({
        lat: monitor.lat,
        long: monitor.long,
        day,
        party_size: monitor.party_size,
        venue_id: monitor.venue_id,
      });

      const venues = result.results?.venues || [];
      for (const venueResult of venues) {
        const matchingSlots = filterSlots(venueResult.slots, monitor.time_start, monitor.time_end);
        if (matchingSlots.length > 0) {
          // Found a match! Try to book the first available slot
          const booked = await tryBookSlot(matchingSlots, day, monitor);
          if (booked) return; // Successfully booked, done with this monitor
        }
      }
    } catch (err) {
      logger.warn({ err, monitorId: monitor.id, day }, "Error searching for monitor");
    }
  }
}

// --- Snipe mode ---

function scheduleSnipeJobs(): void {
  const monitors = getActiveMonitors().filter(
    (m) => m.drop_time && m.drop_advance_days,
  );

  for (const monitor of monitors) {
    scheduleSnipeForMonitor(monitor);
  }
}

function scheduleSnipeForMonitor(monitor: MonitorRow): void {
  if (!monitor.drop_time || !monitor.drop_advance_days) return;

  // Calculate which dates need sniping and when
  const snipeDates = getSnipeDates(monitor);
  const tz = process.env.TIMEZONE || "America/New_York";

  for (const snipeDate of snipeDates) {
    // Schedule cron 1 minute before drop time
    const [dropHour, dropMinute] = monitor.drop_time.split(":").map(Number);
    let preMinute = dropMinute - 1;
    let preHour = dropHour;
    if (preMinute < 0) {
      preMinute = 59;
      preHour = (preHour - 1 + 24) % 24;
    }

    // Parse the snipeDate to get month and day
    const [, month, dayOfMonth] = snipeDate.split("-").map(Number);

    const cronExpr = `${preMinute} ${preHour} ${dayOfMonth} ${month} *`;
    const key = `snipe-${monitor.id}-${snipeDate}`;

    if (snipeTasks.has(key)) continue;

    const task = cron.schedule(
      cronExpr,
      () => {
        executeSnipe(monitor, snipeDate).catch((err) =>
          logger.error({ err, monitorId: monitor.id, snipeDate }, "Snipe failed"),
        );
      },
      { timezone: tz },
    );

    snipeTasks.set(key, task);
    logger.info(
      { monitorId: monitor.id, snipeDate, cronExpr },
      "Scheduled snipe job",
    );
  }
}

async function executeSnipe(monitor: MonitorRow, targetDate: string): Promise<void> {
  const chatId = monitor.chat_id;
  const dropTime = monitor.drop_time!;

  logger.info({ monitorId: monitor.id, targetDate }, "Starting snipe sequence");

  // Pre-authenticate
  try {
    await ensureFreshAuth();
  } catch (err) {
    logger.error({ err }, "Pre-auth failed before snipe");
    try {
      await botInstance.api.sendMessage(
        chatId,
        `Resy snipe warning: authentication failed before sniping ${monitor.venue_name} for ${targetDate}. Will still attempt.`,
      );
    } catch {
      // ignore
    }
  }

  // Resolve venue_id if needed
  if (!monitor.venue_id) {
    const venue = await findVenueByName(monitor.venue_name);
    if (venue) {
      db.prepare("UPDATE resy_monitors SET venue_id = ? WHERE id = ?").run(venue.id, monitor.id);
      monitor.venue_id = venue.id;
    }
  }

  if (!monitor.venue_id) {
    try {
      await botInstance.api.sendMessage(
        chatId,
        `Resy snipe failed: could not find venue "${monitor.venue_name}" on Resy.`,
      );
    } catch {
      // ignore
    }
    return;
  }

  // Wait until drop time
  const tz = process.env.TIMEZONE || "America/New_York";
  const [dropHour, dropMinute] = dropTime.split(":").map(Number);
  await waitUntilTime(dropHour, dropMinute, tz);

  // Tight polling loop: every 1s for 30 seconds
  setSnipeMode(true);
  const snipeEndTime = Date.now() + 30_000;

  try {
    while (Date.now() < snipeEndTime) {
      // Check if monitor was disabled while we were sniping
      const current = db
        .prepare("SELECT enabled FROM resy_monitors WHERE id = ?")
        .get(monitor.id) as { enabled: number } | undefined;
      if (!current || current.enabled !== 1) break;

      try {
        const result = await searchVenues({
          lat: monitor.lat,
          long: monitor.long,
          day: targetDate,
          party_size: monitor.party_size,
          venue_id: monitor.venue_id,
        });

        const venues = result.results?.venues || [];
        for (const venueResult of venues) {
          const matchingSlots = filterSlots(
            venueResult.slots,
            monitor.time_start,
            monitor.time_end,
          );
          if (matchingSlots.length > 0) {
            const booked = await tryBookSlot(matchingSlots, targetDate, monitor);
            if (booked) {
              setSnipeMode(false);
              return;
            }
          }
        }
      } catch (err) {
        logger.warn({ err }, "Snipe search attempt failed, retrying");
      }

      // Wait 1 second before next attempt
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    setSnipeMode(false);
  }

  // Snipe window ended without success
  logger.info({ monitorId: monitor.id, targetDate }, "Snipe window ended, no slots found");
  try {
    await botInstance.api.sendMessage(
      chatId,
      `Resy snipe for ${monitor.venue_name} on ${targetDate} (${monitor.time_start}-${monitor.time_end}, ${monitor.party_size} guests): no slots found at drop time. Will continue casual monitoring.`,
    );
  } catch {
    // ignore
  }
}

// --- Booking ---

async function tryBookSlot(
  slots: ResySlot[],
  day: string,
  monitor: MonitorRow,
): Promise<boolean> {
  for (const slot of slots) {
    const configToken = slot.config?.token;
    if (!configToken) continue;

    try {
      // Get slot details (needed for book_token)
      const details = await getSlotDetails(configToken, day, monitor.party_size);
      const bookToken = details.book_token?.value;
      if (!bookToken) continue;

      // Book it!
      const confirmation = await bookSlot(bookToken);

      // Mark monitor as booked
      db.prepare(
        "UPDATE resy_monitors SET enabled = 0, booked_resy_token = ? WHERE id = ?",
      ).run(confirmation.resy_token, monitor.id);

      // Extract time from slot
      const slotTime = slot.date?.start?.split(" ")[1]?.slice(0, 5) || "??:??";

      // Notify user
      const message = [
        `Booked! ${monitor.venue_name}`,
        `${day} at ${slotTime}, ${monitor.party_size} guests`,
        `Resy token: ${confirmation.resy_token}`,
        confirmation.reservation_id
          ? `Reservation ID: ${confirmation.reservation_id}`
          : "",
        "",
        "To cancel, tell me: cancel my Resy reservation",
      ]
        .filter(Boolean)
        .join("\n");

      try {
        await botInstance.api.sendMessage(monitor.chat_id, message);
      } catch {
        logger.error("Failed to notify user of successful booking");
      }

      logger.info(
        { monitorId: monitor.id, venue: monitor.venue_name, day, slotTime },
        "Auto-booked reservation",
      );
      return true;
    } catch (err) {
      logger.warn({ err, configToken }, "Failed to book slot, trying next");
    }
  }
  return false;
}

// --- Helpers ---

function getActiveMonitors(): MonitorRow[] {
  return db
    .prepare("SELECT * FROM resy_monitors WHERE enabled = 1")
    .all() as MonitorRow[];
}

function disableMonitor(id: number): void {
  db.prepare("UPDATE resy_monitors SET enabled = 0 WHERE id = ?").run(id);
}

function getMonitorDates(monitor: MonitorRow): string[] {
  const dates: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const start = monitor.date_start > today ? monitor.date_start : today;

  const current = new Date(start + "T00:00:00");
  const end = new Date(monitor.date_end + "T00:00:00");
  const allowedDays = monitor.days_of_week
    ? new Set(monitor.days_of_week.split(",").map(Number))
    : null;

  // Check up to 7 dates per poll to avoid hammering the API
  while (current <= end && dates.length < 7) {
    const dayOfWeek = current.getDay();
    if (!allowedDays || allowedDays.has(dayOfWeek)) {
      dates.push(current.toISOString().slice(0, 10));
    }
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

function getSnipeDates(monitor: MonitorRow): string[] {
  if (!monitor.drop_advance_days) return [];

  const dates: string[] = [];
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // Calculate which target dates we need to snipe for
  // target_date = snipe_date + drop_advance_days
  // So snipe_date = target_date - drop_advance_days
  const startDate = new Date(monitor.date_start + "T00:00:00");
  const endDate = new Date(monitor.date_end + "T00:00:00");
  const allowedDays = monitor.days_of_week
    ? new Set(monitor.days_of_week.split(",").map(Number))
    : null;

  const current = new Date(startDate);
  while (current <= endDate) {
    const dayOfWeek = current.getDay();
    if (!allowedDays || allowedDays.has(dayOfWeek)) {
      // When should we snipe for this date?
      const snipeDate = new Date(current);
      snipeDate.setDate(snipeDate.getDate() - monitor.drop_advance_days);
      const snipeDateStr = snipeDate.toISOString().slice(0, 10);

      // Only schedule if snipe date is today or in the future
      if (snipeDateStr >= todayStr) {
        dates.push(snipeDateStr);
      }
    }
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

function filterSlots(
  slots: ResySlot[],
  timeStart: string,
  timeEnd: string,
): ResySlot[] {
  return slots.filter((s) => {
    const startStr = s.date?.start;
    if (!startStr) return false;

    const timePart = startStr.split(" ")[1]?.slice(0, 5);
    if (!timePart) return false;

    return timePart >= timeStart && timePart < timeEnd;
  });
}

async function waitUntilTime(
  hour: number,
  minute: number,
  timezone: string,
): Promise<void> {
  // Simple busy-wait with decreasing sleep intervals
  while (true) {
    const now = new Date();
    const nowStr = now.toLocaleString("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12: false,
    });
    const [h, m, s] = nowStr.split(":").map(Number);
    const nowSeconds = h * 3600 + m * 60 + s;
    const targetSeconds = hour * 3600 + minute * 60;
    const diff = targetSeconds - nowSeconds;

    if (diff <= 0) break;
    if (diff > 30) {
      await new Promise((resolve) => setTimeout(resolve, (diff - 10) * 1000));
    } else if (diff > 5) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
