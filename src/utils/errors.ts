/**
 * Custom CLI error with exit code and optional hint.
 * @module utils/errors
 */

export class CliError extends Error {
  readonly exitCode: number;
  readonly hint?: string;

  constructor(message: string, exitCode = 1, hint?: string) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

/** Auth-related error (exit 2). */
export class AuthError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, 2, hint);
    this.name = 'AuthError';
  }
}

/** Network/API error (exit 3). */
export class ApiError extends CliError {
  readonly statusCode: number;

  constructor(message: string, statusCode: number, hint?: string) {
    super(message, 3, hint);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}
