/**
 * OpenTable HTTP API client.
 * Handles authentication (CSRF token + cookies), search, booking,
 * cancellation, and restaurant lookup.
 *
 * Uses OpenTable's GraphQL endpoint for availability search and
 * the /dapi/booking endpoint for reservations.
 */
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  OTSearchResponse,
  OTBookingConfirmation,
  OTReservation,
  OTRestaurantSearchResult,
  OTSlot,
} from "./types.js";

const BASE_URL = "https://www.opentable.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// Rate limiting
let lastRequestTime = 0;
const NORMAL_GAP_MS = 500;
let snipeMode = false;

let db: Database.Database;
let csrfToken: string;
let cookies: string;
let gpid: string;
let firstName: string;
let lastName: string;
let email: string;
let phone: string;

export function initOpenTableDb(dataDir: string): void {
  const dbPath = path.join(dataDir, "crabby.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS opentable_auth (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      csrf_token TEXT NOT NULL,
      cookies TEXT NOT NULL,
      gpid TEXT,
      obtained_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Load credentials from env vars or credentials file
  const credsFile =
    process.env.OPENTABLE_CREDENTIALS_FILE ||
    (() => {
      const defaultPath = path.join(dataDir, ".opentable", "credentials.json");
      try {
        readFileSync(defaultPath);
        return defaultPath;
      } catch {
        return null;
      }
    })();

  if (credsFile) {
    try {
      const creds = JSON.parse(readFileSync(credsFile, "utf-8"));
      csrfToken = creds.csrf_token;
      cookies = creds.cookies;
      gpid = creds.gpid || "";
      firstName = creds.first_name || "";
      lastName = creds.last_name || "";
      email = creds.email || "";
      phone = creds.phone || "";
    } catch {
      throw new Error(`Failed to read OpenTable credentials from ${credsFile}`);
    }
  } else {
    csrfToken = process.env.OPENTABLE_CSRF_TOKEN || "";
    cookies = process.env.OPENTABLE_COOKIES || "";
    gpid = process.env.OPENTABLE_GPID || "";
    firstName = process.env.OPENTABLE_FIRST_NAME || "";
    lastName = process.env.OPENTABLE_LAST_NAME || "";
    email = process.env.OPENTABLE_EMAIL || "";
    phone = process.env.OPENTABLE_PHONE || "";
  }

  if (!csrfToken) {
    throw new Error(
      "OpenTable credentials not configured. Set OPENTABLE_CSRF_TOKEN env var or run scripts/setup-opentable.sh.",
    );
  }

  // Cache auth in DB
  saveAuth(csrfToken, cookies, gpid);
}

// --- Auth ---

function getCachedAuth(): {
  csrfToken: string;
  cookies: string;
  gpid: string | null;
} | null {
  const row = db
    .prepare("SELECT csrf_token, cookies, gpid FROM opentable_auth WHERE id = 1")
    .get() as
    | { csrf_token: string; cookies: string; gpid: string | null }
    | undefined;
  if (!row) return null;
  return {
    csrfToken: row.csrf_token,
    cookies: row.cookies,
    gpid: row.gpid,
  };
}

function saveAuth(token: string, cookieStr: string, gpidVal: string | null): void {
  db.prepare(
    `INSERT OR REPLACE INTO opentable_auth (id, csrf_token, cookies, gpid, obtained_at)
     VALUES (1, ?, ?, ?, datetime('now'))`,
  ).run(token, cookieStr, gpidVal);
}

/** Validate that auth credentials are present. For snipe mode pre-auth. */
export async function ensureFreshAuth(): Promise<void> {
  if (!csrfToken) {
    throw new Error("OpenTable CSRF token not configured. Re-extract from browser.");
  }
}

export function setSnipeMode(enabled: boolean): void {
  snipeMode = enabled;
}

// --- HTTP helpers ---

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    "x-csrf-token": csrfToken,
  };
  if (cookies) {
    headers["Cookie"] = cookies;
  }
  return headers;
}

async function rateLimit(): Promise<void> {
  if (snipeMode) return;
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < NORMAL_GAP_MS) {
    await new Promise((resolve) => setTimeout(resolve, NORMAL_GAP_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

async function otFetch(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  await rateLimit();
  const headers = { ...buildHeaders(), ...(options.headers as Record<string, string>) };
  const res = await fetch(url, { ...options, headers });

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `OpenTable auth failed (${res.status}). CSRF token or cookies may have expired. Re-extract from browser and update credentials.`,
    );
  }

  return res;
}

// --- API functions ---

/**
 * Search for restaurant availability using OpenTable's GraphQL endpoint.
 * Uses the RestaurantsAvailability persisted query.
 */
export async function searchAvailability(params: {
  restaurantId: number;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  partySize: number;
}): Promise<OTSearchResponse> {
  const url = `${BASE_URL}/dapi/fe/gql?optype=query&opname=RestaurantsAvailability`;

  const payload = {
    operationName: "RestaurantsAvailability",
    variables: {
      restaurantIds: [params.restaurantId],
      date: params.date,
      time: params.time,
      partySize: params.partySize,
      databaseRegion: "NA",
    },
    extensions: {
      persistedQuery: {
        sha256Hash: "e6b87021ed6e865a7778aa39d35d09864c1be29c683c707602dd3de43c854d86",
      },
    },
  };

  const res = await otFetch(url, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenTable search failed (${res.status}): ${text}`);
  }

  return (await res.json()) as OTSearchResponse;
}

/**
 * Search for a restaurant by name using OpenTable's autocomplete/search.
 */
export async function findRestaurantByName(
  query: string,
): Promise<OTRestaurantSearchResult | null> {
  const url = `${BASE_URL}/dapi/fe/gql?optype=query&opname=Autocomplete`;

  const payload = {
    operationName: "Autocomplete",
    variables: {
      term: query,
      latitude: 40.7128,
      longitude: -74.006,
    },
    extensions: {
      persistedQuery: {
        sha256Hash: "af20f6e65081e1b0a5a00e3fa0e02331db3a5adab8ca22ebad5e0e4a7f3df10c",
      },
    },
  };

  const res = await otFetch(url, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenTable restaurant search failed (${res.status}): ${text}`);
  }

  const data = await res.json();

  // Response structure: data.autocomplete.restaurants[0]
  const restaurants = data?.data?.autocomplete?.restaurants;
  if (!restaurants || restaurants.length === 0) return null;

  const first = restaurants[0];
  return {
    restaurantId: first.restaurantId ?? first.rid ?? first.id,
    name: first.name,
    neighborhood: first.neighborhood,
    locality: first.locality,
    cuisine: first.primaryCuisine ?? first.cuisine,
    priceRange: first.priceRange,
  };
}

