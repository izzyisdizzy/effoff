// Membership lookup for handlers that cannot use requireTripMember: routes
// whose URL carries no trip id (GET /attachments/:id resolves the trip from
// the row) and cross-field checks like a to-do's assignee.
export async function isTripMember(
  db: D1Database,
  tripId: string,
  userId: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS yes FROM trip_members WHERE trip_id = ? AND user_id = ?")
    .bind(tripId, userId)
    .first<{ yes: number }>();
  return row !== null;
}
