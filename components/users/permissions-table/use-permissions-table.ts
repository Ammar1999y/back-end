import { useCallback, useEffect } from 'react';

import { useShallow } from 'zustand/shallow';

import permissionPages from './data';
import { usePermissionsTableStore } from './store';

export function usePermissionsTable(setInitPermissions: boolean = true) {
  const { initializeStates, toggleCell, toggleAllColumn, toggleAllRow } =
    usePermissionsTableStore(
      useShallow((s) => ({
        initializeStates: s.initializeStates,
        toggleCell: s.toggleCell,
        toggleAllColumn: s.toggleAllColumn,
        toggleAllRow: s.toggleAllRow,
      }))
    );

  useEffect(() => {
    if (setInitPermissions) initializeStates(permissionPages);
  }, [initializeStates, setInitPermissions]);

  const handleCheckboxChange = useCallback(
    (rowIndex: number, colIndex: number, checked: boolean) => {
      toggleCell(rowIndex, colIndex, checked);
    },
    [toggleCell]
  );

  const toggleAllView = useCallback(() => {
    toggleAllColumn(0);
  }, [toggleAllColumn]);

  const toggleAllEdit = useCallback(() => {
    toggleAllColumn(1);
  }, [toggleAllColumn]);

  const toggleAllDelete = useCallback(() => {
    toggleAllColumn(2);
  }, [toggleAllColumn]);

  const toggleAllCreate = useCallback(() => {
    toggleAllColumn(3);
  }, [toggleAllColumn]);

  const handleToggleRowAll = useCallback(
    (rowIndex: number) => {
      toggleAllRow(rowIndex);
    },
    [toggleAllRow]
  );

  return {
    toggleAllView,
    toggleAllEdit,
    toggleAllDelete,
    toggleAllCreate,
    toggleRowAll: handleToggleRowAll,
    handleCheckboxChange,
  };
}
