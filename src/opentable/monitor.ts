/**
 * OpenTable reservation monitor runner.
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
  initOpenTableDb,
  searchAvailability,
  findRestaurantByName,
  bookSlot,
  ensureFreshAuth,
  setSnipeMode,
  onAuthFailure,
} from "./client.js";
import { slotTime, type OTSlot } from "./types.js";

let db: Database.Database;
let botInstance: Bot;
let casualTask: ReturnType<typeof cron.schedule> | null = null;
const snipeTasks = new Map<string, ReturnType<typeof cron.schedule>>();

interface MonitorRow {
  id: number;
  chat_id: number;
  restaurant_name: string;
  restaurant_id: number | null;
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

export function initOpenTableMonitor(bot: Bot): void {
  botInstance = bot;

  const dataDir = config.dataDir;
  initOpenTableDb(dataDir);

  // Register auth failure callback to notify all active monitors' chats
  onAuthFailure(async (message) => {
    const chatIds = new Set(
      getActiveMonitors().map((m) => m.chat_id),
    );
    for (const chatId of chatIds) {
      try {
        await bot.api.sendMessage(chatId, `OpenTable auth issue: ${message}`);
      } catch {
        // ignore notification failure
      }
    }
  });

  const dbPath = path.join(dataDir, "crabby.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS opentable_monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      restaurant_name TEXT NOT NULL,
      restaurant_id INTEGER,
      party_size INTEGER NOT NULL,
      time_start TEXT NOT NULL,
      time_end TEXT NOT NULL,
      date_start TEXT NOT NULL,
      date_end TEXT NOT NULL,
      days_of_week TEXT,
      drop_time TEXT,
      drop_advance_days INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      booked_confirmation TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Start casual polling every 60 seconds
  casualTask = cron.schedule("*/60 * * * * *", () => {
    processCasualMonitors().catch((err) =>
      logger.error({ err }, "Error processing OpenTable monitors"),
    );
  });

  // Schedule snipe jobs for existing monitors
  scheduleSnipeJobs();

  logger.info("OpenTable monitor initialized");
}

export function stopOpenTableMonitor(): void {
  if (casualTask) {
    casualTask.stop();
    casualTask = null;
  }
  for (const [key, task] of snipeTasks) {
    task.stop();
    snipeTasks.delete(key);
  }
  logger.info("OpenTable monitor stopped");
}

// --- Casual mode ---

async function processCasualMonitors(): Promise<void> {
  const monitors = getActiveMonitors();
  const today = new Date().toISOString().slice(0, 10);

  for (const monitor of monitors) {
    // Auto-disable if date range has passed
    if (monitor.date_end < today) {
      disableMonitor(monitor.id);
      logger.info({ monitorId: monitor.id }, "OpenTable monitor expired, disabled");
      try {
        await botInstance.api.sendMessage(
          monitor.chat_id,
          `OpenTable monitor #${monitor.id} for ${monitor.restaurant_name} has expired (date range ended). No reservation was booked.`,
        );
      } catch {
        // ignore notification failure
      }
      continue;
    }

    try {
      await checkMonitor(monitor);
    } catch (err) {
      logger.error({ err, monitorId: monitor.id }, "Error checking OpenTable monitor");
    }
  }
}

