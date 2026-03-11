import { env } from "node:process";

function required(name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return env[name] || fallback;
}

export const config = {
  telegram: {
    botToken: required("TELEGRAM_BOT_TOKEN"),
    allowedUserIds: required("TELEGRAM_ALLOWED_USER_IDS")
      .split(",")
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !isNaN(id)),
    allowedGroupIds: optional("TELEGRAM_ALLOWED_GROUP_IDS", "")
      .split(",")
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !isNaN(id)),
  },
  claude: {
    configDir: optional("CLAUDE_CONFIG_DIR", ""),
  },
  openai: {
    apiKey: optional("OPENAI_API_KEY", ""),
  },
  dataDir: optional("DATA_DIR", "./data"),
  timezone: optional("TIMEZONE", "America/New_York"),
} as const;
