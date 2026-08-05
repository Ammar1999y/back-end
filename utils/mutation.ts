import { EntityID } from '@/types';

import { CustomError } from './error-class';

type MutationMethod = 'POST' | 'PUT' | 'DELETE';

// Type for local storage handlers
type LocalStorageHandler<TData = any, TVariables = any> = {
  create?: (data: TVariables) => Promise<{ data: TData; message: string }>;
  update?: (
    id: EntityID,
    data: TVariables
  ) => Promise<{ data: TData; message: string }>;
  delete?: (id: EntityID) => Promise<{ data: any; message: string }>;
};

// Registry for local storage handlers by endpoint pattern
const localStorageHandlers = new Map<RegExp, LocalStorageHandler>();

/**
 * Register a local storage handler for a specific endpoint pattern
 */
export const registerLocalStorageHandler = (
  pattern: RegExp,
  handler: LocalStorageHandler
) => {
  localStorageHandlers.set(pattern, handler);
};

interface MutationOptions<TData = unknown, TVariables = unknown> {
  href: string;
  method: MutationMethod;
  data?: TVariables;
  onSuccess?: (data: TData) => void | Promise<void>;
  onError?: (error: CustomError) => void;
  useFormData?: boolean; // Flag to use FormData instead of JSON
}

const NETWORK_ERROR_MESSAGE = 'لايوجد اتصال بالانترنت، اعد المحاولة';

/**
 * `code` on the thrown error, so a caller can tell "the write never happened"
 * from "the write happened and the UI update after it failed". The second must
 * never be presented as retryable: retrying re-applies a mutation that already
 * committed.
 */
export const MUTATION_AFTER_SUCCESS_CODE = 'after_success_failed';
const AFTER_SUCCESS_MESSAGE = 'تم الحفظ، لكن تعذر تحديث العرض. اعد تحميل الصفحة';

export const mutate = async <TData = unknown, TVariables = unknown>({
  href,
  method,
  data,
  onSuccess,
  onError,
  useFormData = false,
}: MutationOptions<TData, TVariables>): Promise<{
  data?: TData;
  message?: string;
}> => {
  const isFormData = data instanceof FormData || useFormData;

  // Serialised BEFORE the transport block. `JSON.stringify` throws a TypeError
  // on a BigInt or a circular structure, and inside the try that landed in the
  // network branch — reported as "no internet" for a request that was never
  // sent. A payload we cannot encode is a caller bug, not a connectivity
  // problem.
  let body: BodyInit | undefined;
  if (data !== undefined) {
    if (isFormData) {
      body = data as FormData;
    } else {
      try {
        body = JSON.stringify(data);
      } catch {
        const encodeError = new CustomError('تعذر تجهيز البيانات للإرسال', 400);
        onError?.(encodeError);
        throw encodeError;
      }
    }
  }

  let result: { success?: boolean; data?: TData; message?: string };
  let status: number;
  let responseStatus: number | undefined;

  // TRANSPORT ONLY. `onSuccess` used to run inside this block, so any exception
  // a callback threw — a cache update reading a field the response didn't carry,
  // for instance — was caught here, matched `instanceof TypeError`, and reported
  // as "no internet" (503) for a write that had already committed. The user was
  // told the save failed and invited to retry it.
  try {
    const response = await fetch(href, {
      method,
      headers: isFormData
        ? undefined
        : {
            'Content-Type': 'application/json',
          },
      // Sent for DELETE too. It used to be dropped unconditionally, which made
      // any DELETE with a required body unreachable through this helper — the
      // sessions endpoint takes `{sessionIds}` or `{revokeAll:true}`.
      body,
    });

    status = response.status;
    // Captured before parsing so a non-JSON body keeps the status the server
    // actually sent. Collapsing everything to 500 hid the real outcome — a 502
    // from a proxy and a 200 with a truncated body looked identical.
    responseStatus = status;
    result = await response.json();
  } catch (error) {
    if (error instanceof TypeError) {
      const networkError = new CustomError(
        'لايوجد اتصال بالانترنت، اعد المحاولة',
        503
      );
      onError?.(networkError);
      throw networkError;
    }
    // A non-JSON body (an HTML error page from a proxy) lands here too. If the
    // response itself reported a failure status, that status is the truth worth
    // surfacing; only an unreadable SUCCESS response is genuinely a 500.
    const unexpectedError = new CustomError(
      'حدث خطأ غير متوقع',
      responseStatus && (responseStatus < 200 || responseStatus >= 300)
        ? responseStatus
        : 500
    );
    onError?.(unexpectedError);
    throw unexpectedError;
  }

  if (status < 200 || status >= 300 || !result?.success) {
    const error = new CustomError(
      result?.message || NETWORK_ERROR_MESSAGE,
      status
    );
    onError?.(error);
    throw error;
  }

  // Past this point the server has committed, so a failing callback is local
  // bookkeeping — reported as its own outcome ("saved, but the view could not
  // be refreshed") rather than as a failed or retryable mutation. `onError` is
  // deliberately not called: nothing about the request failed.
  if (onSuccess) {
    try {
      await onSuccess(result.data as TData);
    } catch (error) {
      console.error('mutate.onSuccess failed after a committed write', error);
      throw new CustomError(
        AFTER_SUCCESS_MESSAGE,
        500,
        MUTATION_AFTER_SUCCESS_CODE
      );
    }
  }

  return {
    data: result.data,
    message: result.message,
  };
};