async function checkMonitor(monitor: MonitorRow): Promise<void> {
  // Resolve restaurant_id if missing
  if (!monitor.restaurant_id) {
    const restaurant = await findRestaurantByName(monitor.restaurant_name);
    if (restaurant) {
      db.prepare("UPDATE opentable_monitors SET restaurant_id = ? WHERE id = ?").run(
        restaurant.restaurantId,
        monitor.id,
      );
      monitor.restaurant_id = restaurant.restaurantId;
    } else {
      logger.debug(
        { monitorId: monitor.id, restaurant: monitor.restaurant_name },
        "OpenTable restaurant not found yet",
      );
      return;
    }
  }

  // Get dates to check
  const datesToCheck = getMonitorDates(monitor);
  if (datesToCheck.length === 0) return;

  for (const day of datesToCheck) {
    try {
      // Use midpoint of time range as the search time
      const searchTime = monitor.time_start;

      const result = await searchAvailability({
        restaurantId: monitor.restaurant_id,
        date: day,
        time: searchTime,
        partySize: monitor.party_size,
      });

      const availability = result.data?.availability?.[0];
      if (!availability) continue;

      for (const availDay of availability.availabilityDays || []) {
        const matchingSlots = filterSlots(availDay.slots, searchTime, monitor.time_start, monitor.time_end);
        if (matchingSlots.length > 0) {
          const booked = await tryBookSlot(matchingSlots, searchTime, day, monitor);
          if (booked) return;
        }
      }
    } catch (err) {
      logger.warn({ err, monitorId: monitor.id, day }, "Error searching OpenTable for monitor");
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

  const snipeDates = getSnipeDates(monitor);
  const tz = process.env.TIMEZONE || "America/New_York";

  for (const snipeDate of snipeDates) {
    const [dropHour, dropMinute] = monitor.drop_time.split(":").map(Number);
    let preMinute = dropMinute - 1;
    let preHour = dropHour;
    if (preMinute < 0) {
      preMinute = 59;
      preHour = (preHour - 1 + 24) % 24;
    }

    const [, month, dayOfMonth] = snipeDate.split("-").map(Number);

    const cronExpr = `${preMinute} ${preHour} ${dayOfMonth} ${month} *`;
    const key = `ot-snipe-${monitor.id}-${snipeDate}`;

    if (snipeTasks.has(key)) continue;

    const task = cron.schedule(
      cronExpr,
      () => {
        executeSnipe(monitor, snipeDate).catch((err) =>
          logger.error({ err, monitorId: monitor.id, snipeDate }, "OpenTable snipe failed"),
        );
      },
      { timezone: tz },
    );

    snipeTasks.set(key, task);
    logger.info(
      { monitorId: monitor.id, snipeDate, cronExpr },
      "Scheduled OpenTable snipe job",
    );
  }
}

async function executeSnipe(monitor: MonitorRow, targetDate: string): Promise<void> {
  const chatId = monitor.chat_id;
  const dropTime = monitor.drop_time!;

  logger.info({ monitorId: monitor.id, targetDate }, "Starting OpenTable snipe sequence");

  // Pre-authenticate
  try {
    await ensureFreshAuth();
  } catch (err) {
    logger.error({ err }, "OpenTable pre-auth failed before snipe");
    try {
      await botInstance.api.sendMessage(
        chatId,
        `OpenTable snipe warning: auth check failed before sniping ${monitor.restaurant_name} for ${targetDate}. Will still attempt.`,
      );
    } catch {
      // ignore
    }
  }

  // Resolve restaurant_id if needed
  if (!monitor.restaurant_id) {
    const restaurant = await findRestaurantByName(monitor.restaurant_name);
    if (restaurant) {
      db.prepare("UPDATE opentable_monitors SET restaurant_id = ? WHERE id = ?").run(
        restaurant.restaurantId,
        monitor.id,
      );
      monitor.restaurant_id = restaurant.restaurantId;
    }
  }

  if (!monitor.restaurant_id) {
    try {
      await botInstance.api.sendMessage(
        chatId,
        `OpenTable snipe failed: could not find restaurant "${monitor.restaurant_name}" on OpenTable.`,
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
      // Check if monitor was disabled while sniping
      const current = db
        .prepare("SELECT enabled FROM opentable_monitors WHERE id = ?")
        .get(monitor.id) as { enabled: number } | undefined;
      if (!current || current.enabled !== 1) break;

      try {
        const searchTime = monitor.time_start;
        const result = await searchAvailability({
          restaurantId: monitor.restaurant_id,
          date: targetDate,
          time: searchTime,
          partySize: monitor.party_size,
        });

        const availability = result.data?.availability?.[0];
        if (availability) {
          for (const availDay of availability.availabilityDays || []) {
            const matchingSlots = filterSlots(
              availDay.slots,
              searchTime,
              monitor.time_start,
              monitor.time_end,
            );
            if (matchingSlots.length > 0) {
              const booked = await tryBookSlot(matchingSlots, searchTime, targetDate, monitor);
              if (booked) {
                setSnipeMode(false);
                return;
              }
            }
          }
        }
      } catch (err) {
        logger.warn({ err }, "OpenTable snipe search attempt failed, retrying");
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    setSnipeMode(false);
  }

  // Snipe window ended without success
  logger.info({ monitorId: monitor.id, targetDate }, "OpenTable snipe window ended, no slots found");
  try {
    await botInstance.api.sendMessage(
      chatId,
      `OpenTable snipe for ${monitor.restaurant_name} on ${targetDate} (${monitor.time_start}-${monitor.time_end}, ${monitor.party_size} guests): no slots found at drop time. Will continue casual monitoring.`,
    );
  } catch {
    // ignore
  }
}

// --- Booking ---

async function tryBookSlot(
  slots: OTSlot[],
  searchTime: string,
  day: string,
  monitor: MonitorRow,
): Promise<boolean> {
  for (const slot of slots) {
    if (!slot.slotAvailabilityToken || !slot.slotHash) continue;

    try {
      const actualTime = slotTime(searchTime, slot.timeOffsetMinutes);

      const confirmation = await bookSlot({
        restaurantId: monitor.restaurant_id!,
        slotAvailabilityToken: slot.slotAvailabilityToken,
        slotHash: slot.slotHash,
        date: day,
        time: actualTime,
        partySize: monitor.party_size,
      });

      // Mark monitor as booked
      db.prepare(
        "UPDATE opentable_monitors SET enabled = 0, booked_confirmation = ? WHERE id = ?",
      ).run(confirmation.confirmationNumber, monitor.id);

      // Notify user
      const message = [
        `Booked! ${monitor.restaurant_name} (OpenTable)`,
        `${day} at ${actualTime}, ${monitor.party_size} guests`,
        `Confirmation: ${confirmation.confirmationNumber}`,
        confirmation.reservationId
          ? `Reservation ID: ${confirmation.reservationId}`
          : "",
        "",
        "To cancel, tell me: cancel my OpenTable reservation",
      ]
        .filter(Boolean)
        .join("\n");

      try {
        await botInstance.api.sendMessage(monitor.chat_id, message);
      } catch {
        logger.error("Failed to notify user of successful OpenTable booking");
      }

      logger.info(
        { monitorId: monitor.id, restaurant: monitor.restaurant_name, day, actualTime },
        "Auto-booked OpenTable reservation",
      );
      return true;
    } catch (err) {
      logger.warn({ err, slotHash: slot.slotHash }, "Failed to book OpenTable slot, trying next");
    }
  }
  return false;
}

// --- Helpers ---

function getActiveMonitors(): MonitorRow[] {
  return db
    .prepare("SELECT * FROM opentable_monitors WHERE enabled = 1")
    .all() as MonitorRow[];
}

function disableMonitor(id: number): void {
  db.prepare("UPDATE opentable_monitors SET enabled = 0 WHERE id = ?").run(id);
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

  const startDate = new Date(monitor.date_start + "T00:00:00");
  const endDate = new Date(monitor.date_end + "T00:00:00");
  const allowedDays = monitor.days_of_week
    ? new Set(monitor.days_of_week.split(",").map(Number))
    : null;

  const current = new Date(startDate);
  while (current <= endDate) {
    const dayOfWeek = current.getDay();
    if (!allowedDays || allowedDays.has(dayOfWeek)) {
      const snipeDate = new Date(current);
      snipeDate.setDate(snipeDate.getDate() - monitor.drop_advance_days);
      const snipeDateStr = snipeDate.toISOString().slice(0, 10);

      if (snipeDateStr >= todayStr) {
        dates.push(snipeDateStr);
      }
    }
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

function filterSlots(
  slots: OTSlot[],
  searchTime: string,
  timeStart: string,
  timeEnd: string,
): OTSlot[] {
  return slots.filter((s) => {
    if (!s.isAvailable) return false;

    const actualTime = slotTime(searchTime, s.timeOffsetMinutes);
    return actualTime >= timeStart && actualTime < timeEnd;
  });
}

async function waitUntilTime(
  hour: number,
  minute: number,
  timezone: string,
): Promise<void> {
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
