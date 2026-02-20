import { type Column } from '@tanstack/react-table';

export interface HeaderOptionsProps {
  column: Column<any, any>;
  className?: string;
}

export interface ColumnOptionsProps {
  column: Column<any, any>;
}

export interface OrderContext {
  order: string[];
  setOrder: (newOrder: string[]) => void;
}

export interface ColumnPosition {
  isFirst: boolean;
  isLast: boolean;
}
