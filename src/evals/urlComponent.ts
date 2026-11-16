/** True when a string has a UTF-16 surrogate without its pair. */
export function hasLoneSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    value
  );
}

/**
 * Percent-encodes every UTF-8 byte except `A-Z a-z 0-9 _ . ~ -`, the encoding
 * the desktop apps' deep links have always received. Unlike
 * encodeURIComponent, it also encodes `!'()*`. The caller rejects lone
 * surrogates first.
 */
export function percentEncodeUtf8(value: string): string {
  return Array.from(Buffer.from(value, 'utf8'), (byte) =>
    /[A-Za-z0-9_.~-]/.test(String.fromCharCode(byte))
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  ).join('');
}
