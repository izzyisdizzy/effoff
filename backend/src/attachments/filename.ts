import { MAX_FILENAME } from "../validate";

// The original upload name is display-only, but it is echoed into
// Content-Disposition, so reduce it to a plain basename: no path segments,
// no control characters, capped. Empty after cleanup means "no name".
export function sanitizeFilename(raw: string): string | null {
  // Multipart parsing percent-encodes the three characters a filename part
  // cannot carry literally (WHATWG: `"` → %22, LF → %0A, CR → %0D); restore
  // the quote and drop the line breaks so the stored name is the real one.
  // Known ambiguity: a name that literally contained the text %22 decodes to
  // a quote too — display-only, and the quote is stripped again for the
  // header, so the trade-off is accepted. %2F is deliberately not decoded.
  const decoded = raw.replace(/%22/g, '"').replace(/%0[AD]/gi, "");
  const base = decoded.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    return null;
  }
  return cleaned.slice(0, MAX_FILENAME);
}

// Header-safe form of the stored name for Content-Disposition: printable
// ASCII only, no quotes or backslashes (RFC 5987 encoding is a later nicety).
export function dispositionFilename(filename: string | null): string {
  const ascii = (filename ?? "").replace(/["\\]/g, "").replace(/[^\x20-\x7e]/g, "_");
  return ascii.length === 0 ? "attachment" : ascii;
}
