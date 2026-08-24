/**
 * Shared constants for the Hevy MCP server.
 */

export const SERVER_NAME = "hevy-mcp-server";
export const SERVER_VERSION = "1.0.0";

export const DEFAULT_API_BASE_URL = "https://api.hevyapp.com";
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum characters returned by any single tool call before truncation kicks in. */
export const CHARACTER_LIMIT = 25_000;

/**
 * Hevy enforces per-endpoint page size caps. Exceeding them returns HTTP 400,
 * so these are enforced client-side in the Zod schemas to fail fast with a
 * useful message instead of a bare 400.
 */
export const PAGE_SIZE_LIMITS = {
  workouts: 10,
  workoutEvents: 10,
  routines: 10,
  exerciseTemplates: 100,
  routineFolders: 10,
  bodyMeasurements: 10,
} as const;

/** Conversion factor used only for display; the API is kilograms throughout. */
export const KG_TO_LB = 2.20462;

/**
 * Title prefix marking a workout as an open session.
 *
 * Hevy has no "start workout" endpoint, so an in-progress session is a real
 * workout created up front and rewritten when it ends. The prefix is how any
 * client — a different chat, a different device — finds that open session
 * again, since the server itself holds no state between requests.
 */
export const SESSION_TITLE_PREFIX = "🔴 In Progress";

/** Workouts scanned when looking for an open session. */
export const SESSION_LOOKUP_PAGE_SIZE = 10;

/** Number of pages `hevy_search_exercise_templates` will scan before giving up. */
export const MAX_SEARCH_PAGES = 30;

/** Set types accepted when logging a workout or building a routine. */
export const SET_TYPES = ["warmup", "normal", "failure", "dropset"] as const;

/** Rating of Perceived Exertion values Hevy accepts. */
export const RPE_VALUES = [6, 7, 7.5, 8, 8.5, 9, 9.5, 10] as const;

/** Exercise types available when creating a custom exercise template. */
export const CUSTOM_EXERCISE_TYPES = [
  "weight_reps",
  "reps_only",
  "bodyweight_reps",
  "bodyweight_assisted_reps",
  "duration",
  "weight_duration",
  "distance_duration",
  "short_distance_weight",
] as const;

export const MUSCLE_GROUPS = [
  "abdominals",
  "shoulders",
  "biceps",
  "triceps",
  "forearms",
  "quadriceps",
  "hamstrings",
  "calves",
  "glutes",
  "abductors",
  "adductors",
  "lats",
  "upper_back",
  "traps",
  "lower_back",
  "chest",
  "cardio",
  "neck",
  "full_body",
  "other",
] as const;

export const EQUIPMENT_CATEGORIES = [
  "none",
  "barbell",
  "dumbbell",
  "kettlebell",
  "machine",
  "plate",
  "resistance_band",
  "suspension",
  "other",
] as const;

/** Body measurement fields, in the order they are rendered. */
export const MEASUREMENT_FIELDS = [
  "weight_kg",
  "lean_mass_kg",
  "fat_percent",
  "neck_cm",
  "shoulder_cm",
  "chest_cm",
  "left_bicep_cm",
  "right_bicep_cm",
  "left_forearm_cm",
  "right_forearm_cm",
  "abdomen",
  "waist",
  "hips",
  "left_thigh",
  "right_thigh",
  "left_calf",
  "right_calf",
] as const;
