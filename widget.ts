import { closeSync, openSync, readSync, statSync } from "node:fs";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RunMetadata, RunState } from "./shared.ts";

/** What the parent widget shows for one child, read from its session file. */
export interface RunActivity {
	outputTokens: number;
	cost: number;
	/** The last tool call, as `name detail`. */
	lastTool?: string;
	/** First line of the last assistant text. */
	lastText?: string;
}

interface ActivityCache extends RunActivity {
	file: string;
	offset: number;
	remainder: string;
}

const READ_CHUNK = 1 << 20;

function toolSummary(name: string, args: unknown): string {
	const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
	const detail =
		[record.command, record.path, record.file_path, record.pattern, record.query, record.url, record.action].find(
			(value): value is string => typeof value === "string" && value.trim() !== "",
		) ?? "";
	return `${name} ${detail.split("\n")[0]}`.trim();
}

function applyEntry(cache: ActivityCache, line: string): void {
	let entry: { type?: string; message?: { role?: string; content?: unknown; usage?: Record<string, unknown> } };
	try {
		entry = JSON.parse(line);
	} catch {
		return;
	}
	const message = entry.message;
	if (entry.type !== "message" || message?.role !== "assistant") return;
	const usage = message.usage ?? {};
	if (typeof usage.output === "number") cache.outputTokens += usage.output;
	const cost = usage.cost as { total?: unknown } | undefined;
	if (typeof cost?.total === "number") cache.cost += cost.total;
	if (!Array.isArray(message.content)) return;
	for (const part of message.content as Array<Record<string, unknown>>) {
		if (part?.type === "toolCall" && typeof part.name === "string") {
			cache.lastTool = toolSummary(part.name, part.arguments);
			cache.lastText = undefined;
		} else if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
			cache.lastText = part.text.trim().split("\n")[0];
		}
	}
}

/** Reads each child's session file incrementally: only bytes appended since the last call. */
export class ActivityTracker {
	private readonly caches = new Map<string, ActivityCache>();

	read(run: RunMetadata): RunActivity {
		let cache = this.caches.get(run.handle);
		if (!cache || cache.file !== run.sessionFile) {
			cache = { file: run.sessionFile, offset: 0, remainder: "", outputTokens: 0, cost: 0 };
			this.caches.set(run.handle, cache);
		}
		let size: number;
		try {
			size = statSync(cache.file).size;
		} catch {
			return cache;
		}
		if (size < cache.offset) {
			Object.assign(cache, { offset: 0, remainder: "", outputTokens: 0, cost: 0, lastTool: undefined, lastText: undefined });
		}
		if (size === cache.offset) return cache;
		const fd = openSync(cache.file, "r");
		try {
			while (cache.offset < size) {
				const buffer = Buffer.alloc(Math.min(READ_CHUNK, size - cache.offset));
				const read = readSync(fd, buffer, 0, buffer.length, cache.offset);
				if (read <= 0) break;
				cache.offset += read;
				const lines = (cache.remainder + buffer.toString("utf8", 0, read)).split("\n");
				cache.remainder = lines.pop() ?? "";
				for (const line of lines) if (line.trim()) applyEntry(cache, line);
			}
		} finally {
			closeSync(fd);
		}
		return cache;
	}

	forget(activeHandles: Set<string>): void {
		for (const handle of this.caches.keys()) if (!activeHandles.has(handle)) this.caches.delete(handle);
	}
}

export interface WidgetRow {
	run: RunMetadata;
	state: RunState;
	activity: RunActivity;
}

export interface WidgetTheme {
	fg(color: string, text: string): string;
}

export const MAX_ROWS = 6;
/** Wider rows put the totals too far from the names to read across. */
const MAX_WIDTH = 120;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ACTIVE: RunState[] = ["starting", "busy"];

