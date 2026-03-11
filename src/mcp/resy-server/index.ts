#!/usr/bin/env node
/**
 * MCP server for Resy restaurant reservations.
 * Tools for searching, booking, cancelling, and monitoring reservations.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import path from "node:path";
import {
  initResyDb,
  searchVenues,
  findVenueByName,
  getSlotDetails,
  bookSlot,
  getMyReservations,
  cancelReservation,
} from "../../resy/client.js";
import type { ResySlot } from "../../resy/types.js";

const DATA_DIR = process.env.DATA_DIR || "./data";

// Initialize Resy client (auth, HTTP)
initResyDb(DATA_DIR);

// Separate DB handle for monitor tables
const dbPath = path.join(DATA_DIR, "crabby.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

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

const server = new McpServer({
  name: "crabby-resy",
  version: "0.1.0",
});

// --- Tool: resy_search ---
server.tool(
  "resy_search",
  "Search for restaurant availability on Resy. Returns restaurants with available time slots. Use venue_id (from resy_find_venue) to search a specific restaurant, or query/lat/long for area search.",
  {
    day: z.string().describe("Date in YYYY-MM-DD format"),
    party_size: z.number().min(1).max(20).describe("Number of guests"),
    lat: z
      .number()
      .optional()
      .default(40.7128)
      .describe("Latitude (default: NYC 40.7128)"),
    long: z
      .number()
      .optional()
      .default(-74.006)
      .describe("Longitude (default: NYC -74.0060)"),
    query: z.string().optional().describe("Optional restaurant name or cuisine filter"),
    venue_id: z.number().optional().describe("Resy venue ID (from resy_find_venue) to search a specific restaurant"),
    time_start: z.string().optional().describe("Filter slots starting at or after this time (HH:MM, e.g. '18:00')"),
    time_end: z.string().optional().describe("Filter slots starting before this time (HH:MM, e.g. '20:00')"),
  },
  async ({ day, party_size, lat, long, query, venue_id, time_start, time_end }) => {
    try {
      const result = await searchVenues({
        lat,
        long,
        day,
        party_size,
        venue_id,
      });

      let venues = result.results?.venues || [];

      // Filter by query if provided and no venue_id
      if (query && !venue_id) {
        const q = query.toLowerCase();
        venues = venues.filter((v) => {
          const name = v.venue?.name?.toLowerCase() || "";
          const cuisines = v.venue?.cuisine?.map((c) => c.toLowerCase()) || [];
          return name.includes(q) || cuisines.some((c) => c.includes(q));
        });
      }

      // Filter slots by time window
      if (time_start || time_end) {
        venues = venues
          .map((v) => ({
            ...v,
            slots: filterSlotsByTime(v.slots, time_start, time_end),
          }))
          .filter((v) => v.slots.length > 0);
      }

      if (venues.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No availability found for ${party_size} on ${day}${query ? ` matching "${query}"` : ""}.`,
            },
          ],
        };
      }

      const lines: string[] = [];
      for (const v of venues.slice(0, 10)) {
        const venue = v.venue;
        const name = venue?.name || "Unknown";
        const hood = venue?.location?.neighborhood || "";
        const cuisine = venue?.cuisine?.join(", ") || "";
        const price = venue?.price_range ? "$".repeat(venue.price_range) : "";
        const venueId = venue?.id?.resy;

        lines.push(`${name} (ID: ${venueId})`);
        if (hood || cuisine || price) {
          lines.push(`  ${[hood, cuisine, price].filter(Boolean).join(" | ")}`);
        }

        if (v.slots.length > 0) {
          const slotTimes = v.slots.slice(0, 8).map((s) => {
            const time = s.date?.start?.split(" ")[1]?.slice(0, 5) || "??:??";
            const type = s.config?.type || "";
            return `${time}${type ? ` (${type})` : ""} [token: ${s.config?.token || "N/A"}]`;
          });
          lines.push(`  Slots: ${slotTimes.join(", ")}`);
          if (v.slots.length > 8) {
            lines.push(`  ... and ${v.slots.length - 8} more slots`);
          }
        }
        lines.push("");
      }

      if (venues.length > 10) {
        lines.push(`... and ${venues.length - 10} more restaurants`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `Search failed: ${err instanceof Error ? err.message : String(err)}` },
        ],
      };
    }
  },
);

// --- Tool: resy_find_venue ---
server.tool(
  "resy_find_venue",
  "Look up a restaurant by name on Resy to get its venue ID. Use this before resy_search to search a specific restaurant.",
  {
    query: z.string().describe("Restaurant name to search for"),
  },
  async ({ query }) => {
    try {
      const venue = await findVenueByName(query);
      if (!venue) {
        return {
          content: [
            { type: "text" as const, text: `No restaurant found matching "${query}" on Resy.` },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Found: ${venue.name} (ID: ${venue.id})${venue.neighborhood ? ` - ${venue.neighborhood}` : ""}`,
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `Venue search failed: ${err instanceof Error ? err.message : String(err)}` },
        ],
      };
    }
  },
);

// --- Tool: resy_slot_details ---
server.tool(
  "resy_slot_details",
  "Get details for a specific reservation slot including cancellation policy, deposit requirements, and the book token needed to book. ALWAYS call this before resy_book to show the user what they are committing to.",
  {
    config_token: z.string().describe("The config token from search results (identifies a specific time slot)"),
    day: z.string().describe("Date in YYYY-MM-DD format"),
    party_size: z.number().min(1).max(20).describe("Number of guests"),
  },
  async ({ config_token, day, party_size }) => {
    try {
      const details = await getSlotDetails(config_token, day, party_size);

      const lines: string[] = [];
      lines.push(`Book token: ${details.book_token?.value || "N/A"}`);
      lines.push(`Expires: ${details.book_token?.date_expires || "unknown"}`);

      if (details.cancellation?.fee?.amount) {
        lines.push(`Cancellation fee: $${details.cancellation.fee.amount}`);
      } else {
        lines.push("Cancellation fee: None");
      }

      if (details.cancellation?.policy?.length) {
        lines.push(`Policy: ${details.cancellation.policy.join(" ")}`);
      }

      if (details.payment?.deposit?.amount) {
        lines.push(`Deposit required: $${details.payment.deposit.amount}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `Slot details failed: ${err instanceof Error ? err.message : String(err)}` },
        ],
      };
    }
  },
);

// --- Tool: resy_book ---
server.tool(
  "resy_book",
  "Book a reservation on Resy. Requires a book_token from resy_slot_details. IMPORTANT: Always confirm with the user before calling this -- bookings may have cancellation fees or deposits.",
  {
    book_token: z.string().describe("The book token from resy_slot_details"),
  },
  async ({ book_token }) => {
    try {
      const confirmation = await bookSlot(book_token);
      return {
        content: [
          {
            type: "text" as const,
            text: `Reservation booked!\nResy token: ${confirmation.resy_token}${confirmation.reservation_id ? `\nReservation ID: ${confirmation.reservation_id}` : ""}\n\nSave the resy token — you'll need it to cancel.`,
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `Booking failed: ${err instanceof Error ? err.message : String(err)}` },
        ],
      };
    }
  },
);

// --- Tool: resy_my_reservations ---
server.tool(
  "resy_my_reservations",
  "List all upcoming reservations on the user's Resy account.",
  {},
  async () => {
    try {
      const reservations = await getMyReservations();
      if (reservations.length === 0) {
        return { content: [{ type: "text" as const, text: "No upcoming reservations." }] };
      }

      const lines = reservations.map((r) => {
        const parts = [
          r.venue?.name || "Unknown",
          r.day,
          r.time_slot || "",
          `${r.num_seats} guests`,
        ].filter(Boolean);
        let line = parts.join(" | ");
        if (r.resy_token) {
          line += ` [resy_token: ${r.resy_token}]`;
        }
        if (r.cancellation?.fee?.amount) {
          line += ` (cancel fee: $${r.cancellation.fee.amount})`;
        }
        return line;
      });

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to list reservations: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

// --- Tool: resy_cancel ---
server.tool(
  "resy_cancel",
  "Cancel an existing Resy reservation. IMPORTANT: Always confirm with the user before cancelling -- some reservations have cancellation fees.",
  {
    resy_token: z.string().describe("The resy_token from the reservation (from resy_my_reservations)"),
  },
  async ({ resy_token }) => {
    try {
      await cancelReservation(resy_token);
      return { content: [{ type: "text" as const, text: "Reservation cancelled successfully." }] };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `Cancellation failed: ${err instanceof Error ? err.message : String(err)}` },
        ],
      };
    }
  },
);

// --- Tool: resy_create_monitor ---
server.tool(
  "resy_create_monitor",
  "Create a reservation monitor that automatically books when a matching slot becomes available. For hard-to-get restaurants. If the user knows when the restaurant releases tables, set drop_time + drop_advance_days for precision sniping at release time. Otherwise, the monitor checks for cancellation pickups every 60 seconds.",
  {
    venue_name: z.string().describe("Restaurant name (will be looked up via Resy)"),
    party_size: z.number().min(1).max(20).describe("Number of guests"),
    time_start: z.string().describe("Earliest acceptable time (HH:MM, e.g. '18:00')"),
    time_end: z.string().describe("Latest acceptable time (HH:MM, e.g. '20:00')"),
    date_start: z.string().describe("Start of date range to monitor (YYYY-MM-DD)"),
    date_end: z.string().describe("End of date range to monitor (YYYY-MM-DD)"),
    chat_id: z.number().describe("Telegram chat ID for notifications"),
    days_of_week: z
      .string()
      .optional()
      .describe("Comma-separated days to monitor: 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat. e.g. '5,6' for Fri+Sat"),
    drop_time: z
      .string()
      .optional()
      .describe("Time when restaurant releases tables (HH:MM in restaurant's timezone, e.g. '09:00')"),
    drop_advance_days: z
      .number()
      .optional()
      .describe("How many days in advance the restaurant releases tables (e.g. 30)"),
    lat: z.number().optional().default(40.7128).describe("Latitude (default: NYC)"),
    long: z.number().optional().default(-74.006).describe("Longitude (default: NYC)"),
  },
  async ({ venue_name, party_size, time_start, time_end, date_start, date_end, chat_id, days_of_week, drop_time, drop_advance_days, lat, long }) => {
    try {
      // Look up venue ID
      const venue = await findVenueByName(venue_name);
      const venueId = venue?.id ?? null;

      const result = db
        .prepare(
          `INSERT INTO resy_monitors
           (chat_id, venue_name, venue_id, lat, long, party_size, time_start, time_end, date_start, date_end, days_of_week, drop_time, drop_advance_days)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          chat_id,
          venue?.name ?? venue_name,
          venueId,
          lat,
          long,
          party_size,
          time_start,
          time_end,
          date_start,
          date_end,
          days_of_week ?? null,
          drop_time ?? null,
          drop_advance_days ?? null,
        );

      let description = `Monitor #${result.lastInsertRowid} created:\n`;
      description += `Restaurant: ${venue?.name ?? venue_name}${venueId ? ` (ID: ${venueId})` : " (venue ID not found, will retry)"}\n`;
      description += `Party: ${party_size} | Time: ${time_start}-${time_end}\n`;
      description += `Dates: ${date_start} to ${date_end}`;
      if (days_of_week) {
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const days = days_of_week.split(",").map((d) => dayNames[parseInt(d)] || d);
        description += ` (${days.join(", ")} only)`;
      }
      description += "\n";
      if (drop_time && drop_advance_days) {
        description += `Snipe mode: tables drop at ${drop_time}, ${drop_advance_days} days ahead. Will aggressively poll at release time.\n`;
      } else {
        description += "Casual mode: checking for cancellations every 60 seconds.\n";
      }
      description += "Will auto-book and notify you via Telegram when a slot is found.";

      return { content: [{ type: "text" as const, text: description }] };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to create monitor: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

// --- Tool: resy_list_monitors ---
server.tool(
  "resy_list_monitors",
  "List all active reservation monitors for a chat.",
  {
    chat_id: z.number().describe("Telegram chat ID"),
  },
  async ({ chat_id }) => {
    const rows = db
      .prepare(
        `SELECT id, venue_name, venue_id, party_size, time_start, time_end,
                date_start, date_end, days_of_week, drop_time, drop_advance_days, booked_resy_token, created_at
         FROM resy_monitors WHERE chat_id = ? AND enabled = 1 ORDER BY created_at`,
      )
      .all(chat_id) as Array<{
        id: number;
        venue_name: string;
        venue_id: number | null;
        party_size: number;
        time_start: string;
        time_end: string;
        date_start: string;
        date_end: string;
        days_of_week: string | null;
        drop_time: string | null;
        drop_advance_days: number | null;
        booked_resy_token: string | null;
        created_at: string;
      }>;

    if (rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No active monitors." }] };
    }

    const lines = rows.map((r) => {
      let line = `#${r.id} ${r.venue_name} | ${r.party_size} guests | ${r.time_start}-${r.time_end} | ${r.date_start} to ${r.date_end}`;
      if (r.days_of_week) {
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const days = r.days_of_week.split(",").map((d) => dayNames[parseInt(d)] || d);
        line += ` (${days.join(",")})`;
      }
      if (r.drop_time) {
        line += ` [snipe: ${r.drop_time}, ${r.drop_advance_days}d ahead]`;
      } else {
        line += " [casual]";
      }
      if (r.booked_resy_token) {
        line += ` BOOKED: ${r.booked_resy_token}`;
      }
      return line;
    });

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

// --- Tool: resy_cancel_monitor ---
server.tool(
  "resy_cancel_monitor",
  "Cancel/disable a reservation monitor by its ID.",
  {
    monitor_id: z.number().describe("The monitor ID to cancel"),
  },
  async ({ monitor_id }) => {
    const result = db
      .prepare("UPDATE resy_monitors SET enabled = 0 WHERE id = ?")
      .run(monitor_id);

    if (result.changes > 0) {
      return { content: [{ type: "text" as const, text: `Monitor #${monitor_id} cancelled.` }] };
    }
    return { content: [{ type: "text" as const, text: `Monitor #${monitor_id} not found.` }] };
  },
);

// --- Helpers ---

function filterSlotsByTime(
  slots: ResySlot[],
  timeStart?: string,
  timeEnd?: string,
): ResySlot[] {
  if (!timeStart && !timeEnd) return slots;

  return slots.filter((s) => {
    const startStr = s.date?.start;
    if (!startStr) return false;

    // Extract HH:MM from "YYYY-MM-DD HH:MM:SS"
    const timePart = startStr.split(" ")[1]?.slice(0, 5);
    if (!timePart) return false;

    if (timeStart && timePart < timeStart) return false;
    if (timeEnd && timePart >= timeEnd) return false;
    return true;
  });
}

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
