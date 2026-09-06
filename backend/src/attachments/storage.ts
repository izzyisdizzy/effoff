// R2 key layout and bulk deletion for attachment objects.

// Keyed under the trip so a prefix list can find every object for a trip
// even if the D1 rows are gone (a backstop; the routes work from the rows).
export function attachmentKey(tripId: string, attachmentId: string): string {
  return `trips/${tripId}/${attachmentId}`;
}

// R2's bulk delete takes at most 1000 keys per call.
const DELETE_BATCH = 1000;

export async function deleteObjects(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    await bucket.delete(keys.slice(i, i + DELETE_BATCH));
  }
}
