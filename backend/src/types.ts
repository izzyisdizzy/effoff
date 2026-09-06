// Row types mirror the D1 schema (backend/migrations); snake_case columns.

export type UserRow = {
  id: string;
  auth_provider: string;
  auth_subject: string;
  email: string | null;
  display_name: string;
  created_at: string;
  updated_at: string;
};

export type SessionRow = {
  token_hash: string;
  user_id: string;
  client: "web" | "ios";
  created_at: string;
  expires_at: string;
};

export type InviteRow = {
  token: string;
  trip_id: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
};

// Hono type environment for every route: D1 bindings plus the per-request
// context that requireSession loads. The Variables are typed non-optional in
// the usual Hono idiom, so reading them is only safe in handlers chained
// after requireSession — requireTripMember carries a runtime backstop.
export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: UserRow;
    session: SessionRow;
  };
};

// The user object as the API returns it (camelCase, no auth internals).
export function publicUser(user: UserRow): {
  id: string;
  email: string | null;
  displayName: string;
} {
  return { id: user.id, email: user.email, displayName: user.display_name };
}
