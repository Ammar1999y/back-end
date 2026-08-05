import { useCallback, useEffect, useState } from 'react';

import { breakpointsTokens } from '@/utils/breakpoints';

import { PRESETS } from '../constants';
import { getDateAdjustedForTimezone, getPresetRange } from '../utils';

export interface DateRange {
  from: Date | undefined;
  to: Date | undefined;
}

interface UseDateRangeStateProps {
  initialDateFrom?: Date | string;
  initialDateTo?: Date | string;
  onChange?: (range: { from: Date | undefined; to: Date | undefined }) => void;
}

export const useDateRangeState = ({
  initialDateFrom,
  initialDateTo,
  onChange,
}: UseDateRangeStateProps) => {
  const [isOpen, setIsOpen] = useState(false);

  // Committed range (applied to filter)
  const [committedRange, setCommittedRange] = useState<DateRange>({
    from: initialDateFrom
      ? getDateAdjustedForTimezone(initialDateFrom)
      : undefined,
    to: initialDateTo ? getDateAdjustedForTimezone(initialDateTo) : undefined,
  });

  // Temporary range (while popover is open)
  const [tempRange, setTempRange] = useState<DateRange>(committedRange);

  // Controlled month for calendar navigation
  // Falls back to `to` before today: an upper-only range would otherwise open
  // the calendar on the current month with its own selection off-screen.
  const [month, setMonth] = useState<Date>(
    () =>
      committedRange.from ??
      committedRange.to ??
      new Date(new Date().setMonth(new Date().getMonth() - 1))
  );

  // Use tempRange while open, committedRange when closed
  const range = isOpen ? tempRange : committedRange;

  const setRange = useCallback(
    (newRange: DateRange | ((prev: DateRange) => DateRange)) => {
      setTempRange((prevRange) => {
        const updatedRange =
          typeof newRange === 'function' ? newRange(prevRange) : newRange;
        // Navigate to whichever bound the range actually has. `from` only meant
        // an upper-only range never moved the calendar to its own selection.
        const anchor = updatedRange.from ?? updatedRange.to;
        if (anchor) {
          setMonth(new Date(anchor));
        }
        return updatedRange;
      });
    },
    []
  );

  const [selectedPreset, setSelectedPreset] = useState<string | undefined>(
    undefined
  );

  const [isSmallScreen, setIsSmallScreen] = useState(
    typeof window !== 'undefined'
      ? window.innerWidth < Number(breakpointsTokens.lg.slice(0, -2))
      : false
  );

  useEffect(() => {
    const handleResize = () =>
      setIsSmallScreen(
        window.innerWidth < Number(breakpointsTokens.lg.slice(0, -2))
      );
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const setPreset = useCallback(
    (preset: string): void => {
      const range = getPresetRange(preset);
      setRange(range);
    },
    [setRange]
  );

  const checkPreset = useCallback(() => {
    if (!range.from) {
      setSelectedPreset(undefined);
      return;
    }

    for (const preset of PRESETS) {
      const presetRange = getPresetRange(preset.name);

      const normalizedRangeFrom = new Date(range.from);
      normalizedRangeFrom.setHours(0, 0, 0, 0);
      const normalizedPresetFrom = new Date(
        presetRange.from.setHours(0, 0, 0, 0)
      );

      const normalizedRangeTo = new Date(range.to ?? 0);
      normalizedRangeTo.setHours(0, 0, 0, 0);
      const normalizedPresetTo = new Date(
        presetRange.to?.setHours(0, 0, 0, 0) ?? 0
      );

      if (
        normalizedRangeFrom.getTime() === normalizedPresetFrom.getTime() &&
        normalizedRangeTo.getTime() === normalizedPresetTo.getTime()
      ) {
        setSelectedPreset(preset.name);
        return;
      }
    }

    setSelectedPreset(undefined);
  }, [range]);

  useEffect(() => {
    checkPreset();
  }, [checkPreset]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setTempRange(committedRange);
        // Same fallback as the initial state and `setRange`: without it,
        // reopening after navigating elsewhere left an upper-only range showing
        // the wrong month.
        const anchor = committedRange.from ?? committedRange.to;
        if (anchor) {
          setMonth(new Date(anchor));
        }
      }
      setIsOpen(open);
    },
    [committedRange]
  );

  const handleSave = useCallback(() => {
    // Commit the temp range and notify parent
    setCommittedRange(tempRange);
    onChange?.(tempRange);
    setIsOpen(false);
  }, [tempRange, onChange]);

  const handleCancel = useCallback(() => {
    // Revert to committed range
    setTempRange(committedRange);
    setIsOpen(false);
  }, [committedRange]);

  return {
    isOpen,
    range,
    setRange,
    month,
    setMonth,
    selectedPreset,
    setPreset,
    isSmallScreen,
    handleOpenChange,
    handleSave,
    handleCancel,
  };
};
