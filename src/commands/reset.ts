/**
 * `codex-reset reset [query]` — consume a rate-limit reset credit.
 * Redeems an available Codex rate-limit reset credit after user confirmation.
 * @module commands/reset
 */

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { discoverAccounts, findAccount } from '../core/accounts.js';
import {
  getCredits,
  getUsage,
  consumeCredit,
  generateRequestId,
  normalizeUsage,
} from '../core/api.js';
import type { Account, AccountUsage, ResetCredit } from '../core/types.js';
import {
  formatLimitBar,
  formatLimitLine,
  planBadge,
  rateLimitWindowLabel,
  truncate,
} from '../utils/format.js';
import { gr, g, y, r, dim, bold, reset } from '../utils/colors.js';
import { ApiError, CliError } from '../utils/errors.js';

interface ResetOptions {
  json: boolean;
  yes: boolean;
  all: boolean;
  query?: string;
}

export interface ResetResult {
  outcome: string;
  windowsReset: number;
  account?: string;
  creditId?: string | null;
  before?: {
    primary: number | null;
    secondary: number | null;
    credits: number;
  };
  after?: {
    primary: number | null;
    secondary: number | null;
    credits: number;
  } | null;
}

interface ResetBatchResult {
  email: string;
  outcome: string;
  windowsReset: number;
}

export function serializeResetResults(results: ResetBatchResult[]): string {
  return JSON.stringify({ results }) + '\n';
}

/** Fetch usage for a single account using the null-safe API normalizer. */
async function fetchUsage(account: Account): Promise<AccountUsage> {
  return normalizeUsage(account, await getUsage(account));
}

/** Check if an account would benefit from a reset (has credits + high usage). */
function needsReset(u: AccountUsage): boolean {
  return (
    u.availableCredits > 0 &&
    [u.primaryPercent, u.secondaryPercent].some((percent) => percent !== null && percent >= 80)
  );
}

export function hasUsableUsage(u: AccountUsage): boolean {
  return u.primaryPercent !== null || u.secondaryPercent !== null;
}

export function canUseCountOnlyCreditFallback(error: unknown, availableCredits: number): boolean {
  return (
    error instanceof ApiError &&
    (error.statusCode === 404 || error.statusCode === 405) &&
    availableCredits > 0
  );
}

function activeWindowDescription(u: AccountUsage, credit?: ResetCredit): string {
  const creditScope = credit?.title?.trim() || credit?.reset_type?.trim();
  if (creditScope) return creditScope;

  const labels = [
    u.primaryPercent === null
      ? null
      : rateLimitWindowLabel('primary', u.primaryWindowSeconds).replace(/ limit$/, ''),
    u.secondaryPercent === null
      ? null
      : rateLimitWindowLabel('secondary', u.secondaryWindowSeconds).replace(/ limit$/, ''),
  ].filter((label): label is string => label !== null);
  return labels.length > 0 ? labels.join(' + ') : 'current usage windows';
}

function sortAvailableCredits(credits: ResetCredit[]): ResetCredit[] {
  return credits
    .filter((credit) => credit.status.toLowerCase() === 'available')
    .sort((a, b) => {
      if (a.expires_at === null) return b.expires_at === null ? 0 : 1;
      if (b.expires_at === null) return -1;
      return new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime();
    });
}

function creditLabel(credit: ResetCredit, index: number): string {
  const title = credit.title?.trim() || credit.reset_type;
  const expiry = credit.expires_at === null ? 'no expiry' : `expires ${credit.expires_at}`;
  return `${index + 1}. ${title} (${expiry})`;
}