export function formatCount(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(value);
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Left and right text on one line, the left side truncated to leave room for the right. */
function fit(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	if (rightWidth + 2 > width) return truncateToWidth(left, width);
	const clipped = truncateToWidth(left, width - rightWidth - 1);
	return clipped + " ".repeat(Math.max(1, width - visibleWidth(clipped) - rightWidth)) + right;
}

function counts(rows: WidgetRow[]): string[] {
	const tally = new Map<RunState, number>();
	for (const row of rows) tally.set(row.state, (tally.get(row.state) ?? 0) + 1);
	return (["busy", "starting", "idle", "error"] as RunState[])
		.filter((state) => tally.get(state))
		.map((state) => `${tally.get(state)} ${state}`);
}

/**
 * The parent's subagent widget: a summary line, then one row per child while any child
 * is working. Failed children come first, then working ones, each in spawn order; rows
 * past MAX_ROWS are counted.
 */
export function renderWidget(rows: WidgetRow[], width: number, theme: WidgetTheme, now = Date.now()): string[] {
	if (rows.length === 0 || width <= 0) return [];
	width = Math.min(width, MAX_WIDTH);
	const outputTokens = rows.reduce((sum, row) => sum + row.activity.outputTokens, 0);
	const cost = rows.reduce((sum, row) => sum + row.activity.cost, 0);
	const totals = theme.fg("dim", `↓${formatCount(outputTokens)} $${cost.toFixed(2)}`);
	const active = rows.some((row) => ACTIVE.includes(row.state));
	const header =
		theme.fg("accent", "subagents") +
		theme.fg("dim", " · ") +
		counts(rows).join(theme.fg("dim", " · ")) +
		(active ? "" : theme.fg("dim", " · ← or /subagent to attach"));
	const lines = [fit(header, totals, width)];
	if (!active) return lines;

	// Failures first so they are never hidden in the overflow count, then working children.
	const rank = (row: WidgetRow): number => (row.state === "error" ? 0 : ACTIVE.includes(row.state) ? 1 : 2);
	const ordered = [...rows].sort((a, b) => rank(a) - rank(b) || a.run.createdAt.localeCompare(b.run.createdAt));
	const shown = ordered.length > MAX_ROWS + 1 ? ordered.slice(0, MAX_ROWS) : ordered;
	const nameWidth = Math.min(24, Math.max(...shown.map((row) => visibleWidth(row.run.name ?? row.run.handle))));
	const frame = SPINNER[Math.floor(now / 200) % SPINNER.length];

	for (const { run, state, activity } of shown) {
		const since = run.stateSince ? Date.parse(run.stateSince) : Number.NaN;
		const elapsed = Number.isNaN(since) ? "" : formatDuration(now - since);
		const name = truncateToWidth(run.name ?? run.handle, nameWidth, "…", true);
		let icon: string;
		let time: string;
		let detail: string;
		if (state === "busy" || state === "starting") {
			icon = theme.fg("warning", state === "busy" ? frame : "◌");
			time = elapsed;
			detail = state === "starting" ? "starting" : (activity.lastTool ?? activity.lastText ?? run.task ?? "");
		} else if (state === "error") {
			icon = theme.fg("error", "✗");
			time = "";
			detail = run.error ?? "failed";
		} else {
			icon = theme.fg("success", "✓");
			time = elapsed ? `${elapsed} ago` : "";
			detail = activity.lastText ?? run.task ?? "";
		}
		const left = ` ${icon} ${theme.fg(state === "idle" ? "dim" : "text", name)}  ${theme.fg("dim", time.padEnd(9))}${theme.fg("muted", detail)}`;
		const right = theme.fg("dim", `↓${formatCount(activity.outputTokens)} $${activity.cost.toFixed(2)}`);
		lines.push(fit(left, right, width));
	}

	const hidden = ordered.slice(shown.length);
	if (hidden.length > 0) {
		lines.push(theme.fg("dim", truncateToWidth(` +${hidden.length} more: ${counts(hidden).join(", ")} · ← or /subagent to attach`, width)));
	} else {
		lines.push(theme.fg("dim", " ← or /subagent to attach"));
	}
	return lines;
}
