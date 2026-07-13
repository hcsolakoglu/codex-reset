/**
 * `codex-reset list` — overview of all accounts with usage and credits.
 * @module commands/list
 */

import { discoverAccounts } from '../core/accounts.js';
import type { Account } from '../core/types.js';
import { getUsage, normalizeUsage } from '../core/api.js';
import type { AccountUsage } from '../core/types.js';
import {
  formatLimitLine,
  percentLeft,
  planBadge,
  rateLimitWindowLabel,
  truncate,
} from '../utils/format.js';
import { gr, g, y, r, cy, dim, bold, reset } from '../utils/colors.js';
import { CliError } from '../utils/errors.js';

/** Fetch usage for all accounts in parallel. */
async function fetchAllUsage(accounts: Account[]): Promise<AccountUsage[]> {
  const results = await Promise.allSettled(
    accounts.map(async (account) => {
      const usage = await getUsage(account);
      return normalizeUsage(account, usage);
    }),
  );

  const usages: AccountUsage[] = [];
  const errors: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === 'fulfilled') {
      usages.push(result.value);
    } else {
      const acct = accounts[i]!;
      errors.push(
        `${acct.email}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
    }
  }

  if (usages.length === 0 && errors.length > 0) {
    throw new CliError('Failed to fetch usage for all accounts', 3, errors.join('\n'));
  }

  for (const err of errors) {
    process.stderr.write(`${y('!')} ${err}\n`);
  }

  return usages;
}

function statusForUsage(u: AccountUsage): string {
  const statusParts: string[] = [];
  if (u.secondaryPercent !== null && u.secondaryPercent >= 100)
    statusParts.push(
      r(
        `${rateLimitWindowLabel('secondary', u.secondaryWindowSeconds).replace(/ limit$/, '')} exhausted`,
      ),
    );
  else if (u.primaryPercent !== null && u.primaryPercent >= 100)
    statusParts.push(
      r(
        `${rateLimitWindowLabel('primary', u.primaryWindowSeconds).replace(/ limit$/, '')} exhausted`,
      ),
    );
  if (
    u.availableCredits > 0 &&
    [u.secondaryPercent, u.primaryPercent].some((percent) => percent !== null && percent >= 80)
  ) {
    statusParts.push(y('reset available'));
  }
  if (u.primaryPercent === null && u.secondaryPercent === null)
    statusParts.push(y('usage unavailable'));
  return statusParts.length > 0 ? statusParts.join(' ') : gr('ok');
}

function lowestPercentLeft(values: Array<number | null>): number | 'n/a' {
  const available = values.filter((value): value is number => value !== null);
  return available.length === 0 ? 'n/a' : Math.min(...available.map(percentLeft));
}

/** Render the list output (human-readable). */
function renderList(usages: AccountUsage[]): string {
  const lines: string[] = [];

  for (let i = 0; i < usages.length; i++) {
    const u = usages[i]!;
    const num = `${dim}${(i + 1).toString().padStart(2)}${reset}`;
    const label = u.account.alias || u.account.accountName || u.account.email;
    const email = truncate(u.account.email, 36);
    const emailSuffix = label === u.account.email ? '' : `  ${dim}<${email}>${reset}`;
    const plan = planBadge(u.account.planType);
    const credits =
      u.availableCredits > 0
        ? g(`${u.availableCredits} reset credit${u.availableCredits === 1 ? '' : 's'}`)
        : gr('0 reset credits');

    lines.push(
      `${num}  ${bold}${truncate(label, 28)}${reset}${emailSuffix}  ${plan}  ${credits}  ${statusForUsage(u)}`,
    );
    lines.push(
      `    ${formatLimitLine(
        rateLimitWindowLabel('primary', u.primaryWindowSeconds),
        u.primaryPercent,
        u.primaryResetAt,
      )}`,
    );
    lines.push(
      `    ${formatLimitLine(
        rateLimitWindowLabel('secondary', u.secondaryWindowSeconds),
        u.secondaryPercent,
        u.secondaryResetAt,
      )}`,
    );
    if (i !== usages.length - 1) lines.push('');
  }

  const totalCredits = usages.reduce((sum, u) => sum + u.availableCredits, 0);
  const exhausted = usages.filter(
    (u) =>
      (u.primaryPercent !== null && u.primaryPercent >= 100) ||
      (u.secondaryPercent !== null && u.secondaryPercent >= 100),
  ).length;
  const lowest5h = lowestPercentLeft(usages.map((u) => u.primaryPercent));
  const lowestWeekly = lowestPercentLeft(usages.map((u) => u.secondaryPercent));
  const primaryWindow = usages.find((u) => u.primaryPercent !== null);
  const secondaryWindow = usages.find((u) => u.secondaryPercent !== null);
  const primarySummaryLabel = rateLimitWindowLabel(
    'primary',
    primaryWindow?.primaryWindowSeconds ?? null,
  ).replace(/ limit$/, '');
  const secondarySummaryLabel = rateLimitWindowLabel(
    'secondary',
    secondaryWindow?.secondaryWindowSeconds ?? null,
  ).replace(/ limit$/, '');

  lines.push('');
  lines.push(
    `${dim}Accounts: ${usages.length}  •  Credits available: ${totalCredits}  •  Exhausted: ${exhausted}  •  Lowest left: ${primarySummaryLabel} ${lowest5h}%, ${secondarySummaryLabel} ${lowestWeekly}%${reset}`,
  );

  if (totalCredits > 0 && exhausted > 0) {
    lines.push(`${cy('Run `codex-reset reset` to use available credits.')}`);
  }

  return lines.join('\n');
}

/** List command entry point. */
export async function listCommand(options: { json: boolean }): Promise<void> {
  const accounts = await discoverAccounts();
  if (accounts.length === 0) {
    throw new CliError(
      'No Codex accounts found',
      2,
      'Run `codex-auth login` to add accounts first.',
    );
  }

  const usages = await fetchAllUsage(accounts);

  if (options.json) {
    const output = usages.map((u) => ({
      email: u.account.email,
      planType: u.account.planType,
      accountId: u.account.accountId,
      alias: u.account.alias,
      usage: {
        primary: {
          percentUsed: u.primaryPercent,
          percentLeft: u.primaryPercent === null ? null : percentLeft(u.primaryPercent),
          windowSeconds: u.primaryWindowSeconds,
          resetsAt: u.primaryResetAt,
        },
        secondary: {
          percentUsed: u.secondaryPercent,
          percentLeft: u.secondaryPercent === null ? null : percentLeft(u.secondaryPercent),
          windowSeconds: u.secondaryWindowSeconds,
          resetsAt: u.secondaryResetAt,
        },
      },
      credits: { available: u.availableCredits },
      rateLimitReachedType: u.rateLimitReachedType,
    }));
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } else {
    process.stdout.write('\n' + renderList(usages) + '\n');
  }
}
