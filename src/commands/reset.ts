/**
 * `codex-reset reset [query]` — consume a rate-limit reset credit.
 * Redeems an available Codex rate-limit reset credit after user confirmation.
 * @module commands/reset
 */

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { discoverAccounts, findAccount } from '../core/accounts.js';
import { getUsage, consumeCredit, generateRequestId } from '../core/api.js';
import type { Account, AccountUsage } from '../core/types.js';
import { formatLimitBar, formatLimitLine, planBadge, truncate } from '../utils/format.js';
import { gr, g, y, r, dim, bold, reset } from '../utils/colors.js';
import { CliError } from '../utils/errors.js';

interface ResetOptions {
  json: boolean;
  yes: boolean;
  all: boolean;
  query?: string;
}

/** Fetch usage for a single account. */
async function fetchUsage(account: Account): Promise<AccountUsage> {
  const usage = await getUsage(account);
  return {
    account,
    primaryPercent: usage.rate_limit.primary_window.used_percent,
    secondaryPercent: usage.rate_limit.secondary_window.used_percent,
    primaryResetAt: usage.rate_limit.primary_window.reset_at ?? null,
    secondaryResetAt: usage.rate_limit.secondary_window.reset_at ?? null,
    availableCredits: usage.rate_limit_reset_credits?.available_count ?? 0,
    rateLimitReachedType: usage.rate_limit_reached_type?.type ?? null,
    fetchedAt: Date.now(),
  };
}

/** Check if an account would benefit from a reset (has credits + exhausted windows). */
function needsReset(u: AccountUsage): boolean {
  if (u.availableCredits === 0) return false;
  return u.primaryPercent >= 80 || u.secondaryPercent >= 80;
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

/** Prompt the user to pick from a numbered list. Returns 0-based index or -1. */
async function pickFromList(prompt: string, count: number): Promise<number> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(prompt);
    const n = parseInt(answer.trim(), 10);
    if (isNaN(n) || n < 1 || n > count) return -1;
    return n - 1;
  } finally {
    rl.close();
  }
}

/** Execute a single reset and show before/after. */
async function executeReset(
  usage: AccountUsage,
  options: ResetOptions,
): Promise<{ outcome: string; windowsReset: number }> {
  const redeemRequestId = generateRequestId();

  if (!options.json && !options.yes) {
    const label = usage.account.alias || usage.account.email;
    const confirmed = await confirm(
      `\n  ${bold}Reset ${label}?${reset} ${dim}(uses 1 credit, resets 5h + 7d windows)${reset} [y/N] `,
    );
    if (!confirmed) {
      process.stdout.write(`${gr('Cancelled.')}\n`);
      return { outcome: 'cancelled', windowsReset: 0 };
    }
  }

  // Consume
  const result = await consumeCredit(usage.account, redeemRequestId);

  if (result.code === 'noCredit') {
    throw new CliError('No reset credits available for this account', 1);
  }
  if (result.code === 'nothingToReset') {
    if (options.json) {
      process.stdout.write(JSON.stringify({ outcome: 'nothingToReset', windowsReset: 0 }) + '\n');
    } else {
      process.stdout.write(`${y('Usage does not need a reset right now.')}\n`);
    }
    return { outcome: 'nothingToReset', windowsReset: 0 };
  }
  if (result.code === 'alreadyRedeemed') {
    if (options.json) {
      process.stdout.write(JSON.stringify({ outcome: 'alreadyRedeemed', windowsReset: 0 }) + '\n');
    } else {
      process.stdout.write(`${y('This reset was already redeemed.')}\n`);
    }
    return { outcome: 'alreadyRedeemed', windowsReset: 0 };
  }

  // Fetch after state
  let afterUsage: AccountUsage | null = null;
  try {
    afterUsage = await fetchUsage(usage.account);
  } catch {
    // Non-fatal — the reset still succeeded
  }

  if (options.json) {
    process.stdout.write(
      JSON.stringify({
        outcome: 'reset',
        windowsReset: result.windows_reset,
        account: usage.account.email,
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
      }) + '\n',
    );
  } else {
    const label = usage.account.alias || usage.account.email;
    process.stdout.write(`\n  ${g('✓')} ${bold}Reset successful${reset} for ${label}\n`);
    process.stdout.write(`  ${dim}Windows reset: ${result.windows_reset}${reset}\n\n`);

    // Before/after comparison
    if (afterUsage) {
      process.stdout.write(
        `  ${dim}5h limit:${reset}      ${formatLimitBar(usage.primaryPercent)} → ${formatLimitBar(afterUsage.primaryPercent)}\n`,
      );
      process.stdout.write(
        `  ${dim}Weekly limit:${reset}  ${formatLimitBar(usage.secondaryPercent)} → ${formatLimitBar(afterUsage.secondaryPercent)}\n`,
      );
      process.stdout.write(
        `  ${dim}Credits:${reset}  ${usage.availableCredits} → ${g(`${afterUsage.availableCredits}`)} ${dim}left${reset}\n`,
      );
    }
    process.stdout.write('\n');
  }

  return { outcome: 'reset', windowsReset: result.windows_reset };
}

