import { describe, expect, it } from "vitest";
import { dispositionFilename, sanitizeFilename } from "../src/attachments/filename";
import { MAX_FILENAME } from "../src/validate";

describe("sanitizeFilename", () => {
  it("keeps only the basename and strips control characters", () => {
    expect(sanitizeFilename("../../etc/passwd.png")).toBe("passwd.png");
    expect(sanitizeFilename("C:\\Users\\izzy\\ticket.pdf")).toBe("ticket.pdf");
    expect(sanitizeFilename("a\r\nX-Injected: yes.png")).toBe("aX-Injected: yes.png");
    expect(sanitizeFilename("  padded.jpg  ")).toBe("padded.jpg");
  });

  it("restores the WHATWG multipart escapes", () => {
    expect(sanitizeFilename("my %22ticket%22.jpg")).toBe('my "ticket".jpg');
    expect(sanitizeFilename("line%0Abreak%0D.png")).toBe("linebreak.png");
    // %2F is not a multipart escape and must not become a separator.
    expect(sanitizeFilename("..%2F..%2Fetc%2Fx.png")).toBe("..%2F..%2Fetc%2Fx.png");
  });

  it("returns null for names that reduce to nothing", () => {
    expect(sanitizeFilename("")).toBeNull();
    expect(sanitizeFilename("   ")).toBeNull();
    expect(sanitizeFilename("dir/")).toBeNull();
    expect(sanitizeFilename(".")).toBeNull();
    expect(sanitizeFilename("..")).toBeNull();
    expect(sanitizeFilename("\u0001\u0002")).toBeNull();
  });

  it("caps the length", () => {
    expect(sanitizeFilename("x".repeat(MAX_FILENAME + 50))).toHaveLength(MAX_FILENAME);
  });
});

describe("dispositionFilename", () => {
  it("emits printable ASCII without quotes or backslashes", () => {
    expect(dispositionFilename('my "ticket".jpg')).toBe("my ticket.jpg");
    expect(dispositionFilename("back\\slash.png")).toBe("backslash.png");
    expect(dispositionFilename("東京.pdf")).toBe("__.pdf");
    expect(dispositionFilename("tab\there.png")).toBe("tab_here.png");
  });

  it("falls back to a fixed name", () => {
    expect(dispositionFilename(null)).toBe("attachment");
    expect(dispositionFilename('""')).toBe("attachment");
  });
});
