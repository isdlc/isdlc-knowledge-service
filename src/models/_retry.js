// Internal helpers shared by cloud Model Adapters (T007).
// Not part of the public Model Adapter interface — leading underscore denotes
// module-private. See src/models/{openai,cohere,bedrock}.js consumers.
//
// ModelError carries an iSDLC error taxonomy code (see error-taxonomy.md).

export class ModelError extends Error {
  constructor({ code, provider, cause, message }) {
    const finalMessage =
      message ?? `${provider}: ${code} after retries (cause: ${cause?.message ?? 'unknown'})`;
    super(finalMessage);
    this.name = 'ModelError';
    this.code = code;
    this.provider = provider;
    if (cause !== undefined) this.cause = cause;
  }
}

export function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Return true for HTTP-style errors that should trigger a retry: 429 or any 5xx.
 * Inspects the common shapes used across SDKs:
 *   - openai npm package: err.status
 *   - cohere-ai SDK:      err.statusCode
 *   - aws-sdk v3:         err.$metadata.httpStatusCode (and/or err.name === 'ThrottlingException')
 */
export function isRetryableHttp(err) {
  if (!err || typeof err !== 'object') return false;

  if (err.name === 'ThrottlingException') return true;

  const status =
    err.status ??
    err.statusCode ??
    err.$metadata?.httpStatusCode ??
    err.response?.status ??
    null;

  if (typeof status !== 'number') return false;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}
