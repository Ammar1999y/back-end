import { EntityID } from '@/types';
import { useQuery } from '@tanstack/react-query';

import { extractIdFromUrl } from '.';
import { CustomError } from './error-class';

// Type for local storage query handlers
type LocalStorageQueryHandler<TData = any> = {
  getAll?: () => Promise<TData>;
  getById?: (id: EntityID) => Promise<TData>;
};

// Registry for local storage query handlers by endpoint pattern
const localStorageQueryHandlers = new Map<RegExp, LocalStorageQueryHandler>();

/**
 * Register a local storage query handler for a specific endpoint pattern
 */
export const registerLocalStorageQueryHandler = (
  pattern: RegExp,
  handler: LocalStorageQueryHandler
) => {
  localStorageQueryHandlers.set(pattern, handler);
};

export const useQueryData = <TData = unknown>({
  queryKey,
  href,
  enabled = true,
  requiredData = true,
}: {
  queryKey: (string | number | EntityID)[];
  href: string;
  enabled?: boolean;
  requiredData?: boolean | string | number | undefined | null;
}) =>
  useQuery<TData>({
    queryKey,
    queryFn: async () => {
      if (!requiredData)
        throw new CustomError('البيانات غير صحيحة، اعد المحاوله', 400);
      // TODO: remove it
      await new Promise((res) =>
        setTimeout(() => {
          res('');
        }, 800)
      );

      // Check if endpoint has a local storage query handler
      for (const [pattern, handler] of localStorageQueryHandlers) {
        if (pattern.test(href)) {
          const id = extractIdFromUrl(href);
          if (id && handler.getById) {
            return await handler.getById(id);
          } else if (handler.getAll) {
            return await handler.getAll();
          }
        }
      }

      try {
        const response = await fetch(href);
        const result = await response.json();

        if (!response.ok || result.error)
          throw new CustomError(
            result.error || 'لايوجد اتصال بالانترنت، اعد المحاولة',
            response.status
          );
        return result.data;
      } catch (error) {
        if (error instanceof CustomError) throw error;
        if (error instanceof TypeError)
          throw new CustomError('لايوجد اتصال بالانترنت، اعد المحاولة', 503);
        throw new CustomError('حدث خطأ غير متوقع', 500);
      }
    },
    enabled,
  });