/** Load details and choose the soonest-expiring credit, with an interactive picker if needed. */
async function chooseCredit(
  usage: AccountUsage,
  options: ResetOptions,
): Promise<ResetCredit | undefined> {
  let response;
  try {
    response = await getCredits(usage.account);
  } catch (error) {
    // Older backends may not expose credit details. Preserve the count-only
    // consume path for explicit unsupported-endpoint responses, but fail
    // closed on auth, network, and malformed-response failures.
    if (canUseCountOnlyCreditFallback(error, usage.availableCredits)) {
      return undefined;
    }
    throw error;
  }
  const available = sortAvailableCredits(response.credits);

  // Keep compatibility with older backends that expose only available_count.
  if (available.length === 0) {
    if (usage.availableCredits > 0) return undefined;
    return undefined;
  }

  if (available.length === 1 || options.yes) return available[0];

  process.stdout.write(`\n  ${bold}Select a reset credit:${reset}\n`);
  available.forEach((credit, index) => {
    process.stdout.write(`  ${creditLabel(credit, index)}\n`);
    if (credit.description) process.stdout.write(`     ${dim}${credit.description}${reset}\n`);
  });
  const selected = await pickFromList(`\n  ${dim}Enter number:${reset} `, available.length);
  return selected === -1 || selected === 'all' ? undefined : available[selected];
}

/** Prompt the user for yes/no confirmation. */
async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(prompt);
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

/** Prompt the user to pick from a numbered list. */
async function pickFromList(
  prompt: string,
  count: number,
  allowAll = false,
): Promise<number | 'all' | -1> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    if (allowAll && answer === 'all') return 'all';
    if (!/^[1-9]\d*$/.test(answer)) return -1;
    const n = Number(answer);
    if (!Number.isSafeInteger(n) || n < 1 || n > count) return -1;
    return n - 1;
  } finally {
    rl.close();
  }
}

function displayWindow(percent: number | null): string {
  return percent === null ? `${dim}unavailable${reset}` : formatLimitBar(percent);
}

/** Execute a single reset and show before/after. */
async function executeReset(usage: AccountUsage, options: ResetOptions): Promise<ResetResult> {
  if (!hasUsableUsage(usage)) {
    throw new CliError(
      `Cannot reset ${usage.account.email}: usage windows are unavailable`,
      2,
      'Retry after the usage endpoint returns at least one valid window.',
    );
  }

  const credit = await chooseCredit(usage, options);
  if (usage.availableCredits > 0 && credit === undefined && options.yes) {
    // A legacy response can report a count without individual credit details.
  } else if (usage.availableCredits > 0 && credit === undefined) {
    process.stdout.write(`${gr('Cancelled.')}\n`);
    return { outcome: 'cancelled', windowsReset: 0 };
  }

  const redeemRequestId = generateRequestId();
  const label = usage.account.alias || usage.account.email;
  const scope = activeWindowDescription(usage, credit);

  if (!options.yes) {
    const confirmed = await confirm(
      `\n  ${bold}Reset ${label}?${reset} ${dim}(uses 1 credit, resets ${scope})${reset} [y/N] `,
    );
    if (!confirmed) {
      process.stdout.write(`${gr('Cancelled.')}\n`);
      return { outcome: 'cancelled', windowsReset: 0 };
    }
  }

  const result = await consumeCredit(usage.account, redeemRequestId, credit?.id);
  const windowsReset = result.windows_reset ?? 0;

  if (result.code === 'noCredit') {
    throw new CliError('No reset credits available for this account', 1);
  }
  if (result.code === 'nothingToReset') {
    if (!options.json) {
      process.stdout.write(`${y('Usage does not need a reset right now.')}\n`);
    }
    return { outcome: 'nothingToReset', windowsReset: 0 };
  }
  if (result.code === 'alreadyRedeemed') {
    if (!options.json) {
      process.stdout.write(`${y('This reset was already redeemed.')}\n`);
    }
    return { outcome: 'alreadyRedeemed', windowsReset: 0 };
  }

  let afterUsage: AccountUsage | null = null;
  try {
    afterUsage = await fetchUsage(usage.account);
  } catch {
    // The reset succeeded even if the follow-up status request is unavailable.
  }

  if (!options.json) {
    process.stdout.write(`\n  ${g('✓')} ${bold}Reset successful${reset} for ${label}\n`);
    process.stdout.write(`  ${dim}Windows reset: ${windowsReset}${reset}\n\n`);

    if (afterUsage) {
      process.stdout.write(
        `  ${dim}${rateLimitWindowLabel('primary', usage.primaryWindowSeconds)}:${reset} ${displayWindow(usage.primaryPercent)} → ${displayWindow(afterUsage.primaryPercent)}\n`,
      );
      process.stdout.write(
        `  ${dim}${rateLimitWindowLabel('secondary', usage.secondaryWindowSeconds)}:${reset} ${displayWindow(usage.secondaryPercent)} → ${displayWindow(afterUsage.secondaryPercent)}\n`,
      );
      process.stdout.write(
        `  ${dim}Credits:${reset}  ${usage.availableCredits} → ${g(`${afterUsage.availableCredits}`)} ${dim}left${reset}\n`,
      );
    }
    process.stdout.write('\n');
  }

  return {
    outcome: 'reset',
    windowsReset,
    account: usage.account.email,
    creditId: credit?.id ?? null,
    before: {
      primary: usage.primaryPercent,
      secondary: usage.secondaryPercent,
      credits: usage.availableCredits,
    },
    after: afterUsage
      ? {
          primary: afterUsage.primaryPercent,
          secondary: afterUsage.secondaryPercent,
          credits: afterUsage.availableCredits,
        }
      : null,
  };
}

