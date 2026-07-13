/**
 * `codex-reset credits` — detailed credit breakdown with expiry dates.
 * @module commands/credits
 */

import { discoverAccounts } from '../core/accounts.js';
import { getCredits } from '../core/api.js';
import type { Account, AccountCredits } from '../core/types.js';
import { formatDate, formatCountdown } from '../utils/format.js';
import { b, gr, g, y, cy, dim, reset } from '../utils/colors.js';
import { CliError } from '../utils/errors.js';

/** Fetch credits for all accounts in parallel. */
async function fetchAllCredits(accounts: Account[]): Promise<AccountCredits[]> {
  const results = await Promise.allSettled(
    accounts.map(async (account) => {
      const response = await getCredits(account);
      return { account, credits: response.credits } satisfies AccountCredits;
    }),
  );

  const allCredits: AccountCredits[] = [];
  const errors: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === 'fulfilled') {
      allCredits.push(result.value);
    } else {
      const acct = accounts[i]!;
      errors.push(
        `${acct.email}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
    }
  }

  if (allCredits.length === 0 && errors.length > 0) {
    throw new CliError('Failed to fetch credits for all accounts', 3, errors.join('\n'));
  }

  for (const err of errors) {
    process.stderr.write(`${y('!')} ${err}\n`);
  }

  return allCredits;
}

/** Render the credits table (human-readable). */
function renderCredits(allCredits: AccountCredits[]): string {
  const lines: string[] = [];
  let totalAvailable = 0;

  for (const { account, credits } of allCredits) {
    const available = credits.filter((c) => c.status === 'available');
    totalAvailable += available.length;

    lines.push('');
    lines.push(
      `${b(account.email)} ${dim}(${account.planType})${reset}  ${g(`${available.length} available`)}`,
    );

    if (available.length === 0) {
      lines.push(`  ${gr('No available credits')}`);
      continue;
    }

    // Sort by expiry (soonest first)
    const sorted = [...available].sort((a, b) => {
      const expiresA = a.expires_at;
      const expiresB = b.expires_at;
      if (expiresA === null) return expiresB === null ? 0 : 1;
      if (expiresB === null) return -1;
      return new Date(expiresA).getTime() - new Date(expiresB).getTime();
    });

    for (const credit of sorted) {
      const id = credit.id.replace('RateLimitResetCredit_', '').slice(0, 12);
      const granted = formatDate(credit.granted_at);
      const expires = credit.expires_at === null ? 'no expiry' : formatDate(credit.expires_at);
      const countdown = formatCountdown(credit.expires_at);

      lines.push(
        `  ${dim}#${id}${reset}  ${dim}granted ${granted}${reset}  ${dim}expires ${expires}${reset}  ${countdown}`,
      );
    }
  }

  lines.push('');
  lines.push(`${dim}Total available credits: ${totalAvailable}${reset}`);

  if (totalAvailable > 0) {
    lines.push(`${cy('Run `codex-reset reset` to use a credit.')}`);
  }

  return lines.join('\n');
}

/** Credits command entry point. */
export async function creditsCommand(options: { json: boolean }): Promise<void> {
  const accounts = await discoverAccounts();
  if (accounts.length === 0) {
    throw new CliError(
      'No Codex accounts found',
      2,
      'Run `codex-auth login` to add accounts first.',
    );
  }

  const allCredits = await fetchAllCredits(accounts);

  if (options.json) {
    const output = allCredits.map((ac) => ({
      email: ac.account.email,
      planType: ac.account.planType,
      accountId: ac.account.accountId,
      credits: ac.credits
        .filter((c) => c.status === 'available')
        .sort((a, b) => {
          const expiresA = a.expires_at;
          const expiresB = b.expires_at;
          if (expiresA === null) return expiresB === null ? 0 : 1;
          if (expiresB === null) return -1;
          return new Date(expiresA).getTime() - new Date(expiresB).getTime();
        })
        .map((c) => ({
          id: c.id,
          status: c.status,
          grantedAt: c.granted_at,
          expiresAt: c.expires_at,
          daysLeft:
            c.expires_at === null
              ? null
              : Math.ceil((new Date(c.expires_at).getTime() - Date.now()) / 86_400_000),
        })),
    }));
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } else {
    process.stdout.write(renderCredits(allCredits) + '\n');
  }
}
