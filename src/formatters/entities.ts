/**
 * Markdown renderers for each Hevy entity.
 *
 * Kept separate from the tools so list/detail views of the same entity render
 * identically and nothing is duplicated between tools.
 */

import { MEASUREMENT_FIELDS } from "../constants.js";
import type {
  BodyMeasurement,
  ExerciseHistoryEntry,
  ExerciseTemplate,
  HevySet,
  Routine,
  RoutineExercise,
  RoutineFolder,
  RoutineSet,
  Workout,
  WorkoutEvent,
} from "../types.js";
import { formatDuration, formatTimestamp, formatWeight, round } from "./response.js";

/** One logged set, e.g. "3. 100 kg (220.5 lb) x 8 @RPE 8.5". */
export const formatSet = (set: HevySet, position: number): string => {
  const parts: string[] = [];

  if (set.weight_kg !== null && set.weight_kg !== undefined) parts.push(formatWeight(set.weight_kg));
  if (set.reps !== null && set.reps !== undefined) parts.push(`${set.reps} reps`);
  if (set.distance_meters !== null && set.distance_meters !== undefined) {
    parts.push(`${set.distance_meters} m`);
  }
  if (set.duration_seconds !== null && set.duration_seconds !== undefined) {
    parts.push(`${set.duration_seconds}s`);
  }
  if (set.custom_metric !== null && set.custom_metric !== undefined) {
    parts.push(`custom: ${set.custom_metric}`);
  }

  const detail = parts.length > 0 ? parts.join(" x ") : "no data logged";
  const type = set.type && set.type !== "normal" ? ` [${set.type}]` : "";
  const rpe = set.rpe !== null && set.rpe !== undefined ? ` @RPE ${set.rpe}` : "";

  return `  ${position}. ${detail}${type}${rpe}`;
};

/** A planned routine set, which may carry a rep range instead of fixed reps. */
export const formatRoutineSet = (set: RoutineSet, position: number): string => {
  const base = formatSet(set, position);
  const range = set.rep_range;
  if (range && (range.start !== null || range.end !== null)) {
    return `${base} (target ${range.start ?? "?"}-${range.end ?? "?"} reps)`;
  }
  return base;
};

const volumeOf = (sets: HevySet[] | undefined): number =>
  (sets ?? []).reduce(
    (total, set) => total + (set.weight_kg ?? 0) * (set.reps ?? 0),
    0,
  );

export const formatWorkout = (workout: Workout, detailed: boolean): string => {
  const lines: string[] = [];
  const exercises = workout.exercises ?? [];

  lines.push(`## ${workout.title ?? "Untitled workout"} (${workout.id})`);
  lines.push(
    `- **When**: ${formatTimestamp(workout.start_time)} · **Duration**: ${formatDuration(workout.start_time, workout.end_time)}`,
  );

  const totalSets = exercises.reduce((n, ex) => n + (ex.sets?.length ?? 0), 0);
  const totalVolume = exercises.reduce((n, ex) => n + volumeOf(ex.sets), 0);
  lines.push(
    `- **Volume**: ${exercises.length} exercises, ${totalSets} sets, ${round(totalVolume, 1)} kg total`,
  );

  if (workout.description) lines.push(`- **Notes**: ${workout.description}`);
  if (workout.routine_id) lines.push(`- **From routine**: ${workout.routine_id}`);

  if (!detailed) {
    const names = exercises.map((ex) => ex.title ?? "?").join(", ");
    if (names) lines.push(`- **Exercises**: ${names}`);
    return lines.join("\n");
  }

  for (const exercise of exercises) {
    lines.push("");
    const superset =
      exercise.supersets_id !== null && exercise.supersets_id !== undefined
        ? ` _(superset ${exercise.supersets_id})_`
        : "";
    lines.push(
      `### ${(exercise.index ?? 0) + 1}. ${exercise.title ?? "Unknown exercise"}${superset}`,
    );
    lines.push(`  _template id: ${exercise.exercise_template_id ?? "unknown"}_`);
    if (exercise.notes) lines.push(`  _note: ${exercise.notes}_`);
    (exercise.sets ?? []).forEach((set, i) => lines.push(formatSet(set, i + 1)));
  }

  return lines.join("\n");
};

