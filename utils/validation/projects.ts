import * as z from 'zod';

import {
  getIDSchema,
  idSchema,
  sanitizeStrict,
  sanitizeStrictSingleLine,
} from './rules';

// Constants
const PROJECT_TITLE_MIN = 2;
const PROJECT_TITLE_MAX = 150;
const PROJECT_DESCRIPTION_MAX = 1000;
const PROJECT_LINK_MAX = 500;

// Project title schema with sanitization and validation
const projectTitleSchema = z.preprocess(
  sanitizeStrictSingleLine,
  z
    .string()
    .min(
      PROJECT_TITLE_MIN,
      `عنوان المشروع يجب أن يكون ${PROJECT_TITLE_MIN} أحرف على الأقل`
    )
    .max(
      PROJECT_TITLE_MAX,
      `عنوان المشروع يجب أن لا يتجاوز ${PROJECT_TITLE_MAX} حرفاً`
    )
);

// Project description schema (optional)
const projectDescriptionSchema = z.preprocess(
  sanitizeStrict,
  z
    .string()
    .max(
      PROJECT_DESCRIPTION_MAX,
      `وصف المشروع يجب أن لا يتجاوز ${PROJECT_DESCRIPTION_MAX} حرفاً`
    )
);

// Project link schema (optional, simple string validation)
const projectLinkSchema = z.preprocess(
  (v: string) => (typeof v === 'string' ? v.trim() : ''),
  z
    .string()
    .max(PROJECT_LINK_MAX, `الرابط يجب أن لا يتجاوز ${PROJECT_LINK_MAX} حرفاً`)
);

// Create project schema
export const createProjectSchema = z.object({
  title: projectTitleSchema,
  description: projectDescriptionSchema,
  link: projectLinkSchema,
  categoryId: getIDSchema({ optional: true }).nullish(),
  isActive: z.boolean().default(true),
});

// Update project schema (extends create schema with id)
export const updateProjectSchema = createProjectSchema.extend({
  id: idSchema,
});

// Type inference
export type CreateProjectInput = z.input<typeof createProjectSchema>;
export type UpdateProjectInput = z.input<typeof updateProjectSchema>;
export type CreateProjectOutput = z.output<typeof createProjectSchema>;
export type UpdateProjectOutput = z.output<typeof updateProjectSchema>;
