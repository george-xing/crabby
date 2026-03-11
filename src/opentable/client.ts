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

// Auth failure notification callback — set by monitor to notify via Telegram
let authFailureCallback: ((message: string) => Promise<void>) | null = null;

let db: Database.Database;
let csrfToken: string;
let cookies: string;
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
  saveAuth(csrfToken, cookies);
}

// --- Auth ---

function getCachedAuth(): {
  csrfToken: string;
  cookies: string;
  obtainedAt: string;
} | null {
  const row = db
    .prepare("SELECT csrf_token, cookies, obtained_at FROM opentable_auth WHERE id = 1")
    .get() as
    | { csrf_token: string; cookies: string; obtained_at: string }
    | undefined;
  if (!row) return null;
  return {
    csrfToken: row.csrf_token,
    cookies: row.cookies,
    obtainedAt: row.obtained_at,
  };
}

function saveAuth(token: string, cookieStr: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO opentable_auth (id, csrf_token, cookies, obtained_at)
     VALUES (1, ?, ?, datetime('now'))`,
  ).run(token, cookieStr);
}

/** Register a callback for auth failure notifications (used by monitor for Telegram alerts). */
export function onAuthFailure(callback: (message: string) => Promise<void>): void {
  authFailureCallback = callback;
}

/**
 * Validate that auth credentials are present and not stale.
 * Unlike Resy (which can auto-refresh JWTs), OpenTable CSRF tokens require
 * manual re-extraction from the browser. This checks token age and warns
 * if credentials are likely expired.
 */
export async function ensureFreshAuth(): Promise<void> {
  if (!csrfToken) {
    const msg = "OpenTable CSRF token not configured. Re-extract from browser and run scripts/setup-opentable.sh.";
    if (authFailureCallback) await authFailureCallback(msg);
    throw new Error(msg);
  }

  // Check token age — CSRF tokens typically expire within hours
  const cached = getCachedAuth();
  if (cached) {
    const obtainedAt = new Date(cached.obtainedAt);
    const ageHours = (Date.now() - obtainedAt.getTime()) / (1000 * 60 * 60);
    if (ageHours > 12) {
      const msg = `OpenTable credentials are ${Math.round(ageHours)} hours old and may have expired. Re-extract CSRF token and cookies from browser dev tools and update credentials.`;
      if (authFailureCallback) await authFailureCallback(msg);
    }
  }

  // Validate with a lightweight request
  try {
    await rateLimit();
    const res = await fetch(`${BASE_URL}/dapi/fe/gql?optype=query&opname=RestaurantsAvailability`, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({
        operationName: "RestaurantsAvailability",
        variables: { restaurantIds: [1], date: "2099-01-01", time: "19:00", partySize: 2, databaseRegion: "NA" },
        extensions: { persistedQuery: { sha256Hash: "e6b87021ed6e865a7778aa39d35d09864c1be29c683c707602dd3de43c854d86" } },
      }),
    });
    lastRequestTime = Date.now();
    if (res.status === 401 || res.status === 403) {
      const msg = "OpenTable auth validation failed — CSRF token or cookies have expired. Re-extract from browser dev tools and run scripts/setup-opentable.sh.";
      if (authFailureCallback) await authFailureCallback(msg);
      throw new Error(msg);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("auth validation failed")) throw err;
    // Network error — don't block snipe, just warn
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
    const msg = `OpenTable auth failed (${res.status}). CSRF token or cookies have expired. Re-extract from browser dev tools and run scripts/setup-opentable.sh to update credentials.`;
    // Notify via Telegram if callback is registered
    if (authFailureCallback) {
      authFailureCallback(msg).catch(() => {});
    }
    throw new Error(msg);
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
        sha256Hash: "fe1d118abd4c227750693027c2414d43014c2493f64f49bcef5a65274ce9c3c3",
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
 * Search for restaurants with availability by location.
 * Uses OpenTable's REST availability endpoint to discover restaurants
 * near given coordinates, similar to Resy's lat/long search.
 */
export async function searchRestaurantsByLocation(params: {
  lat: number;
  long: number;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  partySize: number;
  query?: string;
}): Promise<OTRestaurantSearchResult[]> {
  const searchParams = new URLSearchParams({
    datetime: `${params.date}T${params.time}`,
    covers: params.partySize.toString(),
    latitude: params.lat.toString(),
    longitude: params.long.toString(),
    language: "en-US",
    pageSize: "10",
  });
  if (params.query) {
    searchParams.set("term", params.query);
  }

  const url = `${BASE_URL}/dapi/fe/gql?optype=query&opname=RestaurantsAvailability`;

  // For location search, use multi-restaurant availability with geo params
  // Fall back to the autocomplete + individual availability approach
  const results: OTRestaurantSearchResult[] = [];

  // Step 1: Search for restaurants near the location
  const searchUrl = `${BASE_URL}/dapi/fe/gql?optype=query&opname=Autocomplete`;
  const payload = {
    operationName: "Autocomplete",
    variables: {
      term: params.query || "restaurant",
      latitude: params.lat,
      longitude: params.long,
    },
    extensions: {
      persistedQuery: {
        sha256Hash: "fe1d118abd4c227750693027c2414d43014c2493f64f49bcef5a65274ce9c3c3",
      },
    },
  };

  const res = await otFetch(searchUrl, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!res.ok) return results;

  const data = await res.json();
  const restaurants = data?.data?.autocomplete?.restaurants;
  if (!Array.isArray(restaurants)) return results;

  for (const r of restaurants.slice(0, 10)) {
    results.push({
      restaurantId: r.restaurantId ?? r.rid ?? r.id,
      name: r.name,
      neighborhood: r.neighborhood,
      locality: r.locality,
      cuisine: r.primaryCuisine ?? r.cuisine,
      priceRange: r.priceRange,
    });
  }

  return results;
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
 * Uses the REST booking API — the reservations page doesn't use a GraphQL query.
 */
export async function getMyReservations(): Promise<OTReservation[]> {
  const url = `${BASE_URL}/dapi/booking/upcoming-reservations`;

  const res = await otFetch(url, { method: "GET" });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenTable reservations failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const reservations = Array.isArray(data) ? data : (data?.items || data?.reservations || []);

  if (!Array.isArray(reservations)) return [];

  return reservations.map((r: Record<string, unknown>) => ({
    confirmationNumber: (r.confirmationNumber || r.confirmation_number || "") as string,
    reservationId: (r.reservationId || r.id) as number | undefined,
    restaurant: {
      name: ((r.restaurant as Record<string, unknown>)?.name || (r.restaurantName as string) || "Unknown") as string,
      id: ((r.restaurant as Record<string, unknown>)?.id || (r.restaurantId as number) || 0) as number,
    },
    dateTime: (r.dateTime || r.reservationDateTime || "") as string,
    partySize: (r.partySize || r.covers || 0) as number,
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
