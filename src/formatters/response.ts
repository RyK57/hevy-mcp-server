/**
 * Shared response construction: pagination metadata, character-limit
 * truncation, and the markdown primitives every formatter reuses.
 */

import { CHARACTER_LIMIT, KG_TO_LB } from "../constants.js";
import { describeError } from "../services/hevy-client.js";
import type { PaginationMeta } from "../types.js";

export const RESPONSE_FORMATS = ["markdown", "json"] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

/**
 * Shape returned by every tool handler.
 * The index signature is required to satisfy the SDK's `CallToolResult`.
 */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Builds pagination metadata from Hevy's page/page_count envelope.
 * Hevy pages are 1-indexed and it does not report a total item count.
 */
export const buildPagination = (
  page: number,
  pageCount: number,
  count: number,
): PaginationMeta => {
  const hasMore = page < pageCount;
  return {
    page,
    page_count: pageCount,
    count,
    has_more: hasMore,
    ...(hasMore ? { next_page: page + 1 } : {}),
  };
};

/** Renders a kilogram value with its pound equivalent, since Hevy stores kg only. */
export const formatWeight = (kg: number | null | undefined): string => {
  if (kg === null || kg === undefined) return "—";
  return `${round(kg, 2)} kg (${round(kg * KG_TO_LB, 1)} lb)`;
};

export const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** Formats an ISO timestamp as a compact, readable UTC string. */
export const formatTimestamp = (iso: string | undefined): string => {
  if (!iso) return "unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC").replace(/Z$/, " UTC");
};

/** Duration between two ISO timestamps, rendered as e.g. "1h 12m". */
export const formatDuration = (start?: string, end?: string): string => {
  if (!start || !end) return "unknown";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
};

/** Appends a "showing page X of Y" footer with the follow-up call to make. */
export const paginationFooter = (meta: PaginationMeta, toolName: string): string =>
  meta.has_more
    ? `\n_Page ${meta.page} of ${meta.page_count}. Call ${toolName} with page=${meta.next_page} for more._`
    : `\n_Page ${meta.page} of ${meta.page_count} — end of results._`;

/**
 * Truncates oversized markdown so a single tool call cannot blow out the
 * agent's context, and says explicitly how to get the rest.
 */
const truncateText = (text: string, remedy: string): string => {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    `${text.slice(0, CHARACTER_LIMIT)}\n\n` +
    `_[Truncated at ${CHARACTER_LIMIT} characters. ${remedy}]_`
  );
};

/**
 * Assembles the final tool result in the requested format.
 * `structured` is always attached so clients that consume structuredContent
 * get the full, untruncated data regardless of the text rendering.
 */
export const toolResult = (
  format: ResponseFormat,
  structured: Record<string, unknown>,
  markdown: () => string,
  remedy = "Reduce page_size or narrow your filters to see the rest.",
): ToolResult => {
  const text =
    format === "json"
      ? truncateText(JSON.stringify(structured, null, 2), remedy)
      : truncateText(markdown(), remedy);

  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
};

/** Wraps a tool handler so every thrown error becomes actionable agent-facing text. */
export const withErrorHandling = <TArgs>(
  handler: (args: TArgs) => Promise<ToolResult>,
): ((args: TArgs) => Promise<ToolResult>) => {
  return async (args: TArgs): Promise<ToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      return {
        content: [{ type: "text", text: describeError(error) }],
        isError: true,
      };
    }
  };
};

/** Standard empty-result response with guidance on what to try instead. */
export const emptyResult = (message: string, structured: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: message }],
  structuredContent: structured,
});
