// Multipart upload RequestInit (attachments): the runtime sets the boundary
// Content-Type from the FormData body, so only auth goes in headers.
export function multipart(token: string, form: FormData): RequestInit {
  return { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form };
}

// RequestInit builder shared by the CRUD test files: optional bearer token,
// optional JSON body.
export function req(method: string, token?: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}
