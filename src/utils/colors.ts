/**
 * ANSI color helpers with NO_COLOR / FORCE_COLOR / CI support.
 * Zero dependencies — pure escape codes.
 * @module utils/colors
 */

const forceColor = process.env.FORCE_COLOR === '1' || process.env.FORCE_COLOR === 'true';
const noColor =
  process.env.NO_COLOR !== undefined ||
  process.argv.includes('--no-color') ||
  (!process.stdout.isTTY && !forceColor) ||
  (process.env.CI === 'true' && !forceColor);

export const enabled = !noColor;

const c = (code: string): string => (noColor ? '' : code);

export const reset = c('\x1b[0m');
export const bold = c('\x1b[1m');
export const dim = c('\x1b[2m');
export const italic = c('\x1b[3m');
export const underline = c('\x1b[4m');

export const red = c('\x1b[31m');
export const green = c('\x1b[32m');
export const yellow = c('\x1b[33m');
export const blue = c('\x1b[34m');
export const magenta = c('\x1b[35m');
export const cyan = c('\x1b[36m');
export const gray = c('\x1b[90m');

/** Colorize a string (no-op when colors disabled). */
export function paint(text: string, ...colors: string[]): string {
  if (noColor) return text;
  return colors.join('') + text + reset;
}

/** Green text. */
export function g(text: string): string {
  return paint(text, green);
}
/** Yellow text. */
export function y(text: string): string {
  return paint(text, yellow);
}
/** Red text. */
export function r(text: string): string {
  return paint(text, red);
}
/** Cyan text. */
export function cy(text: string): string {
  return paint(text, cyan);
}
/** Gray/dim text. */
export function gr(text: string): string {
  return paint(text, gray);
}
/** Bold text. */
export function b(text: string): string {
  return paint(text, bold);
}
