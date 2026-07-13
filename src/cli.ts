/**
 * codex-reset — CLI entry point.
 * Parses arguments and dispatches to commands.
 * @module cli
 */

import { listCommand } from './commands/list.js';
import { creditsCommand } from './commands/credits.js';
import { resetCommand } from './commands/reset.js';
import { CliError } from './utils/errors.js';
import { b, dim, cy, g, y, reset } from './utils/colors.js';

const VERSION = '0.2.1';

const HELP = `${b('codex-reset')} ${dim}v${VERSION}${reset}
${cy('Inspect and redeem Codex rate-limit reset credits from the command line')}

${b('Usage:')}
  ${dim}codex-reset${reset} <command> [options]
  ${dim}codex-reset${reset} <query>        ${dim}# shortcut: reset <query>${reset}

${b('Commands:')}
  ${g('list')}      ${dim}Show all accounts with usage bars and credit count${reset}
  ${g('credits')}   ${dim}Show detailed credit breakdown with expiry dates${reset}
  ${g('reset')}     ${dim}Consume a reset credit to clear rate-limit windows${reset}

${b('Reset options:')}
  ${dim}codex-reset reset${reset}                 ${dim}# interactive picker${reset}
  ${dim}codex-reset reset <query>${reset}         ${dim}# by email, alias, or index${reset}
  ${dim}codex-reset reset --all${reset}           ${dim}# reset all eligible accounts${reset}
  ${dim}codex-reset reset --yes${reset}           ${dim}# skip confirmation${reset}

${b('Global options:')}
  ${dim}--json${reset}     Machine-readable JSON output
  ${dim}--help, -h${reset} Show this help
  ${dim}--version, -V${reset} Show version
  ${dim}--no-color${reset} Disable colored output

${b('Examples:')}
  ${dim}codex-reset${reset}                  ${dim}# list (default)${reset}
  ${dim}codex-reset list${reset}             ${dim}# list all accounts${reset}
  ${dim}codex-reset credits${reset}          ${dim}# show credit details${reset}
  ${dim}codex-reset reset${reset}            ${dim}# interactive reset picker${reset}
  ${dim}codex-reset reset 2${reset}          ${dim}# reset account #2${reset}
  ${dim}codex-reset reset --all --yes${reset} ${dim}# reset all, no prompt${reset}
  ${dim}codex-reset list --json${reset}      ${dim}# JSON output for scripting${reset}

${b('Exit codes:')}
  ${dim}0${reset}  Success
  ${dim}1${reset}  General error
  ${dim}2${reset}  Auth error (no accounts / token expired)
  ${dim}3${reset}  API/network error
`;

interface ParsedArgs {
  command: string;
  query?: string;
  json: boolean;
  yes: boolean;
  all: boolean;
}

/** Parse command-line arguments. */
function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // skip node + script path
  const parsed: ParsedArgs = {
    command: '',
    json: false,
    yes: false,
    all: false,
  };

  const knownCommands = new Set([
    'list',
    'credits',
    'reset',
    'help',
    '--help',
    '-h',
    '--version',
    '-V',
  ]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      parsed.command = 'help';
    } else if (arg === '--version' || arg === '-V') {
      parsed.command = 'version';
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--yes' || arg === '-y') {
      parsed.yes = true;
    } else if (arg === '--all' || arg === '-a') {
      parsed.all = true;
    } else if (arg === '--no-color') {
      // Colors checks process.argv during module initialization, so this flag
      // is handled before command dispatch rather than as a later environment mutation.
    } else if (arg && !parsed.command && (arg === 'list' || arg === 'credits' || arg === 'reset')) {
      parsed.command = arg;
    } else if (arg && !parsed.command && !arg.startsWith('-') && !knownCommands.has(arg)) {
      // Shortcut: `codex-reset <query>` → `codex-reset reset <query>`
      parsed.command = 'reset';
      parsed.query = arg;
    } else if (arg && parsed.command === 'reset' && !arg.startsWith('-') && !parsed.query) {
      parsed.query = arg;
    }
  }

  // Default to list
  if (!parsed.command) {
    parsed.command = 'list';
  }

  return parsed;
}

/** Main entry point. */
async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  switch (parsed.command) {
    case 'help':
      process.stdout.write(HELP + '\n');
      process.exit(0);
      break;
    case 'version':
      process.stdout.write(VERSION + '\n');
      process.exit(0);
      break;
    case 'list':
      await listCommand({ json: parsed.json });
      break;
    case 'credits':
      await creditsCommand({ json: parsed.json });
      break;
    case 'reset':
      await resetCommand({
        json: parsed.json,
        yes: parsed.yes,
        all: parsed.all,
        query: parsed.query,
      });
      break;
    default:
      process.stdout.write(HELP + '\n');
      process.exit(0);
  }
}

main().catch((err: unknown) => {
  if (err instanceof CliError) {
    process.stderr.write(`${y('Error:')} ${err.message}\n`);
    if (err.hint) {
      process.stderr.write(`${dim}${err.hint}${reset}\n`);
    }
    process.exit(err.exitCode);
  }

  // Unexpected error
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${y('Error:')} ${msg}\n`);
  process.exit(1);
});
