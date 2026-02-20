import { EntityID } from '.';

export interface CategoryClient {
  id: EntityID;
  title: string;
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
}
