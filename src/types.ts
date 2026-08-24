/**
 * TypeScript interfaces mirroring the Hevy API response shapes.
 *
 * Every field the API marks nullable is typed `| null` and every field that is
 * not guaranteed by the spec is optional, because the Hevy API is explicitly
 * versioned 0.0.1 and warns that shapes may change.
 */

import type {
  CUSTOM_EXERCISE_TYPES,
  EQUIPMENT_CATEGORIES,
  MUSCLE_GROUPS,
  SET_TYPES,
} from "./constants.js";

export type SetType = (typeof SET_TYPES)[number];
export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];
export type EquipmentCategory = (typeof EQUIPMENT_CATEGORIES)[number];
export type CustomExerciseType = (typeof CUSTOM_EXERCISE_TYPES)[number];

export interface HevySet {
  index?: number;
  type?: string;
  weight_kg?: number | null;
  reps?: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
  rpe?: number | null;
  custom_metric?: number | null;
}

export interface HevyExercise {
  index?: number;
  title?: string;
  notes?: string | null;
  exercise_template_id?: string;
  supersets_id?: number | null;
  sets?: HevySet[];
}

export interface Workout {
  id: string;
  title?: string;
  routine_id?: string | null;
  description?: string | null;
  start_time?: string;
  end_time?: string;
  updated_at?: string;
  created_at?: string;
  exercises?: HevyExercise[];
}

export interface RoutineSet extends HevySet {
  rep_range?: { start?: number | null; end?: number | null } | null;
}

export interface RoutineExercise extends Omit<HevyExercise, "sets"> {
  rest_seconds?: number | null;
  sets?: RoutineSet[];
}

export interface Routine {
  id: string;
  title?: string;
  folder_id?: number | null;
  notes?: string | null;
  updated_at?: string;
  created_at?: string;
  exercises?: RoutineExercise[];
}

export interface RoutineFolder {
  id: number;
  index?: number;
  title?: string;
  updated_at?: string;
  created_at?: string;
}

export interface ExerciseTemplate {
  id: string;
  title?: string;
  type?: string;
  primary_muscle_group?: string;
  secondary_muscle_groups?: string[];
  is_custom?: boolean;
}

export interface ExerciseHistoryEntry {
  workout_id?: string;
  workout_title?: string;
  workout_start_time?: string;
  workout_end_time?: string;
  exercise_template_id?: string;
  weight_kg?: number | null;
  reps?: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
  rpe?: number | null;
  custom_metric?: number | null;
  set_type?: string;
}

export interface BodyMeasurement {
  date: string;
  weight_kg?: number | null;
  lean_mass_kg?: number | null;
  fat_percent?: number | null;
  neck_cm?: number | null;
  shoulder_cm?: number | null;
  chest_cm?: number | null;
  left_bicep_cm?: number | null;
  right_bicep_cm?: number | null;
  left_forearm_cm?: number | null;
  right_forearm_cm?: number | null;
  abdomen?: number | null;
  waist?: number | null;
  hips?: number | null;
  left_thigh?: number | null;
  right_thigh?: number | null;
  left_calf?: number | null;
  right_calf?: number | null;
}

export interface UserInfo {
  id?: string;
  name?: string;
  url?: string;
}

export type WorkoutEvent =
  | { type: "updated"; workout: Workout }
  | { type: "deleted"; id: string; deleted_at?: string };

/** Envelope returned by every Hevy list endpoint. */
export interface HevyPage<TKey extends string, TItem> {
  page: number;
  page_count: number;
  items: TItem[];
  key: TKey;
}

/** Normalized pagination metadata attached to every list tool response. */
export interface PaginationMeta {
  page: number;
  page_count: number;
  count: number;
  has_more: boolean;
  next_page?: number;
}
