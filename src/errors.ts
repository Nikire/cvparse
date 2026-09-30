/** Machine-readable error codes thrown by cvparse. */
export type CvparseErrorCode =
  /** The input text is empty or otherwise unusable. */
  | "INVALID_INPUT"
  /** The model did not return a valid object matching the schema. */
  | "NO_OBJECT_GENERATED"
  /** The provider / network call failed (auth, connection refused, rate limit, ...). */
  | "PROVIDER_ERROR"
  /** The normalized result did not pass the strict resume schema. */
  | "VALIDATION_ERROR";

/**
 * Error thrown by `parseResume`. Wraps provider and AI SDK errors so callers can
 * `instanceof CvparseError` and switch on `code`. The original error is available as `cause`.
 */
export class CvparseError extends Error {
  override readonly name = "CvparseError";
  readonly code: CvparseErrorCode;
  /** HTTP status code when the failure came from a provider API call. */
  readonly statusCode: number | undefined;
  /** Raw model text when the model produced something that could not be parsed. */
  readonly rawText: string | undefined;

  constructor(
    code: CvparseErrorCode,
    message: string,
    options: { cause?: unknown; statusCode?: number; rawText?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.statusCode = options.statusCode;
    this.rawText = options.rawText;
  }

  /** Type guard for {@link CvparseError}. */
  static is(error: unknown): error is CvparseError {
    return error instanceof CvparseError;
  }
}
