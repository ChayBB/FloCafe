/**
 * Email typed on a physical keyboard picks up characters the user never meant:
 * a dead-key caret, a pasted trailing space, a zero-width character from a chat
 * app. The browser then blocks the form with its own cryptic message
 * ("A part followed by '@' should not contain the symbol '^'") and the field
 * still *looks* correct, so nothing on screen explains the refusal.
 */

// Whitespace plus the invisible ranges that survive a copy/paste.
const INVISIBLE = /[\s\u0000-\u001f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g;

/** HTML5's own `input[type=email]` rule, so our check and the browser's agree. */
const HTML5_EMAIL = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** Drops characters that can never belong in an email address. */
export function sanitizeEmailInput(value: string): string {
  return value.replace(INVISIBLE, '');
}

export function isValidEmailInput(value: string): boolean {
  return HTML5_EMAIL.test(sanitizeEmailInput(value).trim());
}

/**
 * The characters that make an address invalid, de-duplicated and ready to show.
 * Returns an empty string when the address is malformed for some other reason
 * (a missing `@`, say) so callers can fall back to a generic message.
 */
export function invalidEmailCharacters(value: string): string {
  const cleaned = sanitizeEmailInput(value).trim();
  const [localPart, ...domainParts] = cleaned.split('@');
  const domain = domainParts.join('@');
  const bad = new Set<string>();
  for (const character of localPart) {
    if (!/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]/.test(character)) bad.add(character);
  }
  for (const character of domain) {
    if (!/[a-zA-Z0-9.-]/.test(character)) bad.add(character);
  }
  return [...bad].join(' ');
}
