import { memo, useCallback } from 'react';

import { useShallow } from 'zustand/shallow';

import { Checkbox } from '@/components/ui/checkbox-animate';

import { usePermissionsTableStore } from './store';

interface PermissionsTableCellProps {
  rowIndex: number;
  colIndex: number;
}

const PermissionsTableCell = memo(
  ({ rowIndex, colIndex }: PermissionsTableCellProps) => {
    const checked = usePermissionsTableStore(
      useShallow((s) => s.checkboxStates[rowIndex]?.[colIndex] ?? false)
    );

    const handleChange = useCallback(
      (value: boolean) => {
        usePermissionsTableStore
          .getState()
          .toggleCell(rowIndex, colIndex, value);
      },
      [rowIndex, colIndex]
    );

    return (
      <Checkbox
        checked={checked}
        onCheckedChange={handleChange}
        className='mx-auto'
      />
    );
  }
);

PermissionsTableCell.displayName = 'PermissionsTableCell';

export default PermissionsTableCell;
