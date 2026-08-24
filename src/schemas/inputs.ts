/**
 * Zod input schemas for every tool.
 *
 * These enforce Hevy's documented constraints client-side (page size caps, set
 * type and RPE enums, ISO date formats) so the agent gets a precise validation
 * message instead of an opaque HTTP 400.
 */

import { z } from "zod";
import {
  CUSTOM_EXERCISE_TYPES,
  EQUIPMENT_CATEGORIES,
  MUSCLE_GROUPS,
  PAGE_SIZE_LIMITS,
  RPE_VALUES,
  SET_TYPES,
} from "../constants.js";
import { RESPONSE_FORMATS } from "../formatters/response.js";

export const responseFormatField = z
  .enum(RESPONSE_FORMATS)
  .default("markdown")
  .describe("Output format: 'markdown' for human-readable, 'json' for machine-readable");

/** Builds the page/page_size pair with the correct cap for a given endpoint. */
export const paginationFields = (maxPageSize: number, defaultPageSize: number) => ({
  page: z
    .number()
    .int()
    .min(1, "page is 1-indexed and must be 1 or greater")
    .default(1)
    .describe("Page number, 1-indexed"),
  page_size: z
    .number()
    .int()
    .min(1)
    .max(maxPageSize, `Hevy caps this endpoint at ${maxPageSize} items per page`)
    .default(defaultPageSize)
    .describe(`Items per page (max ${maxPageSize})`),
});

const isoDateTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
    "Must be an ISO 8601 timestamp, e.g. 2026-08-24T18:00:00Z",
  );

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a date in YYYY-MM-DD format, e.g. 2026-08-24");

/* -------------------------------------------------------------------------- */
/* Sets and exercises                                                          */
/* -------------------------------------------------------------------------- */

const setMetricFields = {
  weight_kg: z
    .number()
    .nonnegative()
    .nullable()
    .optional()
    .describe("Weight in KILOGRAMS. Convert from pounds before sending (lb / 2.20462)"),
  reps: z.number().int().nonnegative().nullable().optional().describe("Number of repetitions"),
  distance_meters: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional()
    .describe("Distance in meters, for cardio exercises"),
  duration_seconds: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional()
    .describe("Duration in seconds, for timed exercises"),
  custom_metric: z
    .number()
    .nullable()
    .optional()
    .describe("Custom metric — currently used for steps or floors on stair machines"),
};

export const workoutSetSchema = z
  .object({
    type: z.enum(SET_TYPES).default("normal").describe("Set type"),
    ...setMetricFields,
    rpe: z
      .union(RPE_VALUES.map((value) => z.literal(value)) as [z.ZodLiteral<number>, z.ZodLiteral<number>, ...z.ZodLiteral<number>[]])
      .nullable()
      .optional()
      .describe(`Rating of Perceived Exertion — one of ${RPE_VALUES.join(", ")}`),
  })
  .strict();

export const routineSetSchema = z
  .object({
    type: z.enum(SET_TYPES).default("normal").describe("Set type"),
    ...setMetricFields,
    rep_range: z
      .object({
        start: z.number().int().nonnegative().describe("Lower bound of the target rep range"),
        end: z.number().int().nonnegative().describe("Upper bound of the target rep range"),
      })
      .strict()
      .nullable()
      .optional()
      .describe("Target rep range for planned sets, e.g. { start: 8, end: 12 }"),
  })
  .strict();

export const workoutExerciseSchema = z
  .object({
    exercise_template_id: z
      .string()
      .min(1)
      .describe(
        "Exercise template id — find it with hevy_search_exercise_templates, e.g. 'D04AC939'",
      ),
    superset_id: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe("Shared integer groups exercises into a superset; null means no superset"),
    notes: z.string().nullable().optional().describe("Notes for this exercise"),
    sets: z.array(workoutSetSchema).min(1, "Each exercise needs at least one set"),
  })
  .strict();

