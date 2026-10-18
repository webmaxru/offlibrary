/**
 * Stable machine-readable error codes. Match on `error.code`, never on the message.
 */
export type OfflibraryErrorCode =
  | 'invalid-config'
  | 'invalid-item'
  | 'unknown-collection'
  | 'not-found'
  | 'not-supported'
  | 'quota-exceeded'
  | 'limit-exceeded'
  | 'http-error'
  | 'network-error'
  | 'opaque-response'
  | 'integrity'
  | 'aborted'
  | 'download-total-exceeded'
  | 'lost'
  | 'unknown';

/** Error thrown (or carried on `error` events) by Offlibrary. */
export class OfflibraryError extends Error {
  override readonly name = 'OfflibraryError';
  /** Machine-readable reason. */
  readonly code: OfflibraryErrorCode;
  /** HTTP status for `http-error`. */
  readonly status?: number;
  /** Whether retrying may succeed. */
  readonly retryable: boolean;

  constructor(
    code: OfflibraryErrorCode,
    message: string,
    options: { cause?: unknown; status?: number; retryable?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

/** Serialisable form stored in IndexedDB and exposed on items. */
export interface SerializedError {
  code: OfflibraryErrorCode;
  message: string;
  status?: number;
}

/** @internal */
export function serializeError(error: unknown): SerializedError {
  const e = toOfflibraryError(error);
  const out: SerializedError = { code: e.code, message: e.message };
  if (e.status !== undefined) out.status = e.status;
  return out;
}

/** @internal */
export function toOfflibraryError(error: unknown): OfflibraryError {
  if (error instanceof OfflibraryError) return error;
  if (isAbortError(error)) return new OfflibraryError('aborted', 'The download was aborted.', { cause: error });
  if (error && typeof error === 'object' && (error as { name?: string }).name === 'QuotaExceededError') {
    return new OfflibraryError('quota-exceeded', 'Not enough storage space for this download.', { cause: error });
  }
  if (error instanceof TypeError) {
    return new OfflibraryError('network-error', error.message || 'Network request failed.', { cause: error, retryable: true });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new OfflibraryError('unknown', message, { cause: error });
}

/** @internal */
export function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError';
}
