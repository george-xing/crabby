/** OpenTable API response types. Intentionally loose — unofficial API may change. */

export interface OTSlot {
  dateTime: string; // "2026-03-15T19:00"
  isAvailable: boolean;
  timeOffsetMinutes: number;
  slotAvailabilityToken: string;
  slotHash: string;
}

export interface OTAvailabilityDay {
  date: string;
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
