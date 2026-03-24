import { EntityID } from '@/types';

import { extractIdFromUrl } from '.';
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
  try {
    // Check if endpoint has a local storage handler
    for (const [pattern, handler] of localStorageHandlers) {
      if (pattern.test(href)) {
        const id = extractIdFromUrl(href);

        let result: { data: TData; message: string };

        if (method === 'POST' && handler.create) {
          result = await handler.create(data);
        } else if (method === 'PUT' && handler.update && id) {
          result = await handler.update(id, data);
        } else if (method === 'DELETE' && handler.delete && id) {
          result = await handler.delete(id);
        } else {
          throw new CustomError('عملية غير صحيحة', 400);
        }

        if (onSuccess && result.data) await onSuccess(result.data);

        return result;
      }
    }

    // Original fetch code for endpoints without local storage handler
    const isFormData = data instanceof FormData || useFormData;

    const response = await fetch(href, {
      method,
      headers: isFormData
        ? undefined
        : {
            'Content-Type': 'application/json',
          },
      body:
        method !== 'DELETE'
          ? isFormData
            ? (data as FormData)
            : JSON.stringify(data)
          : undefined,
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      const error = new CustomError(
        result.message || 'لايوجد اتصال بالانترنت، اعد المحاولة',
        response.status
      );
      throw error;
    }

    if (onSuccess) await onSuccess(result.data);

    return {
      data: result.data,
      message: result.message,
    };
  } catch (error) {
    if (error instanceof CustomError) {
      onError?.(error);
      throw error;
    }
    if (error instanceof TypeError) {
      const networkError = new CustomError(
        'لايوجد اتصال بالانترنت، اعد المحاولة',
        503
      );
      onError?.(networkError);
      throw networkError;
    }
    const unexpectedError = new CustomError('حدث خطأ غير متوقع', 500);
    onError?.(unexpectedError);
    throw unexpectedError;
  }
};