/**
 * Get details for a specific slot (cancellation policy, etc).
 * OpenTable doesn't have a direct "details" endpoint like Resy —
 * the slot info comes from the search response. This function
 * re-searches to get fresh slot data.
 */
export async function getSlotDetails(
  restaurantId: number,
  date: string,
  time: string,
  partySize: number,
): Promise<{ slot: OTSlot | null; cancellationPolicy?: string }> {
  const result = await searchAvailability({ restaurantId, date, time, partySize });

  const availability = result.data?.availability?.[0];
  if (!availability) return { slot: null };

  const day = availability.availabilityDays?.[0];
  if (!day) return { slot: null };

  // Find the closest available slot
  const availableSlots = day.slots.filter((s) => s.isAvailable);
  if (availableSlots.length === 0) return { slot: null };

  const closest = availableSlots.reduce((a, b) =>
    Math.abs(a.timeOffsetMinutes) < Math.abs(b.timeOffsetMinutes) ? a : b,
  );

  return {
    slot: closest,
    cancellationPolicy: "Standard OpenTable cancellation policy applies.",
  };
}

/**
 * Book a reservation on OpenTable.
 * Uses the /dapi/booking/make-reservation endpoint.
 */
export async function bookSlot(params: {
  restaurantId: number;
  slotAvailabilityToken: string;
  slotHash: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  partySize: number;
}): Promise<OTBookingConfirmation> {
  const url = `${BASE_URL}/dapi/booking/make-reservation`;

  const payload = {
    restaurantId: params.restaurantId,
    slotAvailabilityToken: params.slotAvailabilityToken,
    slotHash: params.slotHash,
    isModify: false,
    reservationDateTime: `${params.date}T${params.time}`,
    partySize: params.partySize,
    firstName,
    lastName,
    email,
    country: "US",
    reservationType: "Standard",
    reservationAttribute: "default",
    additionalServiceFees: [],
    tipAmount: 0,
    tipPercent: 0,
    pointsType: "Standard",
    points: 100,
    diningAreaId: 1,
    phoneNumber: phone,
    phoneNumberCountryId: "US",
    optInEmailRestaurant: false,
  };

  const res = await otFetch(url, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenTable booking failed (${res.status}): ${text}`);
  }

  const data = await res.json();

  return {
    confirmationNumber: data.confirmationNumber || data.confirmation_number || "",
    reservationId: data.reservationId || data.id,
    restaurantName: data.restaurant?.name,
    dateTime: data.dateTime,
    partySize: data.partySize,
  };
}

/**
 * List upcoming reservations on OpenTable.
 * Uses the GraphQL endpoint to fetch user's reservations.
 */
export async function getMyReservations(): Promise<OTReservation[]> {
  const url = `${BASE_URL}/dapi/fe/gql?optype=query&opname=PastAndUpcomingReservations`;

  const payload = {
    operationName: "PastAndUpcomingReservations",
    variables: {
      isUpcoming: true,
      includeCancel: false,
    },
    extensions: {
      persistedQuery: {
        sha256Hash: "63e53e384d1e50a9b3be3e1e7c102a6e17a8c14e8e37dcab9f4e32c3a7f02a9d",
      },
    },
  };

  const res = await otFetch(url, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenTable reservations failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const reservations = data?.data?.reservations?.upcoming || data?.data?.reservations || [];

  if (!Array.isArray(reservations)) return [];

  return reservations.map((r: Record<string, unknown>) => ({
    confirmationNumber: (r.confirmationNumber || r.confirmation_number || "") as string,
    reservationId: (r.reservationId || r.id) as number | undefined,
    restaurant: {
      name: ((r.restaurant as Record<string, unknown>)?.name || "Unknown") as string,
      id: ((r.restaurant as Record<string, unknown>)?.id || 0) as number,
    },
    dateTime: (r.dateTime || "") as string,
    partySize: (r.partySize || 0) as number,
    status: (r.status || "") as string,
  }));
}

/**
 * Cancel a reservation on OpenTable.
 */
export async function cancelReservation(confirmationNumber: string): Promise<void> {
  const url = `${BASE_URL}/dapi/booking/cancel-reservation`;

  const payload = {
    confirmationNumber,
  };

  const res = await otFetch(url, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenTable cancellation failed (${res.status}): ${text}`);
  }
}
