export {
  createAuthMiddleware,
  Permission,
  requirePermissions,
  requireTenant,
  UserRole,
  type AuthConfig,
  type AuthMiddlewareOptions,
  type AuthMode,
  type RequestIdentity,
} from './auth.middleware.js';
export {
  createErrorHandler,
  notFoundHandler,
  type ErrorHandlerOptions,
} from './error-handler.js';
export {
  AppError,
  AuthError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  NotImplementedError,
  RateLimitError,
  UpstreamError,
  ValidationError,
} from './errors.js';
