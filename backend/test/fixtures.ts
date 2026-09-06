// Minimal byte fixtures for attachment tests: valid magic bytes followed by
// filler. The sniffer only inspects the signature, so these need not be
// decodable files.

function withSignature(signature: number[], length = 64): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(signature);
  for (let i = signature.length; i < length; i++) {
    bytes[i] = i % 251;
  }
  return bytes;
}

export const JPEG = withSignature([0xff, 0xd8, 0xff, 0xe0]);
export const PNG = withSignature([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const GIF = withSignature([...new TextEncoder().encode("GIF89a")]);
export const PDF = withSignature([...new TextEncoder().encode("%PDF-1.7\n")]);
export const WEBP = withSignature([
  ...new TextEncoder().encode("RIFF"),
  0x24,
  0x00,
  0x00,
  0x00,
  ...new TextEncoder().encode("WEBPVP8 "),
]);
