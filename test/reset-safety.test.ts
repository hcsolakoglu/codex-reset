import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resetCommand } from '../src/commands/reset.ts';
import { CliError } from '../src/utils/errors.ts';

describe('reset safety', () => {
  it('refuses JSON mode unless --yes is explicit, before account discovery or network calls', async () => {
    await assert.rejects(resetCommand({ json: true, yes: false, all: false }), (error: unknown) => {
      if (!(error instanceof CliError)) return false;
      assert.equal(error.message, 'Refusing to redeem a reset without explicit confirmation');
      assert.equal(error.exitCode, 2);
      return true;
    });
  });
});
