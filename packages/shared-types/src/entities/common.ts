import { z } from 'zod';

/** UUID primary key. */
export const Id = z.string().uuid();

/** A foreign-key reference: either the related id (string) or the expanded object. */
export const ref = <T extends z.ZodTypeAny>(schema: T) => z.union([z.string(), schema]);

/** Nullable foreign-key reference. */
export const refNullable = <T extends z.ZodTypeAny>(schema: T) =>
  z.union([z.string(), schema]).nullable();

/** Directus system fields present on every collection (unless stated otherwise). */
export const directusDefaults = {
  id: Id,
  date_created: z.string().datetime().nullable().optional(),
  date_updated: z.string().datetime().nullable().optional(),
  user_created: z.string().nullable().optional(),
  user_updated: z.string().nullable().optional(),
};

/** ISO datetime string. */
export const DateTime = z.string().datetime();
