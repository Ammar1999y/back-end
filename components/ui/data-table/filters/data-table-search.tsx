import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { Search } from 'lucide-react';
import { useShallow } from 'zustand/shallow';

import { useDataTableStore } from '@/utils/store/data-table-store';

import { Input } from '@/components/ui/input';

const DEBOUNCE_MS = 800;

const DataTableSearch = memo(() => {
  const search = useDataTableStore(useShallow((s) => s.search));
  const [localValue, setLocalValue] = useState(search);
  const composingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Sync external store changes (e.g. filters cleared search)
  useEffect(() => {
    setLocalValue(search);
  }, [search]);

  const commit = useCallback((value: string) => {
    clearTimeout(timerRef.current);
    useDataTableStore.getState().actions.setSearch(value);
  }, []);

  const debouncedCommit = useCallback(
    (value: string) => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => commit(value), DEBOUNCE_MS);
    },
    [commit]
  );

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setLocalValue(value);
      debouncedCommit(value);
    },
    [debouncedCommit]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !composingRef.current) {
        commit((e.target as HTMLInputElement).value);
      }
    },
    [commit]
  );

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    composingRef.current = false;
  }, []);

  return (
    <div className='relative'>
      <Search className='pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground' />
      <Input
        value={localValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        dir='auto'
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        placeholder='...البحث السريع'
        className='!h-9 border-0 bg-transparent pr-8 placeholder:!text-right'
      />
    </div>
  );
});
DataTableSearch.displayName = 'DataTableSearch';

export { DataTableSearch };
