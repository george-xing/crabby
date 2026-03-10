import { logger } from "./logger.js";

type ShutdownHandler = () => Promise<void> | void;

const handlers: ShutdownHandler[] = [];
let shuttingDown = false;

export function onShutdown(handler: ShutdownHandler) {
  handlers.push(handler);
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, "Shutting down gracefully");

  for (const handler of handlers) {
    try {
      await handler();
    } catch (err) {
      logger.error({ err }, "Error during shutdown handler");
    }
  }

  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
