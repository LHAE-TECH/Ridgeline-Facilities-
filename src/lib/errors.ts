/** Business-rule violation that should be shown to the user (HTTP 400/409). */
export class AppError extends Error {
  constructor(message: string, public status = 400, public code = 'invalid') {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(what = 'Record') {
    super(`${what} not found`, 404, 'not_found');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource') {
    super(message, 403, 'forbidden');
  }
}

export function assert(cond: unknown, message: string, status = 400): asserts cond {
  if (!cond) throw new AppError(message, status);
}
