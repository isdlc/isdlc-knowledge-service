import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCredential,
  isCredentialReference,
  MissingCredentialError,
  BareCredentialError,
} from '../../../src/credentials/resolver.js';

describe('resolveCredential', () => {
  it('returns undefined for undefined input', () => {
    assert.equal(resolveCredential(undefined), undefined);
  });

  it('returns undefined for null input', () => {
    assert.equal(resolveCredential(null), undefined);
  });

  it('throws BareCredentialError for a bare string', () => {
    assert.throws(
      () => resolveCredential('sk-abc123'),
      (err) => err instanceof BareCredentialError && err.code === 'ERR-API-004'
    );
  });

  it('resolves { env: "NAME" } from injected env', () => {
    const out = resolveCredential({ env: 'TEST_KEY' }, { env: { TEST_KEY: 'value-from-env' } });
    assert.equal(out, 'value-from-env');
  });

  it('throws ERR-CRED-001 when env var is unset', () => {
    assert.throws(
      () => resolveCredential({ env: 'UNSET_VAR' }, { env: {} }),
      (err) => err instanceof MissingCredentialError && err.code === 'ERR-CRED-001'
    );
  });

  it('throws ERR-CRED-001 when env var is empty string', () => {
    assert.throws(
      () => resolveCredential({ env: 'EMPTY_VAR' }, { env: { EMPTY_VAR: '' } }),
      (err) => err instanceof MissingCredentialError && err.code === 'ERR-CRED-001'
    );
  });

  it('throws ERR-CRED-002 for { secret_ref } (v1 not supported)', () => {
    assert.throws(
      () => resolveCredential({ secret_ref: 'vault://foo' }),
      (err) => err instanceof MissingCredentialError && err.code === 'ERR-CRED-002'
    );
  });

  it('throws BareCredentialError for an object without env or secret_ref', () => {
    assert.throws(
      () => resolveCredential({ wrong: 'shape' }),
      (err) => err instanceof BareCredentialError && err.code === 'ERR-API-004'
    );
  });

  it('throws BareCredentialError for non-object non-string non-nullish', () => {
    assert.throws(
      () => resolveCredential(42),
      (err) => err instanceof BareCredentialError
    );
  });
});

describe('isCredentialReference', () => {
  it('accepts { env: "X" }', () => {
    assert.equal(isCredentialReference({ env: 'X' }), true);
  });
  it('accepts { secret_ref: "ref" }', () => {
    assert.equal(isCredentialReference({ secret_ref: 'ref' }), true);
  });
  it('rejects bare strings', () => {
    assert.equal(isCredentialReference('sk-abc'), false);
  });
  it('rejects null/undefined', () => {
    assert.equal(isCredentialReference(null), false);
    assert.equal(isCredentialReference(undefined), false);
  });
  it('rejects objects without env or secret_ref', () => {
    assert.equal(isCredentialReference({ wrong: 'shape' }), false);
  });
  it('rejects { env: "" } (empty string)', () => {
    assert.equal(isCredentialReference({ env: '' }), false);
  });
});