const formatRoutineExercise = (exercise: RoutineExercise): string[] => {
  const lines: string[] = [];
  const superset =
    exercise.supersets_id !== null && exercise.supersets_id !== undefined
      ? ` _(superset ${exercise.supersets_id})_`
      : "";
  lines.push(`### ${(exercise.index ?? 0) + 1}. ${exercise.title ?? "Unknown exercise"}${superset}`);
  lines.push(`  _template id: ${exercise.exercise_template_id ?? "unknown"}_`);
  if (exercise.rest_seconds !== null && exercise.rest_seconds !== undefined) {
    lines.push(`  _rest: ${exercise.rest_seconds}s_`);
  }
  if (exercise.notes) lines.push(`  _note: ${exercise.notes}_`);
  (exercise.sets ?? []).forEach((set, i) => lines.push(formatRoutineSet(set, i + 1)));
  return lines;
};

export const formatRoutine = (routine: Routine, detailed: boolean): string => {
  const lines: string[] = [];
  const exercises = routine.exercises ?? [];

  lines.push(`## ${routine.title ?? "Untitled routine"} (${routine.id})`);
  lines.push(
    `- **Folder**: ${routine.folder_id ?? "My Routines (default)"} · **Exercises**: ${exercises.length}`,
  );
  lines.push(`- **Updated**: ${formatTimestamp(routine.updated_at)}`);
  if (routine.notes) lines.push(`- **Notes**: ${routine.notes}`);

  if (!detailed) {
    const names = exercises.map((ex) => ex.title ?? "?").join(", ");
    if (names) lines.push(`- **Exercises**: ${names}`);
    return lines.join("\n");
  }

  for (const exercise of exercises) {
    lines.push("");
    lines.push(...formatRoutineExercise(exercise));
  }

  return lines.join("\n");
};

export const formatRoutineFolder = (folder: RoutineFolder): string =>
  `- **${folder.title ?? "Untitled folder"}** (id: ${folder.id}, position: ${folder.index ?? "?"}) — updated ${formatTimestamp(folder.updated_at)}`;

export const formatExerciseTemplate = (template: ExerciseTemplate): string => {
  const secondary = template.secondary_muscle_groups ?? [];
  const custom = template.is_custom ? " _[custom]_" : "";
  return (
    `- **${template.title ?? "Untitled"}** (id: \`${template.id}\`)${custom}\n` +
    `  type: ${template.type ?? "?"} · primary: ${template.primary_muscle_group ?? "?"}` +
    (secondary.length > 0 ? ` · secondary: ${secondary.join(", ")}` : "")
  );
};

export const formatHistoryEntry = (entry: ExerciseHistoryEntry): string => {
  const metrics: string[] = [];
  if (entry.weight_kg !== null && entry.weight_kg !== undefined) {
    metrics.push(formatWeight(entry.weight_kg));
  }
  if (entry.reps !== null && entry.reps !== undefined) metrics.push(`${entry.reps} reps`);
  if (entry.distance_meters !== null && entry.distance_meters !== undefined) {
    metrics.push(`${entry.distance_meters} m`);
  }
  if (entry.duration_seconds !== null && entry.duration_seconds !== undefined) {
    metrics.push(`${entry.duration_seconds}s`);
  }
  const rpe = entry.rpe !== null && entry.rpe !== undefined ? ` @RPE ${entry.rpe}` : "";
  const type = entry.set_type && entry.set_type !== "normal" ? ` [${entry.set_type}]` : "";
  return `- ${formatTimestamp(entry.workout_start_time)} — ${metrics.join(" x ") || "no data"}${type}${rpe} _(${entry.workout_title ?? "workout"})_`;
};

export const formatBodyMeasurement = (measurement: BodyMeasurement): string => {
  const lines = [`## ${measurement.date}`];
  for (const field of MEASUREMENT_FIELDS) {
    const value = measurement[field];
    if (value === null || value === undefined) continue;
    if (field === "weight_kg" || field === "lean_mass_kg") {
      lines.push(`- **${field.replace(/_/g, " ")}**: ${formatWeight(value)}`);
    } else if (field === "fat_percent") {
      lines.push(`- **body fat**: ${value}%`);
    } else {
      lines.push(`- **${field.replace(/_/g, " ")}**: ${value} cm`);
    }
  }
  if (lines.length === 1) lines.push("- _no values recorded for this date_");
  return lines.join("\n");
};

export const formatWorkoutEvent = (event: WorkoutEvent): string => {
  if (event.type === "deleted") {
    return `- **deleted** — workout ${event.id} (at ${formatTimestamp(event.deleted_at)})`;
  }
  return `- **updated** — ${event.workout?.title ?? "Untitled"} (${event.workout?.id}) at ${formatTimestamp(event.workout?.updated_at)}`;
};
