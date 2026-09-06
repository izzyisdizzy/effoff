import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// Every non-2xx response body in the API uses this shape (docs/foundation.md
// API shape; established with #7 so later endpoints stay consistent).
export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
): Response {
  return c.json({ error: { code, message } }, status);
}
