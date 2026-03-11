import "dotenv/config";
import { mkdirSync } from "node:fs";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { onShutdown } from "./utils/graceful-shutdown.js";
import { initSessionManager } from "./claude/session-manager.js";
import { initMemoryDb } from "./memory/memory.js";
import { processPool } from "./claude/process-pool.js";
import { createBot, startBot, stopBot } from "./telegram/bot.js";
import { initScheduler, stopScheduler } from "./scheduler/scheduler.js";
import { initResyMonitor, stopResyMonitor } from "./resy/monitor.js";
import { initOpenTableMonitor, stopOpenTableMonitor } from "./opentable/monitor.js";

// Ensure data directory exists
mkdirSync(config.dataDir, { recursive: true });

// Initialize databases
initSessionManager();
initMemoryDb(config.dataDir);

// Create and start bot
const bot = createBot();

// Initialize scheduler (reminders, briefings)
initScheduler(bot);

// Initialize Resy monitor (reservation sniping)
try {
  initResyMonitor(bot);
} catch (err) {
  logger.warn({ err }, "Resy monitor not initialized (credentials may not be configured)");
}

// Initialize OpenTable monitor (reservation sniping)
try {
  initOpenTableMonitor(bot);
} catch (err) {
  logger.warn({ err }, "OpenTable monitor not initialized (credentials may not be configured)");
}

onShutdown(() => {
  processPool.killAll();
  stopScheduler();
  stopResyMonitor();
  stopOpenTableMonitor();
  stopBot(bot);
});

logger.info("Crabby starting up");
startBot(bot);
