// Credential resolution layer (REQ-GH-263, BLOCKING-1 remediation)
// Constitution Articles V.5, VII.5, VII.6: credentials MUST live as secret
// references in config; concrete values are resolved at adapter construction.
//
// Canonical reference shapes:
//   { env: "OPENAI_API_KEY" }     — read process.env at resolution time
//   { secret_ref: "vault://..." } — extension point for v1.5+ secret backends

export class MissingCredentialError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MissingCredentialError';
    this.code = code;
  }
}

export class BareCredentialError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BareCredentialError';
    this.code = 'ERR-API-004';
  }
}

/**
 * Test whether a value is a valid credential reference shape.
 * Accepts: { env: "NAME" } or { secret_ref: "ref" }
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCredentialReference(value) {
  if (!value || typeof value !== 'object') return false;
  const hasEnv = typeof value.env === 'string' && value.env.length > 0;
  const hasSecretRef = typeof value.secret_ref === 'string' && value.secret_ref.length > 0;
  return hasEnv || hasSecretRef;
}

/**
 * Resolve a credential reference to a concrete string value.
 *
 * @param {unknown} value
 *   - undefined / null → returns undefined (caller decides if optional)
 *   - { env: "NAME" }  → returns process.env.NAME (throws if unset)
 *   - { secret_ref }   → throws ERR-CRED-002 (not yet supported in v1)
 *   - any string       → throws ERR-API-004 (defensive — caller should have validated)
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {string | undefined}
 */
export function resolveCredential(value, options = {}) {
  if (value === undefined || value === null) return undefined;
  const env = options.env ?? process.env;

  if (typeof value === 'string') {
    throw new BareCredentialError(
      'Credential must be a secret reference (e.g. { env: "NAME" }), not a bare string'
    );
  }

  if (typeof value !== 'object') {
    throw new BareCredentialError(
      `Credential must be a secret reference object, got ${typeof value}`
    );
  }

  if (typeof value.env === 'string' && value.env.length > 0) {
    const resolved = env[value.env];
    if (resolved === undefined || resolved === '') {
      throw new MissingCredentialError(
        'ERR-CRED-001',
        `Environment variable ${value.env} is not set`
      );
    }
    return resolved;
  }

  if (typeof value.secret_ref === 'string') {
    throw new MissingCredentialError(
      'ERR-CRED-002',
      'Secret reference resolution is not supported in v1 (use { env: "NAME" } instead)'
    );
  }

  throw new BareCredentialError(
    'Credential reference must have an `env` or `secret_ref` field'
  );
}
