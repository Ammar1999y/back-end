import { useCallback, useState } from 'react';

import { getDateAdjustedForTimezone } from '../utils';

interface UseSingleDateStateProps {
  initialDate?: Date | string;
  onChange?: (date: Date | undefined) => void;
}

export const useSingleDateState = ({
  initialDate,
  onChange,
}: UseSingleDateStateProps) => {
  const [isOpen, setIsOpen] = useState(false);

  const [committedDate, setCommittedDate] = useState<Date | undefined>(
    initialDate ? getDateAdjustedForTimezone(initialDate) : undefined
  );

  const [tempDate, setTempDate] = useState<Date | undefined>(committedDate);

  const [month, setMonth] = useState<Date>(() => committedDate ?? new Date());

  const date = isOpen ? tempDate : committedDate;

  const setDate = useCallback((newDate: Date | undefined) => {
    setTempDate(newDate);
    if (newDate) {
      setMonth(new Date(newDate));
    }
  }, []);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setTempDate(committedDate);
        if (committedDate) {
          setMonth(new Date(committedDate));
        }
      }
      setIsOpen(open);
    },
    [committedDate]
  );

  const handleSave = useCallback(() => {
    setCommittedDate(tempDate);
    onChange?.(tempDate);
    setIsOpen(false);
  }, [tempDate, onChange]);

  const handleCancel = useCallback(() => {
    setTempDate(committedDate);
    setIsOpen(false);
  }, [committedDate]);

  return {
    isOpen,
    date,
    setDate,
    month,
    setMonth,
    handleOpenChange,
    handleSave,
    handleCancel,
  };
};