export const routineExerciseSchema = z
  .object({
    exercise_template_id: z
      .string()
      .min(1)
      .describe("Exercise template id — find it with hevy_search_exercise_templates"),
    superset_id: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe("Shared integer groups exercises into a superset; null means no superset"),
    rest_seconds: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe("Rest between sets, in seconds"),
    notes: z.string().nullable().optional().describe("Notes for this exercise"),
    sets: z.array(routineSetSchema).min(1, "Each exercise needs at least one set"),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Workouts                                                                    */
/* -------------------------------------------------------------------------- */

export const listWorkoutsSchema = z
  .object({
    ...paginationFields(PAGE_SIZE_LIMITS.workouts, 5),
    detailed: z
      .boolean()
      .default(false)
      .describe("Include every set of every exercise. Leave false for a compact overview"),
    response_format: responseFormatField,
  })
  .strict();

export const getWorkoutSchema = z
  .object({
    workout_id: z.string().min(1).describe("Workout UUID, from hevy_list_workouts"),
    response_format: responseFormatField,
  })
  .strict();

export const countWorkoutsSchema = z.object({}).strict();

export const listWorkoutEventsSchema = z
  .object({
    since: isoDateTime
      .default("1970-01-01T00:00:00Z")
      .describe("Return events after this ISO 8601 timestamp"),
    ...paginationFields(PAGE_SIZE_LIMITS.workoutEvents, 10),
    response_format: responseFormatField,
  })
  .strict();

const workoutBodyFields = {
  title: z.string().min(1).max(200).describe("Workout title, e.g. 'Upper A'"),
  description: z.string().nullable().optional().describe("Workout description or notes"),
  start_time: isoDateTime.describe("When the workout started, ISO 8601"),
  end_time: isoDateTime.describe("When the workout ended, ISO 8601"),
  is_private: z.boolean().default(false).describe("Hide this workout from your public profile"),
  exercises: z
    .array(workoutExerciseSchema)
    .min(1, "A workout needs at least one exercise")
    .describe("Exercises in order"),
};

export const createWorkoutSchema = z.object(workoutBodyFields).strict();

export const updateWorkoutSchema = z
  .object({
    workout_id: z.string().min(1).describe("UUID of the workout to overwrite"),
    ...workoutBodyFields,
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Routines                                                                    */
/* -------------------------------------------------------------------------- */

export const listRoutinesSchema = z
  .object({
    ...paginationFields(PAGE_SIZE_LIMITS.routines, 5),
    detailed: z.boolean().default(false).describe("Include every planned set"),
    response_format: responseFormatField,
  })
  .strict();

export const getRoutineSchema = z
  .object({
    routine_id: z.string().min(1).describe("Routine UUID, from hevy_list_routines"),
    response_format: responseFormatField,
  })
  .strict();

export const createRoutineSchema = z
  .object({
    title: z.string().min(1).max(200).describe("Routine title, e.g. 'Upper A'"),
    folder_id: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe("Folder id from hevy_list_routine_folders; null puts it in 'My Routines'"),
    notes: z.string().nullable().optional().describe("Notes for the routine"),
    exercises: z.array(routineExerciseSchema).min(1, "A routine needs at least one exercise"),
  })
  .strict();

export const updateRoutineSchema = z
  .object({
    routine_id: z.string().min(1).describe("UUID of the routine to overwrite"),
    title: z.string().min(1).max(200).describe("Routine title"),
    notes: z.string().nullable().optional().describe("Notes for the routine"),
    exercises: z.array(routineExerciseSchema).min(1, "A routine needs at least one exercise"),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Exercise templates                                                          */
/* -------------------------------------------------------------------------- */

export const listExerciseTemplatesSchema = z
  .object({
    ...paginationFields(PAGE_SIZE_LIMITS.exerciseTemplates, 50),
    response_format: responseFormatField,
  })
  .strict();

export const searchExerciseTemplatesSchema = z
  .object({
    query: z
      .string()
      .min(2, "Query must be at least 2 characters")
      .max(100)
      .optional()
      .describe("Case-insensitive substring matched against the exercise title, e.g. 'bench'"),
    muscle_group: z
      .enum(MUSCLE_GROUPS)
      .optional()
      .describe("Restrict to exercises whose primary muscle group matches"),
    equipment: z
      .enum(EQUIPMENT_CATEGORIES)
      .optional()
      .describe("Restrict to titles mentioning this equipment, e.g. 'barbell'"),
    custom_only: z.boolean().default(false).describe("Return only custom exercises you created"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe("Maximum matches to return"),
    response_format: responseFormatField,
  })
  .strict()
  .refine(
    (value) => Boolean(value.query || value.muscle_group || value.equipment || value.custom_only),
    { message: "Provide at least one of: query, muscle_group, equipment, or custom_only" },
  );

export const getExerciseTemplateSchema = z
  .object({
    exercise_template_id: z.string().min(1).describe("Exercise template id, e.g. 'D04AC939'"),
    response_format: responseFormatField,
  })
  .strict();

export const createExerciseTemplateSchema = z
  .object({
    title: z.string().min(1).max(100).describe("Name of the custom exercise"),
    exercise_type: z
      .enum(CUSTOM_EXERCISE_TYPES)
      .describe("How the exercise is measured, e.g. 'weight_reps'"),
    equipment_category: z.enum(EQUIPMENT_CATEGORIES).describe("Equipment used"),
    muscle_group: z.enum(MUSCLE_GROUPS).describe("Primary muscle group"),
    other_muscles: z
      .array(z.enum(MUSCLE_GROUPS))
      .default([])
      .describe("Secondary muscle groups"),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Routine folders                                                             */
/* -------------------------------------------------------------------------- */

export const listRoutineFoldersSchema = z
  .object({
    ...paginationFields(PAGE_SIZE_LIMITS.routineFolders, 10),
    response_format: responseFormatField,
  })
  .strict();

export const getRoutineFolderSchema = z
  .object({
    folder_id: z.number().int().describe("Numeric folder id, from hevy_list_routine_folders"),
    response_format: responseFormatField,
  })
  .strict();

export const createRoutineFolderSchema = z
  .object({
    title: z.string().min(1).max(100).describe("Folder title, e.g. 'Upper/Lower'"),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Exercise history                                                            */
/* -------------------------------------------------------------------------- */

export const getExerciseHistorySchema = z
  .object({
    exercise_template_id: z
      .string()
      .min(1)
      .describe("Exercise template id — find it with hevy_search_exercise_templates"),
    start_date: isoDateTime.optional().describe("Only include sets on or after this timestamp"),
    end_date: isoDateTime.optional().describe("Only include sets on or before this timestamp"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(100)
      .describe("Maximum set entries to return, newest first"),
    response_format: responseFormatField,
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Body measurements                                                           */
/* -------------------------------------------------------------------------- */

const measurementValueFields = {
  weight_kg: z.number().positive().nullable().optional().describe("Body weight in KILOGRAMS"),
  lean_mass_kg: z.number().positive().nullable().optional().describe("Lean mass in kilograms"),
  fat_percent: z.number().min(0).max(100).nullable().optional().describe("Body fat percentage"),
  neck_cm: z.number().positive().nullable().optional().describe("Neck circumference in cm"),
  shoulder_cm: z.number().positive().nullable().optional().describe("Shoulder circumference in cm"),
  chest_cm: z.number().positive().nullable().optional().describe("Chest circumference in cm"),
  left_bicep_cm: z.number().positive().nullable().optional().describe("Left bicep in cm"),
  right_bicep_cm: z.number().positive().nullable().optional().describe("Right bicep in cm"),
  left_forearm_cm: z.number().positive().nullable().optional().describe("Left forearm in cm"),
  right_forearm_cm: z.number().positive().nullable().optional().describe("Right forearm in cm"),
  abdomen: z.number().positive().nullable().optional().describe("Abdomen in cm"),
  waist: z.number().positive().nullable().optional().describe("Waist in cm"),
  hips: z.number().positive().nullable().optional().describe("Hips in cm"),
  left_thigh: z.number().positive().nullable().optional().describe("Left thigh in cm"),
  right_thigh: z.number().positive().nullable().optional().describe("Right thigh in cm"),
  left_calf: z.number().positive().nullable().optional().describe("Left calf in cm"),
  right_calf: z.number().positive().nullable().optional().describe("Right calf in cm"),
};

export const listBodyMeasurementsSchema = z
  .object({
    ...paginationFields(PAGE_SIZE_LIMITS.bodyMeasurements, 10),
    response_format: responseFormatField,
  })
  .strict();

export const getBodyMeasurementSchema = z
  .object({
    date: isoDate.describe("Measurement date, YYYY-MM-DD"),
    response_format: responseFormatField,
  })
  .strict();

export const createBodyMeasurementSchema = z
  .object({
    date: isoDate.describe("Measurement date, YYYY-MM-DD"),
    ...measurementValueFields,
  })
  .strict();

export const updateBodyMeasurementSchema = z
  .object({
    date: isoDate.describe("Date of the entry to overwrite, YYYY-MM-DD"),
    ...measurementValueFields,
  })
  .strict();

export const getUserInfoSchema = z.object({}).strict();
