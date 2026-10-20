/** Longest Base64 data URI accepted for a stored image, matching the frontend compressor's target. */
export const MAX_IMAGE_DATA_URI_LENGTH = 50_000;

/**
 * Validates a stored image as a Base64 data URI.
 *
 * Images are kept inline rather than as files so a database copy is a complete
 * backup; the length cap is what keeps that affordable.
 */
export function validateImageDataUri(
  value: unknown,
  options: { field?: string; maxLength?: number } = {},
): { valid: boolean; error?: string } {
  const field = options.field || 'image_url';
  const maxLength = options.maxLength ?? MAX_IMAGE_DATA_URI_LENGTH;
  if (value === null || value === undefined) {
    return { valid: true }; // null means "clear the image"
  }
  if (typeof value !== 'string') {
    return { valid: false, error: `${field} must be a string or null` };
  }
  if (value === '') {
    return { valid: true };
  }
  if (!value.startsWith('data:image/')) {
    return { valid: false, error: `${field} must be a Base64 data URI` };
  }
  if (!/^data:image\/(webp|png|jpeg|jpg);base64,/.test(value)) {
    return { valid: false, error: 'Invalid image format. Supported: webp, png, jpeg' };
  }
  if (value.length > maxLength) {
    return {
      valid: false,
      error: `Image too large (max ${maxLength.toLocaleString('en-US')} characters)`,
    };
  }
  return { valid: true };
}
