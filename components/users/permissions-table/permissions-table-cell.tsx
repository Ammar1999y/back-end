import { memo, useCallback } from 'react';

import { toast } from 'sonner';
import { useShallow } from 'zustand/shallow';

import { Checkbox } from '@/components/ui/checkbox-animate';

import { getGateIndex, usePermissionsTableStore } from './store';

interface PermissionsTableCellProps {
  rowIndex: number;
  colIndex: number;
}

const GATE_TOAST_MSG = 'يجب تفعيل صلاحية العرض للصفحة لتفعيل باقي الصلاحيات';

const PermissionsTableCell = memo(
  ({ rowIndex, colIndex }: PermissionsTableCellProps) => {
    const { checked, gatedOff } = usePermissionsTableStore(
      useShallow((s) => {
        const gateIdx = getGateIndex(colIndex);
        return {
          checked: s.checkboxStates[rowIndex]?.[colIndex] ?? false,
          gatedOff:
            gateIdx >= 0 && !(s.checkboxStates[rowIndex]?.[gateIdx] ?? false),
        };
      })
    );

    const handleChange = useCallback(
      (value: boolean) => {
        usePermissionsTableStore
          .getState()
          .toggleCell(rowIndex, colIndex, value);
      },
      [rowIndex, colIndex]
    );

    const handleDisabledClick = useCallback(() => {
      toast.info(GATE_TOAST_MSG);
    }, []);

    if (gatedOff) {
      return (
        <div
          role='button'
          tabIndex={0}
          onClick={handleDisabledClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') handleDisabledClick();
          }}
          className='flex justify-center'
        >
          <Checkbox
            checked={false}
            disabled
            className='pointer-events-none mx-auto'
          />
        </div>
      );
    }

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
