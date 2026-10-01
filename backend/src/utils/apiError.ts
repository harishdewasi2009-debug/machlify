export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

export const Errors = {
  invalidCredentials: () =>
    new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect."),
  emailInUse: () => new ApiError(409, "EMAIL_IN_USE", "An account with this email already exists."),
  notFound: (what: string) => new ApiError(404, "NOT_FOUND", `${what} not found.`),
  underMinimumAge: (minAge: number) =>
    new ApiError(403, "UNDER_MINIMUM_AGE", `You must be at least ${minAge} years old to use Matchify.`),
  accountLocked: () =>
    new ApiError(423, "ACCOUNT_LOCKED", "This account is temporarily locked due to failed login attempts."),
  accountSuspended: () => new ApiError(403, "ACCOUNT_SUSPENDED", "This account has been suspended."),
  accountPendingDeletion: () =>
    new ApiError(
      403,
      "ACCOUNT_PENDING_DELETION",
      "This account is scheduled for deletion. Use the link in your deletion confirmation email to restore it."
    ),
  invalidToken: () => new ApiError(400, "INVALID_TOKEN", "This token is invalid or has expired."),
  unauthorized: () => new ApiError(401, "UNAUTHORIZED", "Authentication is required."),
  configurationMissing: (what: string) =>
    new ApiError(503, "CONFIGURATION_MISSING", `${what} is not configured on this server.`),
  validation: (message: string) => new ApiError(400, "VALIDATION_ERROR", message),
  forbidden: (message = "You don't have access to this resource.") =>
    new ApiError(403, "FORBIDDEN", message),
  alreadySwiped: () => new ApiError(409, "ALREADY_SWIPED", "You've already swiped on this profile."),
  paymentAlreadyProcessed: () =>
    new ApiError(409, "PAYMENT_ALREADY_PROCESSED", "This payment has already been processed."),
  paymentVerificationFailed: () =>
    new ApiError(400, "PAYMENT_VERIFICATION_FAILED", "Payment signature could not be verified."),
  adminUnauthorized: () => new ApiError(401, "ADMIN_UNAUTHORIZED", "Admin authentication is required."),
  adminForbidden: () =>
    new ApiError(403, "ADMIN_FORBIDDEN", "Your admin role doesn't permit this action."),
};
