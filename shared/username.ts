/**
 * Username rules, shared by the API and the staff form so the two cannot drift.
 *
 * A username is a sign-in identifier for staff who have no email address. It is
 * typed by the person themselves at the start of a shift, so it has to be
 * writable in their own script — Thai, Arabic, Cyrillic — not just ASCII. The
 * restrictions that remain are the ones that would otherwise cause a real
 * failure, not stylistic ones.
 */

/**
 * Zero-width joiners, soft hyphens, bidi overrides and control codes: invisible,
 * so a person cannot see them to delete them. Written as escapes rather than
 * literals so the source stays readable and greppable.
 */
const INVISIBLE = /[\u0000-\u001F\u007F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu;

/** Letters, combining marks (Thai vowels and tones live here), digits, and `. _ -`. */
const ALLOWED_RUN = '[\\p{L}\\p{M}\\p{N}._-]';
const USERNAME_SHAPE = new RegExp(`^${ALLOWED_RUN}+(?: ${ALLOWED_RUN}+)*$`, 'u');

// Two, not three: Thai nicknames are routinely two characters long
// (นก, ฝน), and a password still stands behind the identifier.
export const USERNAME_MIN = 2;
export const USERNAME_MAX = 32;

/**
 * Cleans up a typed username without silently changing what it says.
 *
 * Only invisible characters are removed, and only because a person cannot see
 * them to delete them. Everything visible is left alone so validation can
 * explain the problem instead of the field appearing to eat what was typed.
 * NFC matters for Thai: the same word can arrive as different code points
 * depending on the keyboard, and two spellings that look identical must not
 * become two accounts.
 */
export function normalizeUsername(value: unknown): string {
  return String(value ?? '')
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Code points, not UTF-16 units — a Thai name should not count double. */
export function usernameLength(value: string): number {
  return [...value].length;
}

export type UsernameProblem = 'too_short' | 'too_long' | 'looks_like_email' | 'bad_characters';

/** Returns why a username is unacceptable, or null when it is fine. */
export function checkUsername(value: string): UsernameProblem | null {
  if (value.includes('@')) return 'looks_like_email';
  const length = usernameLength(value);
  if (length < USERNAME_MIN) return 'too_short';
  if (length > USERNAME_MAX) return 'too_long';
  if (!USERNAME_SHAPE.test(value)) return 'bad_characters';
  return null;
}

/**
 * The form used for comparing two identifiers.
 *
 * `toLowerCase` is a no-op for scripts without case, such as Thai, and folds the
 * ones that have it. Comparison happens here rather than in SQL because
 * SQLite's `LOWER()` only folds ASCII, so `JOSÉ` and `josé` would slip past it
 * as two separate accounts.
 */
export function usernameKey(value: string): string {
  return normalizeUsername(value).toLowerCase();
}
