/** OpenTable API response types. Intentionally loose — unofficial API may change. */

export interface OTSlot {
  isAvailable: boolean;
  timeOffsetMinutes: number; // offset from search time in minutes (e.g. 180 = +3h)
  slotAvailabilityToken: string;
  slotHash: string;
  __typename?: string;
}

export interface OTAvailabilityDay {
  dayOffset: number; // 0 = search date, 1 = next day, etc.
  slots: OTSlot[];
}

export interface OTAvailabilityResult {
  restaurantId: number;
  availabilityDays: OTAvailabilityDay[];
}

export interface OTSearchResponse {
  data: {
    availability: OTAvailabilityResult[];
  };
}

/** Compute the actual HH:MM time string from search time + offset minutes. */
export function slotTime(searchTime: string, offsetMinutes: number): string {
  const [h, m] = searchTime.split(":").map(Number);
  const totalMinutes = h * 60 + m + offsetMinutes;
  const hour = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}

export interface OTBookingConfirmation {
  confirmationNumber: string;
  reservationId?: number;
  restaurantName?: string;
  dateTime?: string;
  partySize?: number;
}

export interface OTReservation {
  confirmationNumber: string;
  reservationId?: number;
  restaurant: {
    name: string;
    id: number;
  };
  dateTime: string;
  partySize: number;
  status?: string;
}

export interface OTRestaurantSearchResult {
  restaurantId: number;
  name: string;
  neighborhood?: string;
  locality?: string;
  cuisine?: string;
  priceRange?: number;
}
