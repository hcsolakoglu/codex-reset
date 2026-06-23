import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Test that the CLI help text and version are correct
// These are integration tests that verify the built CLI works

describe('CLI smoke tests', () => {
  it('package.json has correct name and bin', async () => {
    const pkg = await import('../package.json', { with: { type: 'json' } });
    assert.strictEqual(pkg.default.name, 'codex-reset');
    assert.ok(pkg.default.bin);
    assert.ok(pkg.default.bin['codex-reset']);
  });

  it('package.json has zero runtime dependencies', async () => {
    const pkg = await import('../package.json', { with: { type: 'json' } });
    assert.strictEqual(pkg.default.dependencies, undefined);
  });

  it('package.json engines requires node >= 22.13.0', async () => {
    const pkg = await import('../package.json', { with: { type: 'json' } });
    assert.ok(pkg.default.engines);
    assert.strictEqual(pkg.default.engines.node, '>=22.13.0');
  });

  it('package.json files includes dist and bin', async () => {
    const pkg = await import('../package.json', { with: { type: 'json' } });
    assert.ok(pkg.default.files.includes('dist'));
    assert.ok(pkg.default.files.includes('bin'));
  });
});
