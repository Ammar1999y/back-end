import { APIError } from 'better-auth/api';

import { CUSTOM_AUTH_CODE, HTTP_STATUS } from '@/utils/api-messages';
import { CustomError } from '@/utils/error-class';

/**
 * Translate a project `CustomError` into Better Auth's error type.
 *
 * Better Call only understands `APIError`; any other throw escapes its
 * boundary as a generic, empty 500. Expected throttles (429) and limiter
 * outages (503) must keep their own status AND their `Retry-After` /
 * `X-RateLimit-*` headers, or clients can't back off correctly and monitoring
 * reads normal throttling as server failure.
 *
 * `genericMessage` is used for every remaining status, which is how
 * account-revealing failures stay collapsed into one indistinguishable
 * response.
 */
export function toAuthApiError(
  error: CustomError,
  genericMessage: string
): APIError {
  const headers = error.responseHeaders;
  switch (error.status) {
    case HTTP_STATUS.TOO_MANY_REQUESTS:
      return new APIError(
        HTTP_STATUS.TOO_MANY_REQUESTS,
        { message: error.message, code: CUSTOM_AUTH_CODE },
        headers
      );
    case HTTP_STATUS.SERVICE_UNAVAILABLE:
      return new APIError(
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        { message: error.message, code: CUSTOM_AUTH_CODE },
        headers
      );
    case HTTP_STATUS.FORBIDDEN:
      return new APIError(HTTP_STATUS.FORBIDDEN, {
        message: error.message,
        code: CUSTOM_AUTH_CODE,
      });
    case HTTP_STATUS.UNPROCESSABLE:
      return new APIError(HTTP_STATUS.UNPROCESSABLE, {
        message: error.message,
        code: CUSTOM_AUTH_CODE,
      });
    default:
      return new APIError(HTTP_STATUS.BAD_REQUEST, {
        message: genericMessage,
        code: CUSTOM_AUTH_CODE,
      });
  }
}
