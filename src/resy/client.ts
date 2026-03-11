/**
 * Resy HTTP API client.
 * Handles authentication (email/password login with JWT caching),
 * search, booking, cancellation, and venue lookup.
 */
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  ResyAuthResponse,
  ResyBookingConfirmation,
  ResyReservation,
  ResySearchResponse,
  ResySlotDetails,
  ResyVenueSearchResponse,
} from "./types.js";

const BASE_URL = "https://api.resy.com";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// Rate limiting
let lastRequestTime = 0;
const NORMAL_GAP_MS = 500;
let snipeMode = false;

let db: Database.Database;
let apiKey: string;
let email: string;
let password: string;

export function initResyDb(dataDir: string): void {
  const dbPath = path.join(dataDir, "crabby.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS resy_auth (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      auth_token TEXT NOT NULL,
      payment_method_id TEXT,
      token_expires_at TEXT,
      obtained_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Load credentials from env vars or credentials file
  const credsFile =
    process.env.RESY_CREDENTIALS_FILE ||
    (() => {
      // Check default location in data dir
      const defaultPath = path.join(dataDir, ".resy", "credentials.json");
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
      apiKey = creds.api_key;
      email = creds.email;
      password = creds.password;
    } catch {
      throw new Error(`Failed to read Resy credentials from ${credsFile}`);
    }
  } else {
    apiKey = process.env.RESY_API_KEY || "";
    email = process.env.RESY_EMAIL || "";
    password = process.env.RESY_PASSWORD || "";
  }

  if (!apiKey || !email || !password) {
    throw new Error(
      "Resy credentials not configured. Set RESY_API_KEY, RESY_EMAIL, RESY_PASSWORD env vars.",
    );
  }
}

// --- Auth ---

function decodeJwtExp(token: string): Date | null {
  try {
    const payload = token.split(".")[1];
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (decoded.exp) {
      return new Date(decoded.exp * 1000);
    }
  } catch {
    // not a JWT or missing exp
  }
  return null;
}

function getCachedAuth(): {
  token: string;
  paymentMethodId: string | null;
  expiresAt: string | null;
} | null {
  const row = db
    .prepare("SELECT auth_token, payment_method_id, token_expires_at FROM resy_auth WHERE id = 1")
    .get() as
    | { auth_token: string; payment_method_id: string | null; token_expires_at: string | null }
    | undefined;
  if (!row) return null;
  return {
    token: row.auth_token,
    paymentMethodId: row.payment_method_id,
    expiresAt: row.token_expires_at,
  };
}

function saveAuth(token: string, paymentMethodId: string | null, expiresAt: Date | null): void {
  db.prepare(
    `INSERT OR REPLACE INTO resy_auth (id, auth_token, payment_method_id, token_expires_at, obtained_at)
     VALUES (1, ?, ?, ?, datetime('now'))`,
  ).run(token, paymentMethodId, expiresAt?.toISOString() ?? null);
}

async function login(): Promise<{ token: string; paymentMethodId: string | null }> {
  const res = await fetch(`${BASE_URL}/3/auth/password`, {
    method: "POST",
    headers: {
      Authorization: `ResyAPI api_key="${apiKey}"`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resy login failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as ResyAuthResponse;
  const token = data.token;
  const paymentMethodId =
    data.payment_method_id?.toString() ??
    data.payment_methods?.[0]?.id?.toString() ??
    null;

  const expiresAt = decodeJwtExp(token);
  saveAuth(token, paymentMethodId, expiresAt);

  return { token, paymentMethodId };
}

async function getAuthToken(): Promise<string> {
  const cached = getCachedAuth();
  if (cached) {
    // Check if token is still valid (at least 1 hour remaining)
    if (cached.expiresAt) {
      const expiry = new Date(cached.expiresAt);
      const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
      if (expiry > oneHourFromNow) {
        return cached.token;
      }
    } else {
      // No expiry info — check if obtained within last 7 days as a safe fallback
      return cached.token;
    }
  }

  const { token } = await login();
  return token;
}

function getPaymentMethodId(): string | null {
  const cached = getCachedAuth();
  return cached?.paymentMethodId ?? null;
}

/** Force re-authentication if token expires within 2 hours. For snipe mode pre-auth. */
export async function ensureFreshAuth(): Promise<void> {
  const cached = getCachedAuth();
  if (cached?.expiresAt) {
    const expiry = new Date(cached.expiresAt);
    const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
    if (expiry <= twoHoursFromNow) {
      await login();
      return;
    }
  }
  // If no cached auth at all, login
  if (!cached) {
    await login();
  }
}

export function setSnipeMode(enabled: boolean): void {
  snipeMode = enabled;
}

// --- HTTP helpers ---

function buildHeaders(authToken: string): Record<string, string> {
  return {
    Authorization: `ResyAPI api_key="${apiKey}"`,
    "x-resy-auth-token": authToken,
    "x-resy-universal-auth": authToken,
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
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

async function resyFetch(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  await rateLimit();
  const token = await getAuthToken();
  const headers = { ...buildHeaders(token), ...(options.headers as Record<string, string>) };
  const res = await fetch(url, { ...options, headers });

  // Retry once on 401 (token may have been revoked)
  if (res.status === 401) {
    const { token: newToken } = await login();
    const retryHeaders = { ...buildHeaders(newToken), ...(options.headers as Record<string, string>) };
    return fetch(url, { ...options, headers: retryHeaders });
  }

  return res;
}

// --- API functions ---

export async function searchVenues(params: {
  lat: number;
  long: number;
  day: string;
  party_size: number;
  venue_id?: number;
}): Promise<ResySearchResponse> {
  const query = new URLSearchParams({
    lat: params.lat.toString(),
    long: params.long.toString(),
    day: params.day,
    party_size: params.party_size.toString(),
  });
  if (params.venue_id) {
    query.set("venue_id", params.venue_id.toString());
  }

  const res = await resyFetch(`${BASE_URL}/4/find?${query}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resy search failed (${res.status}): ${text}`);
  }

  return (await res.json()) as ResySearchResponse;
}

export async function findVenueByName(
  query: string,
): Promise<{ id: number; name: string; neighborhood?: string } | null> {
  const res = await resyFetch(`${BASE_URL}/3/venuesearch/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resy venue search failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as ResyVenueSearchResponse;
  const hit = data.search?.hits?.[0];
  if (!hit) return null;

  return {
    id: hit.id.resy,
    name: hit.name,
    neighborhood: hit.location?.neighborhood,
  };
}

export async function getSlotDetails(
  configToken: string,
  day: string,
  partySize: number,
): Promise<ResySlotDetails> {
  const query = new URLSearchParams({
    config_id: configToken,
    day,
    party_size: partySize.toString(),
  });

  const res = await resyFetch(`${BASE_URL}/3/details?${query}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resy slot details failed (${res.status}): ${text}`);
  }

  return (await res.json()) as ResySlotDetails;
}

export async function bookSlot(bookToken: string): Promise<ResyBookingConfirmation> {
  const paymentMethodId = getPaymentMethodId();

  const body = new URLSearchParams({
    book_token: bookToken,
    source_id: "resy.com-venue-details",
  });
  if (paymentMethodId) {
    body.set("struct_payment_method", JSON.stringify({ id: parseInt(paymentMethodId, 10) }));
  }

  const res = await resyFetch(`${BASE_URL}/3/book`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://widgets.resy.com",
      Referer: "https://widgets.resy.com/",
      "Cache-Control": "no-cache",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resy booking failed (${res.status}): ${text}`);
  }

  return (await res.json()) as ResyBookingConfirmation;
}

export async function getMyReservations(): Promise<ResyReservation[]> {
  const query = new URLSearchParams({
    limit: "20",
    offset: "1",
    type: "upcoming",
  });

  const res = await resyFetch(`${BASE_URL}/3/user/reservations?${query}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resy reservations failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  // Response structure may vary; handle both array and object forms
  if (Array.isArray(data)) return data as ResyReservation[];
  if (data.reservations) return data.reservations as ResyReservation[];
  return [];
}

export async function cancelReservation(resyToken: string): Promise<void> {
  const body = new URLSearchParams({ resy_token: resyToken });

  const res = await resyFetch(`${BASE_URL}/3/cancel`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://widgets.resy.com",
      Referer: "https://widgets.resy.com/",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resy cancellation failed (${res.status}): ${text}`);
  }
}
