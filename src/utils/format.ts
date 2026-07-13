/**
 * Formatting helpers: progress bars, dates, countdowns, tables.
 * Zero dependencies — pure functions.
 * @module utils/format
 */

import { g, y, r, gr, cy, dim, green, yellow, red, gray, reset } from './colors.js';

const DEFAULT_LIMIT_BAR_WIDTH = 20;

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, percent));
}

/** Percent of a rate-limit window still available. Codex backend reports used_percent. */
export function percentLeft(usedPercent: number): number {
  return Math.round(100 - clampPercent(usedPercent));
}

/**
 * Render a Codex CLI-style remaining-capacity bar.
 *
 * Official Codex TUI renders status limits as:
 *   [████████████████████] 99% left (resets 10:12)
 *
 * Input is `used_percent` from the backend, so the bar intentionally displays
 * the inverse: how much capacity remains.
 */
export function formatLimitBar(usedPercent: number, width = DEFAULT_LIMIT_BAR_WIDTH): string {
  const remaining = percentLeft(usedPercent);
  const filled = Math.round((remaining / 100) * width);
  const empty = width - filled;

  const color = remaining <= 10 ? red : remaining <= 30 ? yellow : green;
  const barChar = '\u2588'; // █
  const emptyChar = '\u2591'; // ░
  const bar = `${color}[${barChar.repeat(filled)}${gray}${emptyChar.repeat(empty)}${color}]${reset}`;

  return `${bar} ${remaining}% left`;
}

/** Backwards-compatible alias for older callers/tests. Prefer formatLimitBar. */
export function formatBar(usedPercent: number, width = DEFAULT_LIMIT_BAR_WIDTH): string {
  return formatLimitBar(usedPercent, width);
}

/** Format an ISO date string to a human-readable date. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Format a unix timestamp (seconds) to a short date-time. */
export function formatTimestamp(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Format a reset timestamp the same compact way Codex status rows do. */
export function formatResetTime(unix: number | null, now = new Date()): string | null {
  if (unix === null || !Number.isFinite(unix)) return null;
  const d = new Date(unix * 1000);
  if (Number.isNaN(d.getTime())) return null;

  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const time = `${hh}:${mm}`;

  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  if (sameDay) return time;

  const month = d.toLocaleString('en-US', { month: 'short' });
  return `${time} on ${d.getDate()} ${month}`;
}

/** Render a full Codex CLI-style limit row. */
export function formatLimitLine(
  label: string,
  usedPercent: number | null,
  resetAt: number | null,
  labelWidth = 22,
): string {
  if (usedPercent === null) {
    return `${pad(`${label}:`, labelWidth)} unavailable`;
  }
  const resetTime = formatResetTime(resetAt);
  const suffix = resetTime ? ` (resets ${resetTime})` : '';
  return `${pad(`${label}:`, labelWidth)} ${formatLimitBar(usedPercent)}${suffix}`;
}

/** Map Codex's window duration to the same labels used by its TUI. */
export function rateLimitWindowLabel(
  kind: 'primary' | 'secondary',
  windowSeconds: number | null,
): string {
  if (windowSeconds === 18_000) return '5h limit';
  if (windowSeconds === 604_800) return 'Weekly limit';
  if (windowSeconds === 2_592_000) return 'Monthly limit';
  return kind === 'primary' ? 'Primary limit' : 'Secondary limit';
}

/** Human-readable countdown from now to a target ISO date. */
export function formatCountdown(iso: string | null): string {
  if (iso === null) return `${dim}no expiry${reset}`;
  const target = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = target - now;

  if (diffMs <= 0) return r('expired');

  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);

  if (days > 7) return g(`${days}d left`);
  if (days > 3) return y(`${days}d ${hours}h left`);
  if (days > 0) return r(`${days}d ${hours}h left`);
  return r(`${hours}h left`);
}

/** Format seconds to a compact duration string. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/** Truncate a string to maxLen with ellipsis. */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

/** Pad a string to a fixed width (right-padded with spaces). */
export function pad(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width);
  return str + ' '.repeat(width - str.length);
}

/** Convert backend plan strings to readable labels without hard-coding account classes. */
export function planDisplayName(plan: string): string {
  const normalized = plan.trim().toLowerCase();
  switch (normalized) {
    case 'free':
      return 'Free';
    case 'go':
      return 'Go';
    case 'plus':
      return 'Plus';
    case 'pro':
      return 'Pro';
    case 'prolite':
    case 'pro_lite':
      return 'Pro Lite';
    default:
      return normalized
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join(' ');
  }
}

/** Plan type to colored badge. */
export function planBadge(plan: string): string {
  const normalized = plan.trim().toLowerCase();
  const display = planDisplayName(plan);
  if (normalized === 'plus') return cy(display);
  if (normalized === 'pro' || normalized === 'prolite' || normalized === 'pro_lite')
    return g(display);
  if (normalized === 'free' || normalized === 'go') return gr(display);
  return display;
}
