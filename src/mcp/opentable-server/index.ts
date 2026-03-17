#!/usr/bin/env node
/**
 * MCP server for OpenTable restaurant reservations.
 * Tools for searching, booking, cancelling, and monitoring reservations.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import path from "node:path";
import {
  initOpenTableDb,
  searchAvailability,
  findRestaurantByName,
  searchRestaurantsByLocation,
  getSlotDetails,
  bookSlot,
  getMyReservations,
  cancelReservation,
} from "../../opentable/client.js";
import { slotTime, type OTSlot } from "../../opentable/types.js";

const DATA_DIR = process.env.DATA_DIR || "./data";

// Initialize OpenTable client (auth, HTTP)
initOpenTableDb(DATA_DIR);

// Separate DB handle for monitor tables
const dbPath = path.join(DATA_DIR, "crabby.db");
const db = new Database(dbPath);
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

const server = new McpServer({
  name: "crabby-opentable",
  version: "0.1.0",
});

// --- Tool: opentable_search ---
server.tool(
  "opentable_search",
  "Search for restaurant availability on OpenTable. Returns available time slots for a specific restaurant. Use restaurant_id (from opentable_find_restaurant) to search.",
  {
    restaurant_id: z.number().describe("OpenTable restaurant ID (from opentable_find_restaurant)"),
    day: z.string().describe("Date in YYYY-MM-DD format"),
    party_size: z.number().min(1).max(20).describe("Number of guests"),
    time: z
      .string()
      .optional()
      .default("19:00")
      .describe("Preferred time (HH:MM, e.g. '19:00'). Slots near this time will be returned."),
    time_start: z.string().optional().describe("Filter slots starting at or after this time (HH:MM)"),
    time_end: z.string().optional().describe("Filter slots starting before this time (HH:MM)"),
  },
  async ({ restaurant_id, day, party_size, time, time_start, time_end }) => {
    try {
      const result = await searchAvailability({
        restaurantId: restaurant_id,
        date: day,
        time,
        partySize: party_size,
      });

      const availability = result.data?.availability?.[0];
      if (!availability || !availability.availabilityDays?.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No availability found for restaurant ${restaurant_id} on ${day} for ${party_size} guests.`,
            },
          ],
        };
      }

      const lines: string[] = [];
      for (const availDay of availability.availabilityDays) {
        let slots = availDay.slots.filter((s) => s.isAvailable);

        // Filter by time window
        if (time_start || time_end) {
          slots = filterSlotsByTime(slots, time, time_start, time_end);
        }

        if (slots.length === 0) continue;

        // Compute actual date from dayOffset
        const baseDate = new Date(day + "T00:00:00");
        baseDate.setDate(baseDate.getDate() + (availDay.dayOffset || 0));
        const dateStr = baseDate.toISOString().slice(0, 10);

        lines.push(`Date: ${dateStr}`);
        const slotLines = slots.slice(0, 10).map((s) => {
          const actualTime = slotTime(time, s.timeOffsetMinutes);
          return `  ${actualTime} [token: ${s.slotAvailabilityToken}, hash: ${s.slotHash}]`;
        });
        lines.push(...slotLines);
        if (slots.length > 10) {
          lines.push(`  ... and ${slots.length - 10} more slots`);
        }
        lines.push("");
      }

      if (lines.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No available slots found for restaurant ${restaurant_id} on ${day} within the specified time range.`,
            },
          ],
        };
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

// --- Tool: opentable_find_restaurant ---
server.tool(
  "opentable_find_restaurant",
  "Look up a restaurant by name on OpenTable to get its restaurant ID. Use this before opentable_search.",
  {
    query: z.string().describe("Restaurant name to search for"),
  },
  async ({ query }) => {
    try {
      const restaurant = await findRestaurantByName(query);
      if (!restaurant) {
        return {
          content: [
            { type: "text" as const, text: `No restaurant found matching "${query}" on OpenTable.` },
          ],
        };
      }
      const parts = [
        `Found: ${restaurant.name} (ID: ${restaurant.restaurantId})`,
        restaurant.neighborhood ? `Neighborhood: ${restaurant.neighborhood}` : "",
        restaurant.cuisine ? `Cuisine: ${restaurant.cuisine}` : "",
        restaurant.priceRange ? `Price: ${"$".repeat(restaurant.priceRange)}` : "",
      ].filter(Boolean);
      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `Restaurant search failed: ${err instanceof Error ? err.message : String(err)}` },
        ],
      };
    }
  },
);

// --- Tool: opentable_discover ---
server.tool(
  "opentable_discover",
  "Discover restaurants on OpenTable near a location. Use this when the user wants to find restaurants in an area (e.g. 'find me a dinner spot in the West Village'). Returns restaurant names and IDs that can be used with opentable_search.",
  {
    lat: z.number().optional().default(40.7128).describe("Latitude (default: NYC)"),
    long: z.number().optional().default(-74.006).describe("Longitude (default: NYC)"),
    query: z.string().optional().describe("Optional search term (cuisine, restaurant name, etc.)"),
    day: z.string().describe("Date in YYYY-MM-DD format"),
    party_size: z.number().min(1).max(20).describe("Number of guests"),
    time: z
      .string()
      .optional()
      .default("19:00")
      .describe("Preferred time (HH:MM)"),
  },
  async ({ lat, long, query, day, party_size, time }) => {
    try {
      const restaurants = await searchRestaurantsByLocation({
        lat,
        long,
        date: day,
        time,
        partySize: party_size,
        query,
      });

      if (restaurants.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No restaurants found${query ? ` matching "${query}"` : ""} near that location on OpenTable.`,
            },
          ],
        };
      }

      const lines = restaurants.map((r) => {
        const parts = [
          `${r.name} (ID: ${r.restaurantId})`,
          r.neighborhood ? `${r.neighborhood}` : "",
          r.cuisine ? `${r.cuisine}` : "",
          r.priceRange ? `${"$".repeat(r.priceRange)}` : "",
        ].filter(Boolean);
        return parts.join(" | ");
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${restaurants.length} restaurants:\n${lines.join("\n")}\n\nUse opentable_search with a restaurant_id to check availability.`,
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Discovery failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

// --- Tool: opentable_slot_details ---
server.tool(
  "opentable_slot_details",
  "Get details for a specific time slot on OpenTable. Re-searches availability to get fresh slot tokens needed for booking. ALWAYS call this before opentable_book.",
  {
    restaurant_id: z.number().describe("OpenTable restaurant ID"),
    day: z.string().describe("Date in YYYY-MM-DD format"),
    time: z.string().describe("Preferred time (HH:MM)"),
    party_size: z.number().min(1).max(20).describe("Number of guests"),
  },
  async ({ restaurant_id, day, time, party_size }) => {
    try {
      const details = await getSlotDetails(restaurant_id, day, time, party_size);

      if (!details.slot) {
        return {
          content: [
            { type: "text" as const, text: `No available slot found for restaurant ${restaurant_id} on ${day} at ${time}.` },
          ],
        };
      }

      const slot = details.slot;
      const actualTime = slotTime(time, slot.timeOffsetMinutes);
      const lines = [
        `Slot: ${actualTime} on ${day}`,
        `Availability token: ${slot.slotAvailabilityToken}`,
        `Slot hash: ${slot.slotHash}`,
        `Cancellation: ${details.cancellationPolicy || "Standard policy"}`,
      ];

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

// --- Tool: opentable_book ---
server.tool(
  "opentable_book",
  "Book a reservation on OpenTable. Requires slot_availability_token and slot_hash from opentable_slot_details or opentable_search. IMPORTANT: Always confirm with the user before calling this.",
  {
    restaurant_id: z.number().describe("OpenTable restaurant ID"),
    slot_availability_token: z.string().describe("The slotAvailabilityToken from search/details"),
    slot_hash: z.string().describe("The slotHash from search/details"),
    day: z.string().describe("Date in YYYY-MM-DD format"),
    time: z.string().describe("Time in HH:MM format"),
    party_size: z.number().min(1).max(20).describe("Number of guests"),
  },
  async ({ restaurant_id, slot_availability_token, slot_hash, day, time, party_size }) => {
    try {
      const confirmation = await bookSlot({
        restaurantId: restaurant_id,
        slotAvailabilityToken: slot_availability_token,
        slotHash: slot_hash,
        date: day,
        time,
        partySize: party_size,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Reservation booked!\nConfirmation: ${confirmation.confirmationNumber}${confirmation.reservationId ? `\nReservation ID: ${confirmation.reservationId}` : ""}\n\nSave the confirmation number — you'll need it to cancel.`,
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

// --- Tool: opentable_my_reservations ---
server.tool(
  "opentable_my_reservations",
  "List all upcoming reservations on the user's OpenTable account.",
  {},
  async () => {
    try {
      const reservations = await getMyReservations();
      if (reservations.length === 0) {
        return { content: [{ type: "text" as const, text: "No upcoming OpenTable reservations." }] };
      }

      const lines = reservations.map((r) => {
        const parts = [
          r.restaurant?.name || "Unknown",
          r.dateTime || "",
          `${r.partySize} guests`,
        ].filter(Boolean);
        let line = parts.join(" | ");
        if (r.confirmationNumber) {
          line += ` [confirmation: ${r.confirmationNumber}]`;
        }
        if (r.status) {
          line += ` (${r.status})`;
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

// --- Tool: opentable_cancel ---
server.tool(
  "opentable_cancel",
  "Cancel an existing OpenTable reservation. IMPORTANT: Always confirm with the user before cancelling.",
  {
    confirmation_number: z.string().describe("The confirmation number from the reservation"),
  },
  async ({ confirmation_number }) => {
    try {
      await cancelReservation(confirmation_number);
      return { content: [{ type: "text" as const, text: "OpenTable reservation cancelled successfully." }] };
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

// --- Tool: opentable_create_monitor ---
server.tool(
  "opentable_create_monitor",
  "Create a reservation monitor that automatically books when a matching slot becomes available on OpenTable. For hard-to-get restaurants. If the user knows when the restaurant releases tables, set drop_time + drop_advance_days for precision sniping at release time. Otherwise, the monitor checks for cancellation pickups every 60 seconds.",
  {
    restaurant_name: z.string().describe("Restaurant name (will be looked up via OpenTable)"),
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
      .describe("Time when restaurant releases tables (HH:MM, e.g. '09:00')"),
    drop_advance_days: z
      .number()
      .optional()
      .describe("How many days in advance the restaurant releases tables (e.g. 30)"),
  },
  async ({ restaurant_name, party_size, time_start, time_end, date_start, date_end, chat_id, days_of_week, drop_time, drop_advance_days }) => {
    try {
      // Look up restaurant ID
      const restaurant = await findRestaurantByName(restaurant_name);
      const restaurantId = restaurant?.restaurantId ?? null;

      const result = db
        .prepare(
          `INSERT INTO opentable_monitors
           (chat_id, restaurant_name, restaurant_id, party_size, time_start, time_end, date_start, date_end, days_of_week, drop_time, drop_advance_days)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          chat_id,
          restaurant?.name ?? restaurant_name,
          restaurantId,
          party_size,
          time_start,
          time_end,
          date_start,
          date_end,
          days_of_week ?? null,
          drop_time ?? null,
          drop_advance_days ?? null,
        );

      let description = `OpenTable Monitor #${result.lastInsertRowid} created:\n`;
      description += `Restaurant: ${restaurant?.name ?? restaurant_name}${restaurantId ? ` (ID: ${restaurantId})` : " (ID not found, will retry)"}\n`;
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

// --- Tool: opentable_list_monitors ---
server.tool(
  "opentable_list_monitors",
  "List all active OpenTable reservation monitors for a chat.",
  {
    chat_id: z.number().describe("Telegram chat ID"),
  },
  async ({ chat_id }) => {
    const rows = db
      .prepare(
        `SELECT id, restaurant_name, restaurant_id, party_size, time_start, time_end,
                date_start, date_end, days_of_week, drop_time, drop_advance_days, booked_confirmation, created_at
         FROM opentable_monitors WHERE chat_id = ? AND enabled = 1 ORDER BY created_at`,
      )
      .all(chat_id) as Array<{
        id: number;
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
        booked_confirmation: string | null;
        created_at: string;
      }>;

    if (rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No active OpenTable monitors." }] };
    }

    const lines = rows.map((r) => {
      let line = `#${r.id} ${r.restaurant_name} | ${r.party_size} guests | ${r.time_start}-${r.time_end} | ${r.date_start} to ${r.date_end}`;
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
      if (r.booked_confirmation) {
        line += ` BOOKED: ${r.booked_confirmation}`;
      }
      return line;
    });

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

// --- Tool: opentable_cancel_monitor ---
server.tool(
  "opentable_cancel_monitor",
  "Cancel/disable an OpenTable reservation monitor by its ID.",
  {
    monitor_id: z.number().describe("The monitor ID to cancel"),
  },
  async ({ monitor_id }) => {
    const result = db
      .prepare("UPDATE opentable_monitors SET enabled = 0 WHERE id = ?")
      .run(monitor_id);

    if (result.changes > 0) {
      return { content: [{ type: "text" as const, text: `OpenTable monitor #${monitor_id} cancelled.` }] };
    }
    return { content: [{ type: "text" as const, text: `OpenTable monitor #${monitor_id} not found.` }] };
  },
);

// --- Helpers ---

function filterSlotsByTime(
  slots: OTSlot[],
  searchTime: string,
  timeStart?: string,
  timeEnd?: string,
): OTSlot[] {
  if (!timeStart && !timeEnd) return slots;

  return slots.filter((s) => {
    const actualTime = slotTime(searchTime, s.timeOffsetMinutes);

    if (timeStart && actualTime < timeStart) return false;
    if (timeEnd && actualTime >= timeEnd) return false;
    return true;
  });
}

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
