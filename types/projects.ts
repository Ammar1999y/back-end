import { EntityID } from '.';

export interface ProjectClient {
  id: EntityID;
  title: string;
  description?: string;
  link?: string;
  categoryId?: EntityID | null;
  isActive?: boolean;
  createdAt: string | null;
  updatedAt?: string | null;
}
