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

export type TripRow = {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type TripCityRow = {
  id: string;
  trip_id: string;
  name: string;
  timezone: string;
  arrival_date: string | null;
  departure_date: string | null;
  position: number;
  created_at: string;
  updated_at: string;
};

export const ITEM_KINDS = ["flight", "stay", "reservation", "activity"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export type ItineraryItemRow = {
  id: string;
  trip_id: string;
  city_id: string | null;
  kind: ItemKind;
  title: string;
  notes: string | null;
  address: string | null;
  confirmation_number: string | null;
  links: string | null;
  start_local: string | null;
  start_tz: string | null;
  end_local: string | null;
  end_tz: string | null;
  start_utc: string | null;
  end_utc: string | null;
  departure_airport: string | null;
  arrival_airport: string | null;
  position: number | null;
  created_at: string;
  updated_at: string;
};

export type TodoRow = {
  id: string;
  trip_id: string;
  title: string;
  done: number;
  due_local: string | null;
  due_tz: string | null;
  assignee_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export type AttachmentRow = {
  id: string;
  trip_id: string;
  itinerary_item_id: string | null;
  r2_key: string;
  mime_type: string;
  byte_size: number;
  filename: string | null;
  uploaded_by: string;
  created_at: string;
  updated_at: string;
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

export function publicTrip(trip: TripRow): {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: trip.id,
    name: trip.name,
    createdBy: trip.created_by,
    createdAt: trip.created_at,
    updatedAt: trip.updated_at,
  };
}

// A trip_members row joined with its user, as the trip doc returns it: the
// public user shape plus the member's presence window.
export type MemberWithUserRow = {
  user_id: string;
  arrival_date: string | null;
  departure_date: string | null;
  email: string | null;
  display_name: string;
};

export function publicMember(member: MemberWithUserRow): {
  id: string;
  email: string | null;
  displayName: string;
  arrivalDate: string | null;
  departureDate: string | null;
} {
  return {
    id: member.user_id,
    email: member.email,
    displayName: member.display_name,
    arrivalDate: member.arrival_date,
    departureDate: member.departure_date,
  };
}

export function publicCity(city: TripCityRow): {
  id: string;
  name: string;
  timezone: string;
  arrivalDate: string | null;
  departureDate: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: city.id,
    name: city.name,
    timezone: city.timezone,
    arrivalDate: city.arrival_date,
    departureDate: city.departure_date,
    position: city.position,
    createdAt: city.created_at,
    updatedAt: city.updated_at,
  };
}

// One malformed row must not turn every trip-doc read into a 500, so the
// stored JSON is parsed defensively down to an array of strings.
function parseLinks(links: string | null): string[] {
  if (links === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(links);
    return Array.isArray(parsed)
      ? parsed.filter((link): link is string => typeof link === "string")
      : [];
  } catch {
    return [];
  }
}

export function publicItem(item: ItineraryItemRow): {
  id: string;
  cityId: string | null;
  kind: ItemKind;
  title: string;
  notes: string | null;
  address: string | null;
  confirmationNumber: string | null;
  links: string[];
  startLocal: string | null;
  startTz: string | null;
  endLocal: string | null;
  endTz: string | null;
  startUtc: string | null;
  endUtc: string | null;
  departureAirport: string | null;
  arrivalAirport: string | null;
  position: number | null;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: item.id,
    cityId: item.city_id,
    kind: item.kind,
    title: item.title,
    notes: item.notes,
    address: item.address,
    confirmationNumber: item.confirmation_number,
    // Stored as JSON text (schema: display-only array of URLs); an absent
    // column serializes as the empty list rather than null.
    links: parseLinks(item.links),
    startLocal: item.start_local,
    startTz: item.start_tz,
    endLocal: item.end_local,
    endTz: item.end_tz,
    startUtc: item.start_utc,
    endUtc: item.end_utc,
    departureAirport: item.departure_airport,
    arrivalAirport: item.arrival_airport,
    position: item.position,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

// Metadata only; the bytes are fetched from GET /api/v1/attachments/:id,
// which clients build from the id (no url field, like every other resource).
export function publicAttachment(attachment: AttachmentRow): {
  id: string;
  itineraryItemId: string | null;
  mimeType: string;
  byteSize: number;
  filename: string | null;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: attachment.id,
    itineraryItemId: attachment.itinerary_item_id,
    mimeType: attachment.mime_type,
    byteSize: attachment.byte_size,
    filename: attachment.filename,
    uploadedBy: attachment.uploaded_by,
    createdAt: attachment.created_at,
    updatedAt: attachment.updated_at,
  };
}

export function publicTodo(todo: TodoRow): {
  id: string;
  title: string;
  done: boolean;
  dueLocal: string | null;
  dueTz: string | null;
  assigneeUserId: string | null;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: todo.id,
    title: todo.title,
    done: todo.done === 1,
    dueLocal: todo.due_local,
    dueTz: todo.due_tz,
    assigneeUserId: todo.assignee_user_id,
    createdAt: todo.created_at,
    updatedAt: todo.updated_at,
  };
}
