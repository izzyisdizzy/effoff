// Content sniffing for uploads. The stored/served Content-Type comes from the
// bytes, never from the client's declared type, so a mislabeled HTML file can
// never be served inline as HTML. The allowlist is what booking capture
// consumes downstream: the Claude API accepts JPEG/PNG/WebP/GIF images and
// PDFs (HEIC is deliberately absent — iOS transcodes to JPEG before upload).

export const ATTACHMENT_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
] as const;
export type AttachmentMime = (typeof ATTACHMENT_MIMES)[number];

// Longest signature we inspect: RIFF....WEBP needs 12 bytes.
export const SNIFF_BYTES = 12;

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

export function sniffMime(bytes: Uint8Array): AttachmentMime | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  // "RIFF" <4-byte size> "WEBP"
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  // "GIF8" (GIF87a / GIF89a)
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return "image/gif";
  }
  // "%PDF-"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return "application/pdf";
  }
  return null;
}
