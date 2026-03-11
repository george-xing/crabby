/** Resy API response types. Intentionally loose — unofficial API may change. */

export interface ResyAuthResponse {
  id: number;
  token: string;
  payment_method_id?: number;
  payment_methods?: Array<{ id: number; is_default?: boolean }>;
}

export interface ResySlot {
  config: {
    id: string;
    token: string;
    type: string;
  };
  date: {
    start: string; // "2026-03-15 19:00:00"
    end: string;
  };
  size?: {
    min: number;
    max: number;
  };
}

export interface ResyVenueResult {
  venue: {
    id: { resy: number };
    name: string;
    location: {
      neighborhood?: string;
      address_1?: string;
      city?: string;
      state?: string;
    };
    cuisine?: string[];
    price_range?: number;
    rating?: number | null;
    tagline?: string;
  };
  slots: ResySlot[];
}

export interface ResySearchResponse {
  results: {
    venues: ResyVenueResult[];
  };
}

export interface ResyVenueSearchResponse {
  search: {
    hits: Array<{
      id: { resy: number };
      name: string;
      location?: {
        neighborhood?: string;
        city?: string;
      };
    }>;
  };
}

export interface ResySlotDetails {
  book_token: {
    value: string;
    date_expires: string;
  };
  cancellation?: {
    fee?: { amount: number } | null;
    policy?: string[];
  };
  payment?: {
    deposit?: { amount: number } | null;
  };
  config?: {
    double_confirmation?: string[];
  };
}

export interface ResyBookingConfirmation {
  resy_token: string;
  reservation_id?: number;
}

export interface ResyReservation {
  resy_token: string;
  reservation_id?: number;
  venue: {
    name: string;
    location?: {
      neighborhood?: string;
    };
  };
  day: string;
  num_seats: number;
  time_slot: string;
  cancellation?: {
    allowed?: boolean;
    fee?: { amount: number } | null;
  };
}