/** Reset command entry point. */
export async function resetCommand(options: ResetOptions): Promise<void> {
  const accounts = await discoverAccounts();
  if (accounts.length === 0) {
    throw new CliError(
      'No Codex accounts found',
      2,
      'Run `codex-auth login` to add accounts first.',
    );
  }

  // Fetch usage for all accounts in parallel
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

  // --all: reset all eligible accounts
  if (options.all) {
    const eligible = usages.filter(needsReset);
    if (eligible.length === 0) {
      if (options.json) {
        process.stdout.write(JSON.stringify({ outcome: 'noEligibleAccounts' }) + '\n');
      } else {
        process.stdout.write(`${gr('No accounts need a reset right now.')}\n`);
      }
      return;
    }

    if (!options.json) {
      process.stdout.write(`\n  ${bold}Resetting ${eligible.length} account(s):${reset}\n`);
    }

    const results: { email: string; outcome: string; windowsReset: number }[] = [];
    for (const usage of eligible) {
      try {
        const result = await executeReset(usage, { ...options, yes: options.yes });
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
      process.stdout.write(JSON.stringify({ results }) + '\n');
    } else {
      const succeeded = results.filter((r) => r.outcome === 'reset').length;
      process.stdout.write(
        `\n  ${g(`${succeeded}`)} reset, ${eligible.length - succeeded} skipped/error\n`,
      );
    }
    return;
  }

  // Direct query: find specific account
  if (options.query) {
    const account = findAccount(
      usages.map((u) => u.account),
      options.query,
    );
    if (!account) {
      throw new CliError(
        `No account matching "${options.query}"`,
        1,
        'Use `codex-reset list` to see available accounts.',
      );
    }
    const usage = usages.find((u) => u.account.accountId === account.accountId);
    if (!usage) {
      throw new CliError(`Could not fetch usage for "${options.query}"`, 3);
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

    await executeReset(usage, options);
    return;
  }

  // Interactive: show picker
  const eligible = usages.filter(needsReset);
  const hasCredits = usages.filter((u) => u.availableCredits > 0);

  if (hasCredits.length === 0) {
    process.stdout.write(`${gr('No reset credits available on any account.')}\n`);
    return;
  }

  // Show all accounts with credits
  process.stdout.write(`\n  ${bold}Select an account to reset:${reset}\n\n`);
  for (let i = 0; i < hasCredits.length; i++) {
    const u = hasCredits[i]!;
    const num = `${dim}${(i + 1).toString().padStart(2)}${reset}`;
    const rawLabel = u.account.alias || u.account.accountName || u.account.email;
    const label = truncate(rawLabel, 28);
    const email = truncate(u.account.email, 36);
    const emailSuffix = rawLabel === u.account.email ? '' : `  ${dim}<${email}>${reset}`;
    const plan = planBadge(u.account.planType);
    const credits = g(`${u.availableCredits}`);
    const needs = needsReset(u) ? y(' ← needs reset') : '';
    process.stdout.write(
      `  ${num}  ${bold}${label}${reset}${emailSuffix}  ${plan}  ${credits}c${needs}\n`,
    );
    process.stdout.write(
      `      ${formatLimitLine('5h limit', u.primaryPercent, u.primaryResetAt)}\n`,
    );
    process.stdout.write(
      `      ${formatLimitLine('Weekly limit', u.secondaryPercent, u.secondaryResetAt)}\n`,
    );
  }

  if (eligible.length > 1) {
    process.stdout.write(`\n  ${dim}Enter number or 'all' to reset all eligible:${reset} `);
  } else {
    process.stdout.write(`\n  ${dim}Enter number:${reset} `);
  }

  const idx = await pickFromList('', hasCredits.length);
  if (idx === -1) {
    process.stdout.write(`${gr('Cancelled.')}\n`);
    return;
  }

  await executeReset(hasCredits[idx]!, options);
}
