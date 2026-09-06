import { describe, expect, it } from "vitest";
import { sniffMime } from "../src/attachments/sniff";
import { GIF, JPEG, PDF, PNG, WEBP } from "./fixtures";

describe("sniffMime", () => {
  it("recognizes each allowed type from its magic bytes", () => {
    expect(sniffMime(JPEG)).toBe("image/jpeg");
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(WEBP)).toBe("image/webp");
    expect(sniffMime(GIF)).toBe("image/gif");
    expect(sniffMime(PDF)).toBe("application/pdf");
  });

  it("rejects everything else, including near misses", () => {
    expect(sniffMime(new TextEncoder().encode("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffMime(new Uint8Array())).toBeNull();
    // RIFF container that is not WebP (e.g. WAV).
    expect(sniffMime(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt "))).toBeNull();
    // Truncated PNG signature.
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    // ftyp/HEIC is deliberately unsupported.
    expect(sniffMime(new TextEncoder().encode("\0\0\0\x18ftypheic"))).toBeNull();
  });
});
