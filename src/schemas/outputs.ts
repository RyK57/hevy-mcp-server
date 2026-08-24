/**
 * Output schemas describing the `structuredContent` each tool returns.
 *
 * These are deliberately permissive (`passthrough`, optional fields). The Hevy
 * API is version 0.0.1 and its docs warn the structure may change; a strict
 * output schema would turn an upstream field addition into a hard tool failure.
 */

import { z } from "zod";

const paginationShape = {
  page: z.number(),
  page_count: z.number(),
  count: z.number(),
  has_more: z.boolean(),
  next_page: z.number().optional(),
};

const loose = z.object({}).passthrough();

/** List response: pagination metadata plus an array under a named key. */
export const listOutput = (key: string) =>
  z.object({ ...paginationShape, [key]: z.array(loose) }).passthrough();

export const singleOutput = (key: string) =>
  z.object({ [key]: loose.nullable() }).passthrough();

export const workoutCountOutput = z.object({ workout_count: z.number() }).passthrough();

export const userInfoOutput = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

export const searchOutput = z
  .object({
    query: z.string().optional(),
    count: z.number(),
    pages_scanned: z.number(),
    scan_complete: z.boolean(),
    exercise_templates: z.array(loose),
  })
  .passthrough();

export const historyOutput = z
  .object({
    exercise_template_id: z.string(),
    count: z.number(),
    total_entries: z.number(),
    truncated: z.boolean(),
    exercise_history: z.array(loose),
  })
  .passthrough();

export const mutationOutput = z
  .object({
    success: z.boolean(),
    message: z.string(),
  })
  .passthrough();
