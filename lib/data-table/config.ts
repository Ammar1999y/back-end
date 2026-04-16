export type DataTableConfig = typeof dataTableConfig;

const operators = [
  'iLike',
  'notILike',
  'eq',
  'ne',
  'inArray',
  'notInArray',
  'isEmpty',
  'isNotEmpty',
  'lt',
  'lte',
  'gt',
  'gte',
  'isBetween',
  'startsWith',
  'endsWith',
] as const;

const joinOperators = ['and', 'or'] as const;
const filterVariants = [
  'text',
  'number',
  'range',
  'date',
  'boolean',
  'select',
  'multiSelect',
] as const;

type JoinOperator = (typeof joinOperators)[number];
type FilterVariant = (typeof filterVariants)[number];
type Operator = (typeof operators)[number];

const dataTableConfig = {
  textOperators: [
    { label: 'يحتوي على', value: 'iLike' as Operator },
    { label: 'لا يحتوي على', value: 'notILike' as Operator },
    { label: 'يبدأ بـ', value: 'startsWith' as Operator },
    { label: 'ينتهي بـ', value: 'endsWith' as Operator },
    { label: 'يساوي', value: 'eq' as Operator },
    { label: 'لا يساوي', value: 'ne' as Operator },
    { label: 'فارغ', value: 'isEmpty' as Operator },
    { label: 'غير فارغ', value: 'isNotEmpty' as Operator },
  ],
  numericOperators: [
    { label: 'يساوي', value: 'eq' as Operator },
    { label: 'لا يساوي', value: 'ne' as Operator },
    { label: 'أقل من', value: 'lt' as Operator },
    { label: 'أقل من أو يساوي', value: 'lte' as Operator },
    { label: 'أكبر من', value: 'gt' as Operator },
    { label: 'أكبر من أو يساوي', value: 'gte' as Operator },
    { label: 'بين', value: 'isBetween' as Operator },
    { label: 'فارغ', value: 'isEmpty' as Operator },
    { label: 'غير فارغ', value: 'isNotEmpty' as Operator },
  ],
  dateOperators: [
    { label: 'يساوي', value: 'eq' as Operator },
    { label: 'لا يساوي', value: 'ne' as Operator },
    { label: 'قبل', value: 'lt' as Operator },
    { label: 'بعد', value: 'gt' as Operator },
    { label: 'يساوي أو قبل', value: 'lte' as Operator },
    { label: 'يساوي أو بعد', value: 'gte' as Operator },
    { label: 'بين', value: 'isBetween' as Operator },
    { label: 'فارغ', value: 'isEmpty' as Operator },
    { label: 'غير فارغ', value: 'isNotEmpty' as Operator },
  ],
  selectOperators: [
    { label: 'يساوي', value: 'eq' as Operator },
    { label: 'لا يساوي', value: 'ne' as Operator },
    { label: 'فارغ', value: 'isEmpty' as Operator },
    { label: 'غير فارغ', value: 'isNotEmpty' as Operator },
  ],
  multiSelectOperators: [
    { label: 'يحتوي على أي من', value: 'inArray' as Operator },
    { label: 'لا يحتوي على أي من', value: 'notInArray' as Operator },
    { label: 'فارغ', value: 'isEmpty' as Operator },
    { label: 'غير فارغ', value: 'isNotEmpty' as Operator },
  ],
  booleanOperators: [
    { label: 'يساوي', value: 'eq' as Operator },
    { label: 'لا يساوي', value: 'ne' as Operator },
  ],
  sortOrders: [
    { label: 'تصاعدي', value: 'asc' as Operator },
    { label: 'تنازلي', value: 'desc' as Operator },
  ],
  filterVariants,
  operators,
  joinOperators,
};

export type { Operator, JoinOperator, FilterVariant };
export { dataTableConfig };