/** Reset command entry point. */
export async function resetCommand(options: ResetOptions): Promise<void> {
  // JSON is non-interactive, so never let it silently perform a destructive POST.
  if (options.json && !options.yes) {
    throw new CliError(
      'Refusing to redeem a reset without explicit confirmation',
      2,
      'Use `--json --yes` when running a confirmed non-interactive reset.',
    );
  }

  const accounts = await discoverAccounts();
  if (accounts.length === 0) {
    throw new CliError(
      'No Codex accounts found',
      2,
      'Run `codex-auth login` to add accounts first.',
    );
  }

  const usageResults = await Promise.allSettled(accounts.map(fetchUsage));
  const usages: AccountUsage[] = [];
  for (let i = 0; i < usageResults.length; i++) {
    const result = usageResults[i]!;
    if (result.status === 'fulfilled') {
      usages.push(result.value);
    } else if (!options.json) {
      const acct = accounts[i]!;
      process.stderr.write(
        `${y('!')} ${acct.email}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}\n`,
      );
    }
  }

  if (usages.length === 0) {
    throw new CliError('Failed to fetch usage for all accounts', 3);
  }

  const resetMany = async (eligible: AccountUsage[]): Promise<void> => {
    if (!options.json) {
      process.stdout.write(`\n  ${bold}Resetting ${eligible.length} account(s):${reset}\n`);
    }

    const results: ResetBatchResult[] = [];
    for (const usage of eligible) {
      try {
        const result = await executeReset(usage, options);
        results.push({ email: usage.account.email, ...result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (options.json) {
          results.push({ email: usage.account.email, outcome: 'error', windowsReset: 0 });
        } else {
          process.stderr.write(`${r('✗')} ${usage.account.email}: ${msg}\n`);
        }
      }
    }

    if (options.json) {
      process.stdout.write(serializeResetResults(results));
    } else {
      const succeeded = results.filter((result) => result.outcome === 'reset').length;
      process.stdout.write(
        `\n  ${g(`${succeeded}`)} reset, ${eligible.length - succeeded} skipped/error\n`,
      );
    }
  };

  if (options.all) {
    const eligible = usages.filter(needsReset);
    if (eligible.length === 0) {
      if (options.json)
        process.stdout.write(JSON.stringify({ outcome: 'noEligibleAccounts' }) + '\n');
      else process.stdout.write(`${gr('No accounts need a reset right now.')}\n`);
      return;
    }
    await resetMany(eligible);
    return;
  }

  if (options.query) {
    const normalizedQuery = options.query.toLowerCase();
    const accountIdMatches = usages.filter((usage) =>
      usage.account.accountId.toLowerCase().startsWith(normalizedQuery),
    );
    if (!/^[1-9]\d*$/.test(options.query) && accountIdMatches.length > 1) {
      throw new CliError(
        `Account ID query "${options.query}" is ambiguous`,
        1,
        'Use the account email, alias, or numeric index instead.',
      );
    }

    const account = findAccount(
      usages.map((usage) => usage.account),
      options.query,
    );
    if (!account) {
      throw new CliError(
        `No account matching "${options.query}"`,
        1,
        'Use `codex-reset list` to see available accounts.',
      );
    }
    // Match the object, not only accountId: several stored credentials can share a workspace ID.
    const usage = usages.find((candidate) => candidate.account === account);
    if (!usage) throw new CliError(`Could not fetch usage for "${options.query}"`, 3);

    if (!hasUsableUsage(usage)) {
      if (options.json) {
        process.stdout.write(
          JSON.stringify({ outcome: 'usageUnavailable', account: account.email }) + '\n',
        );
      } else {
        process.stdout.write(`${y(`Usage windows unavailable for ${account.email}`)}\n`);
      }
      return;
    }

    if (usage.availableCredits === 0) {
      if (options.json) {
        process.stdout.write(
          JSON.stringify({ outcome: 'noCredit', account: account.email }) + '\n',
        );
      } else {
        process.stdout.write(`${y(`No reset credits available for ${account.email}`)}\n`);
      }
      return;
    }
    const result = await executeReset(usage, options);
    if (options.json) process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  const eligible = usages.filter(needsReset);
  const hasCredits = usages.filter((usage) => usage.availableCredits > 0 && hasUsableUsage(usage));
  if (hasCredits.length === 0) {
    process.stdout.write(`${gr('No reset credits available on any account.')}\n`);
    return;
  }

  process.stdout.write(`\n  ${bold}Select an account to reset:${reset}\n\n`);
  for (let i = 0; i < hasCredits.length; i++) {
    const usage = hasCredits[i]!;
    const num = `${dim}${(i + 1).toString().padStart(2)}${reset}`;
    const rawLabel = usage.account.alias || usage.account.accountName || usage.account.email;
    const label = truncate(rawLabel, 28);
    const email = truncate(usage.account.email, 36);
    const emailSuffix = rawLabel === usage.account.email ? '' : `  ${dim}<${email}>${reset}`;
    const needs = needsReset(usage) ? y(' ← needs reset') : '';
    process.stdout.write(
      `  ${num}  ${bold}${label}${reset}${emailSuffix}  ${planBadge(usage.account.planType)}  ${g(`${usage.availableCredits}`)}c${needs}\n`,
    );
    process.stdout.write(
      `      ${formatLimitLine(
        rateLimitWindowLabel('primary', usage.primaryWindowSeconds),
        usage.primaryPercent,
        usage.primaryResetAt,
      )}\n`,
    );
    process.stdout.write(
      `      ${formatLimitLine(
        rateLimitWindowLabel('secondary', usage.secondaryWindowSeconds),
        usage.secondaryPercent,
        usage.secondaryResetAt,
      )}\n`,
    );
  }

  const selected = await pickFromList(
    eligible.length > 1
      ? `\n  ${dim}Enter number or 'all' to reset all eligible:${reset} `
      : `\n  ${dim}Enter number:${reset} `,
    hasCredits.length,
    eligible.length > 1,
  );
  if (selected === -1) {
    process.stdout.write(`${gr('Cancelled.')}\n`);
    return;
  }
  if (selected === 'all') {
    await resetMany(eligible);
    return;
  }
  const result = await executeReset(hasCredits[selected]!, options);
  if (options.json) process.stdout.write(JSON.stringify(result) + '\n');
}
