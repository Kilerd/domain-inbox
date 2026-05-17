// Resend-style error body shared by all API responses.

export type ApiErrorName =
  | "missing_api_key"
  | "invalid_api_key"
  | "validation_error"
  | "rate_limit_exceeded"
  | "not_found"
  | "forbidden"
  | "internal_error";

export interface ApiError {
  name: ApiErrorName;
  message: string;
  statusCode: number;
}

export function errorResponse(name: ApiErrorName, message: string, statusCode: number): Response {
  const body: ApiError = { name, message, statusCode };
  return Response.json(body, { status: statusCode });
}

// Named shortcuts. Each maps to a `(name, status)` pair that Resend SDK
// callers branch on by `name`, so the strings are load-bearing — do not
// rename without also updating any compat surface.
export const httpError = {
  validation: (message: string) => errorResponse("validation_error", message, 422),
  badRequest: (message: string) => errorResponse("validation_error", message, 400),
  unauthorized: (message = "API key is invalid") =>
    errorResponse("invalid_api_key", message, 401),
  missingApiKey: (message = "API key is missing") =>
    errorResponse("missing_api_key", message, 401),
  forbidden: (message: string) => errorResponse("forbidden", message, 403),
  notFound: (message: string) => errorResponse("not_found", message, 404),
  conflict: (message: string) => errorResponse("validation_error", message, 409),
  internal: (message: string, status = 500) => errorResponse("internal_error", message, status),
};
