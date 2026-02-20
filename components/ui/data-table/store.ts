import type {
  ColumnFiltersState,
  ColumnPinningState,
} from '@tanstack/react-table';

import { create } from 'zustand';

interface DataTableStore {
  columnVisibility: Record<string, boolean>;
  setColumnVisibility: (columnVisibility: Record<string, boolean>) => void;
}

interface DataTableGlobalFilterStore {
  globalFilter: string;
  setGlobalFilter: (globalFilter: string) => void;
}

interface DataTableColumnFiltersStore {
  columnFilters: ColumnFiltersState;
  setColumnFilters: (columnFilters: ColumnFiltersState) => void;
  addColumnFilter: (columnFilter: ColumnFiltersState[number]) => void;
  removeColumnFilter: (columnFilter: string) => void;
  updateColumnFilter: (
    id: string,
    value: string | [string, string] | string[] | undefined
  ) => void;
}

interface DataTableReRenderStore {
  reRender: number;
  setReRender: () => void;
}

interface DataTableColumnSizingStore {
  columnSizing: Record<string, number>;
  totalSize: number;
  setTotalSize: (totalSize: number) => void;
  setColumnSizing: (columnSizing: Record<string, number>) => void;
}

interface DataTableTableDataStore {
  reRender: number;
  data: any[] | undefined;
  setReRender: () => void;
  setData: (data: any[]) => void;
}

interface DataTableUpdateRowsStore {
  reRender: number;
  setReRender: () => void;
}

interface DataTableColumnPinningStore {
  columnPinning: ColumnPinningState;
  setColumnPinning: (columnPinning: ColumnPinningState) => void;
}

interface DataTableColumnOrderStore {
  columnOrder: string[];
  setColumnOrder: (columnOrder: string[]) => void;
}

const useColumnVisibility = create<DataTableStore>((set) => ({
  columnVisibility: {},
  setColumnVisibility: (columnVisibility) => set({ columnVisibility }),
}));

const useColumnOrder = create<DataTableColumnOrderStore>((set) => ({
  columnOrder: [],
  setColumnOrder: (columnOrder) => set({ columnOrder }),
}));

const useColumnSizing = create<DataTableColumnSizingStore>((set) => ({
  columnSizing: {},
  totalSize: 0,
  setTotalSize: (totalSize) => set({ totalSize }),
  setColumnSizing: (columnSizing) => set({ columnSizing }),
}));

const useGlobalFilter = create<DataTableGlobalFilterStore>((set) => ({
  globalFilter: '',
  setGlobalFilter: (globalFilter) => set({ globalFilter }),
}));

const useColumnFilters = create<DataTableColumnFiltersStore>((set) => ({
  columnFilters: [],
  setColumnFilters: (columnFilters) => set({ columnFilters }),
  addColumnFilter: (columnFilter) =>
    set((state) => ({ columnFilters: [...state.columnFilters, columnFilter] })),
  removeColumnFilter: (columnFilter) =>
    set((state) => ({
      columnFilters: state.columnFilters.filter(
        (filter) => filter.id !== columnFilter
      ),
    })),
  updateColumnFilter: (id, value) =>
    set((state) => {
      const exists = state.columnFilters.some((filter) => filter.id === id);
      return exists
        ? {
            columnFilters: state.columnFilters.map((filter) =>
              filter.id === id ? { ...filter, value } : filter
            ),
          }
        : {
            columnFilters: [...state.columnFilters, { id, value }],
          };
    }),
}));

const useReRender = create<DataTableReRenderStore>((set) => ({
  reRender: 0,
  setReRender: () => set((s) => ({ reRender: s.reRender + 1 })),
}));

const useUpdateRows = create<DataTableUpdateRowsStore>((set) => ({
  reRender: 0,
  setReRender: () => set((s) => ({ reRender: s.reRender + 1 })),
}));

const useTableData = create<DataTableTableDataStore>((set) => ({
  reRender: 0,
  data: undefined,
  setReRender: () => set((s) => ({ reRender: s.reRender + 1 })),
  setData: (data) => set({ data }),
}));

const useColumnPinning = create<DataTableColumnPinningStore>((set) => ({
  columnPinning: { left: [], right: [] },
  setColumnPinning: (columnPinning) => set({ columnPinning }),
}));

const cleaner = () => {
  useColumnSizing.setState({ columnSizing: {} });
  useColumnOrder.setState({ columnOrder: [] });
  useColumnVisibility.setState({ columnVisibility: {} });
  useColumnPinning.setState({ columnPinning: { left: [], right: [] } });
  useReRender.setState({ reRender: 0 });
  useUpdateRows.setState({ reRender: 0 });
  useTableData.setState({ reRender: 0, data: undefined });
};

export {
  useColumnVisibility,
  useColumnSizing,
  useColumnPinning,
  useColumnOrder,
  useGlobalFilter,
  useColumnFilters,
  useReRender,
  useUpdateRows,
  useTableData,
  cleaner,
};
