export type NavItemOptionsProps = {
  depth?: number;
  hasChild?: boolean;
};

export type NavItemStateProps = {
  open?: boolean;
  active?: boolean;
  disabled?: boolean;
  hidden?: boolean;
};

export type NavItemDataProps = {
  path: string;
  title: string;
  icon?: string | React.ReactNode;
  info?: React.ReactNode;
  caption?: string;
  auth?: string[];
  children?: NavItemDataProps[];
  hideChildrenDropdown?: boolean;
  blink?: boolean;
  /** When true, only marks as active when pathname exactly matches path */
  exactMatch?: boolean;
} & NavItemStateProps;

/**
 * Item
 */
export type NavItemProps = React.ComponentProps<'div'> &
  NavItemDataProps &
  NavItemOptionsProps;

/**
 * List
 */
export type NavListProps = Pick<NavItemProps, 'depth'> & {
  data: NavItemDataProps;
  authenticate?: (auth?: NavItemProps['auth']) => boolean;
};

/**
 * Group
 */
export type NavGroupProps = Omit<NavListProps, 'data' | 'depth'> & {
  name?: string;
  items: NavItemDataProps[];
};

/**
 * Main
 */
export type NavProps = React.ComponentProps<'nav'> &
  Omit<NavListProps, 'data' | 'depth'> & {
    data: {
      name?: string;
      items: NavItemDataProps[];
    }[];
  };
