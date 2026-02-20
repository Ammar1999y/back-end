import * as z from 'zod';

import { idSchema, sanitizeStrictSingleLine } from './rules';

// Constants
const TITLE_MIN = 2;
const TITLE_MAX = 150;

const titleSchema = z.preprocess(
  sanitizeStrictSingleLine,
  z
    .string()
    .min(TITLE_MIN, `عنوان الفئة يجب أن يكون ${TITLE_MIN} أحرف على الأقل`)
    .max(TITLE_MAX, `عنوان الفئة يجب أن لا يتجاوز ${TITLE_MAX} حرفاً`)
);

export const createCategorySchema = z.object({
  title: titleSchema,
  isActive: z.boolean().default(true),
});

export const updateCategorySchema = createCategorySchema.extend({
  id: idSchema,
});

// Type inference
export type CreateCategoryInput = z.input<typeof createCategorySchema>;
export type UpdateCategoryInput = z.input<typeof updateCategorySchema>;
export type CreateCategoryOutput = z.output<typeof createCategorySchema>;
export type UpdateCategoryOutput = z.output<typeof updateCategorySchema>;
