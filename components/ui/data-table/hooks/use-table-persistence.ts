import type { ColumnPinningState } from '@tanstack/react-table';

import { useCallback, useEffect, useRef } from 'react';

import useIsomorphicLayoutEffect from '@/hooks/use-layout-effect';

import {
  useColumnOrder,
  useColumnPinning,
  useColumnSizing,
  useColumnVisibility,
} from '../store';

interface PersistedTableState {
  columnVisibility?: Record<string, boolean>;
  columnSizing?: Record<string, number>;
  columnPinning?: ColumnPinningState;
  columnOrder?: string[];
}

interface TablePersistenceDefaults {
  columnPinning?: ColumnPinningState;
  columnOrder?: string[];
}

const DEBOUNCE_MS = 500;

/**
 * Converts queryKey array to a storage key string
 */
const createStorageKey = (
  prefix: string,
  queryKey: (string | number | unknown)[]
): string => {
  const key = queryKey
    .map((item) => {
      if (typeof item === 'string' || typeof item === 'number') {
        return String(item);
      }
      return JSON.stringify(item);
    })
    .join('-');
  return `${prefix}${key}`;
};

/**
 * Loads persisted state from localStorage
 */
const loadPersistedState = (storageKey: string): PersistedTableState | null => {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return null;
    return JSON.parse(stored) as PersistedTableState;
  } catch {
    return null;
  }
};

/**
 * Saves state to localStorage
 */
const savePersistedState = (
  storageKey: string,
  state: PersistedTableState
): void => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Storage might be full or unavailable
  }
};

/**
 * Hook to persist table state to localStorage
 * Uses Zustand subscribe for efficient saving without re-renders
 */
const useTablePersistence = (
  storagePrefix: string,
  queryKey: (string | number | unknown)[],
  defaults?: TablePersistenceDefaults
): void => {
  const storageKey = createStorageKey(storagePrefix, queryKey);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitializedRef = useRef(false);

  // Debounced save function
  const debouncedSave = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      // Don't save during initial load
      if (!isInitializedRef.current) return;

      const state: PersistedTableState = {
        columnVisibility: useColumnVisibility.getState().columnVisibility,
        columnSizing: useColumnSizing.getState().columnSizing,
        columnPinning: useColumnPinning.getState().columnPinning,
        columnOrder: useColumnOrder.getState().columnOrder,
      };

      savePersistedState(storageKey, state);
    }, DEBOUNCE_MS);
  }, [storageKey]);

  // Load persisted state before first render
  useIsomorphicLayoutEffect(() => {
    const persisted = loadPersistedState(storageKey);

    const applyState = () => {
      if (persisted) {
        // Apply persisted state (columnSizing handled via table.setColumnSizing in client-side-table)
        if (persisted.columnVisibility) {
          useColumnVisibility
            .getState()
            .setColumnVisibility(persisted.columnVisibility);
        }
        if (persisted.columnPinning) {
          useColumnPinning.getState().setColumnPinning(persisted.columnPinning);
        }
        if (persisted.columnOrder?.length) {
          useColumnOrder.getState().setColumnOrder(persisted.columnOrder);
        }
      } else if (defaults) {
        // Apply defaults if no persisted state
        if (defaults.columnPinning) {
          useColumnPinning.getState().setColumnPinning(defaults.columnPinning);
        }
        if (defaults.columnOrder?.length) {
          useColumnOrder.getState().setColumnOrder(defaults.columnOrder);
        }
      }
    };

    applyState();
    requestAnimationFrame(applyState);

    // Mark as initialized after loading
    requestAnimationFrame(() => {
      isInitializedRef.current = true;
    });
  }, [storageKey, defaults]);

  // Subscribe to store changes for saving
  useEffect(() => {
    const unsubscribes = [
      useColumnVisibility.subscribe(debouncedSave),
      useColumnSizing.subscribe(debouncedSave),
      useColumnPinning.subscribe(debouncedSave),
      useColumnOrder.subscribe(debouncedSave),
    ];

    return () => {
      // Cleanup subscriptions
      unsubscribes.forEach((unsubscribe) => unsubscribe());

      // Clear pending debounce
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [debouncedSave]);
};

export { useTablePersistence, createStorageKey };
