import { EntityID } from '.';

interface Item {
  id: EntityID;
  title?: string;
  subtitle?: string;
  description?: string;
  isActive?: boolean;
  order?: number;
}

interface SectionClient {
  id: EntityID;
  title?: string;
  subtitle?: string;
  shortDescription?: string;
  description?: any | null; // Rich text content

  isActive?: boolean;
  createdAt: string | null;
  updatedAt?: string | null;
  items?: Item[] | null;
  slug?: string;
}

export type { SectionClient, Item };
