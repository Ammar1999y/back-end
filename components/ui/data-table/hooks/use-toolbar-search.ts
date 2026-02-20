import type { SearchableColumn } from '../utils/column-utils';

import { useMemo, useState } from 'react';

export const useToolbarSearch = (
  availableSearchColumns: SearchableColumn[]
) => {
  const [searchColumn, setSearchColumn] = useState(
    availableSearchColumns[0]?.id || ''
  );
  const [searchValue, setSearchValue] = useState<string | [string, string]>('');

  const selectedColumnInfo = useMemo(
    () =>
      availableSearchColumns.find((col) => col.id === searchColumn) ||
      availableSearchColumns[0],
    [availableSearchColumns, searchColumn]
  );

  const handleColumnChange = (value: string) => {
    setSearchValue('');
    setSearchColumn(value);
  };

  return {
    searchColumn,
    searchValue,
    selectedColumnInfo,
    setSearchColumn: handleColumnChange,
    setSearchValue,
  };
};
