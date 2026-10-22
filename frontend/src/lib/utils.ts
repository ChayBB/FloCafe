import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * The desktop build sets `trailingSlash: true` (static export), so
 * `usePathname()` returns e.g. "/pos/" there but "/pos" in dev and in the
 * cloud build. Route comparisons must normalize through this first or they
 * silently diverge between dev and the built app. Root ("/") is untouched.
 */
export function normalizePathname(pathname: string | null | undefined): string {
  if (!pathname) return '';
  return pathname.replace(/\/+$/, '') || '/';
}

/** Parses backend UTC timestamp (YYYY-MM-DD HH:MM:SS or ISO) into Date
 * without shifting for local machine timezone offset. */
export function parseDbTimestamp(ts: string | null | undefined): Date {
  if (!ts) return new Date(NaN);
  return /^\d{4}-\d{2}-\d{2} /.test(ts) ? new Date(`${ts.replace(' ', 'T')}Z`) : new Date(ts);
}

/** Step for fractional quantity products, or null when integer-only. */
export function fractionalQuantityStep(product: {
  allow_fractional_quantity?: boolean | null | undefined;
  sale_unit?: string | null | undefined;
  weight_precision?: number | null | undefined;
}): number | null {
  if (!product.allow_fractional_quantity || product.sale_unit === 'each') return null;
  const raw = product.weight_precision;
  const precision = Number.isInteger(raw) ? Math.min(Math.max(raw as number, 0), 4) : 3;
  return 10 ** -precision;
}

/**
 * The smallest quantity this product may be sold in.
 *
 * `min_quantity` is the merchant's trading floor — a fishmonger will not weigh
 * out 20 grams. Zero or unset means no floor, in which case the smallest sale is
 * one step: one item for a counted product, one unit of precision for a weighed
 * one.
 */
export function minimumQuantity(
  product: { min_quantity?: number | null | undefined },
  step: number | null,
): number {
  const floor = step ?? 1;
  const configured = Number(product.min_quantity);
  if (!Number.isFinite(configured) || configured <= 0) return floor;
  return Math.max(floor, configured);
}

/**
 * The largest quantity this product may be sold in, or null for no cap.
 *
 * A counter that will not sell more than ten kilos on one line says so here.
 * Zero or unset means no cap; the field is then limited only by what the
 * backend will accept.
 */
export function maximumQuantity(product: {
  max_quantity?: number | null | undefined;
}): number | null {
  const configured = Number(product.max_quantity);
  return Number.isFinite(configured) && configured > 0 ? configured : null;
}

/**
 * How far one press of + or − moves the quantity.
 *
 * Not the same as the precision. A product weighed to three decimals can be
 * typed as 1.355, but a button that moved by 0.001 would take five hundred
 * presses to cross half a kilo, and one stray press left 3.004 looking like 3.
 * Precision governs what may be entered; this governs what a button does.
 */
export function quantityNudge(step: number | null): number {
  if (step == null) return 1;
  return Math.max(step, 0.1);
}

export function roundToQuantityPrecision(value: number, step: number): number {
  if (step >= 1) return Math.round(value);
  const precision = Math.round(-Math.log10(step));
  return Number(value.toFixed(precision));
}
