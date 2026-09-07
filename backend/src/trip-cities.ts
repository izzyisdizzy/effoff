// Shared "is this cityId a city on this trip" lookup. Itinerary items need the
// city's timezone to resolve wall-clock times; places only need to know it
// exists. Both answer `400 unknown_city` on a miss, so the query and the
// message live here rather than being written twice.
//
// A null cityId is always valid — items span cities (flights) and a place need
// not belong to one — so it resolves as found with no timezone.
export async function findTripCity(
  db: D1Database,
  tripId: string,
  cityId: string | null,
): Promise<{ found: boolean; timezone: string | null }> {
  if (cityId === null) {
    return { found: true, timezone: null };
  }
  const city = await db
    .prepare("SELECT timezone FROM trip_cities WHERE id = ? AND trip_id = ?")
    .bind(cityId, tripId)
    .first<{ timezone: string }>();
  if (city === null) {
    return { found: false, timezone: null };
  }
  return { found: true, timezone: city.timezone };
}

export const UNKNOWN_CITY_MESSAGE = "cityId does not refer to a city on this trip.";
