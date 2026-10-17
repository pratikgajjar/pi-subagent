import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text, type TUI } from "@earendil-works/pi-tui";
import {
	assistantText,
	effectiveRunState,
	killRun,
	launchRun,
	listRuns,
	liveRunChecker,
	readLatestAssistant,
	readMetadata,
	removeRunDir,
	runDisplayName,
	runIsLive,
	runLocation,
	type RunMetadata,
	type RunState,
	runTarget,
	updateMetadata,
	waitForRunShutdown,
} from "./shared.ts";
import { ActivityTracker, formatDuration, renderWidget, type WidgetRow } from "./widget.ts";

/** Longest reply carried in a completion message; `subagent wait` prints the rest. */
const REPORT_CHARS = 1500;
/** Delay before a completion message, so a `subagent wait` that already printed the reply can claim it. */
const REPORT_DELAY_MS = 2000;
const LEFT_ARROW = new Set(["\x1b[D", "\x1bOD"]);

const isActive = (state: RunState): boolean => state === "busy" || state === "starting";

function stateIcon(state: RunState): string {
	return isActive(state) ? "●" : state === "idle" ? "✓" : state === "error" ? "✗" : "·";
}

/** Select a child of this session and switch to its window, or attach to its session outside tmux. */
export async function openPicker(ctx: ExtensionContext): Promise<void> {
	const isLive = liveRunChecker();
	const runs = listRuns(ctx.sessionManager.getSessionId())
		.map((run) => ({ run, state: effectiveRunState(run, isLive) }))
		.filter(({ state }) => state !== "exited");
	if (runs.length === 0) {
		ctx.ui.notify("No active subagents spawned by this session", "info");
		return;
	}

	const now = Date.now();
	const nameWidth = Math.min(24, Math.max(...runs.map(({ run }) => (run.name ?? run.handle).length)));
	const items: SelectItem[] = runs.map(({ run, state }) => {
		const since = run.stateSince ? Date.parse(run.stateSince) : Number.NaN;
		const elapsed = Number.isNaN(since) ? "" : ` ${formatDuration(now - since)}`;
		const where = runLocation(run).replace(/^Window: /, "");
		return {
			value: run.handle,
			label: `${stateIcon(state)} ${(run.name ?? run.handle).slice(0, nameWidth).padEnd(nameWidth)}  ${state}${elapsed}`,
			description: [where, `${run.model} ${run.thinking}`, run.task].filter(Boolean).join(" · "),
		};
	});
	let tui: TUI | undefined;
	const selected = await ctx.ui.custom<string | undefined>((customTui, theme, _keybindings, done) => {
		tui = customTui;
		const list = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(undefined);

		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Attach to subagent")), 1, 0));
		container.addChild(list);
		container.addChild(
			new Text(
				theme.fg("dim", `${keyHint("tui.select.confirm", "attach")}  ${keyHint("tui.select.cancel", "cancel")}`),
				1,
				0,
			),
		);
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				customTui.requestRender();
			},
		};
	});
	if (!selected || !tui) return;
	const run = runs.find(({ run: candidate }) => candidate.handle === selected)?.run;
	if (!run) return;
	const target = runTarget(run);
	if (!target) {
		ctx.ui.notify(`${run.handle} is not running`, "error");
		return;
	}

	const runTmux = (args: string[]) =>
		new Promise<number | null>((resolveExit) => {
			const child = spawn("tmux", args, { stdio: "inherit" });
			child.on("error", () => resolveExit(null));
			child.on("close", resolveExit);
		});

	if (process.env.TMUX) {
		// Switch the client to the session, then select the child's window in it.
		const exitCode = await runTmux(["switch-client", "-t", target, ";", "select-window", "-t", target]);
		if (exitCode !== 0) ctx.ui.notify(`Could not switch to ${run.handle}`, "error");
		return;
	}

	tui.stop();
	try {
		const exitCode = await runTmux(["select-window", "-t", target, ";", "attach-session", "-t", target]);
		if (exitCode !== 0) process.stderr.write(`Could not attach to ${run.handle}\n`);
	} finally {
		tui.start();
		tui.requestRender(true);
	}
}

/** The message a parent receives when one child finishes, fails, or exits. */
export function finishedReport(run: RunMetadata, state: RunState, activeMs: number): string {
	const head = `Subagent ${runDisplayName(run)}`;
	const took = formatDuration(activeMs);
	if (state === "error") return `${head} failed after ${took}: ${run.error ?? "unknown error"}\n${runLocation(run)}`;
	if (state === "exited") return `${head} exited before finishing.`;
	const message = readLatestAssistant(run.sessionFile);
	let reply = message ? assistantText(message) : "(no reply)";
	if (reply.length > REPORT_CHARS) {
		reply = `${reply.slice(0, REPORT_CHARS)}…\n(truncated; \`subagent wait ${run.handle}\` prints the whole reply)`;
	}
	return `${head} finished in ${took}:\n\n${reply}\n\n${runLocation(run)}. Stop it with \`subagent stop ${run.handle}\` once you have used the result.`;
}

/**
 * Parent-side behaviour: relaunch suspended children, show the widget, tell the parent when
 * a child finishes, open the picker with Left on an empty prompt, and suspend children on quit.
 */
export function registerParent(pi: ExtensionAPI): void {
	let context: ExtensionContext | undefined;
	let monitorTimer: ReturnType<typeof setInterval> | undefined;
	let startedAt = 0;
	let rows: WidgetRow[] = [];
	let widgetShown = false;
	let requestRender: (() => void) | undefined;
	let pickerOpen = false;
	let stopKeys: (() => void) | undefined;
	const tracker = new ActivityTracker();
	/** Last state seen per child, and since when, to notice a child that finished. */
	const seen = new Map<string, { state: RunState; since: number }>();
	const pending = new Map<string, { runDir: string; state: RunState; activeMs: number }>();
	let flushTimer: ReturnType<typeof setTimeout> | undefined;

	const flushReports = (): void => {
		flushTimer = undefined;
		const reports: string[] = [];
		for (const [handle, { runDir, state, activeMs }] of pending) {
			pending.delete(handle);
			const run = readMetadata(runDir);
			if (!run) continue; // stopped meanwhile
			const now = effectiveRunState(run);
			if (isActive(now)) continue; // prompted again meanwhile
			// `subagent wait` already handed this result to the parent.
			if (run.reportedAt && run.stateSince && run.reportedAt >= run.stateSince) continue;
			reports.push(finishedReport(run, now === state ? state : now, activeMs));
			updateMetadata(runDir, { reportedAt: new Date().toISOString() });
		}
		if (reports.length === 0) return;
		pi.sendMessage(
			{ customType: "subagent-result", content: reports.join("\n\n---\n\n"), display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	};

	const queueReport = (run: RunMetadata, state: RunState, activeMs: number): void => {
		pending.set(run.handle, { runDir: run.runDir, state, activeMs });
		flushTimer ??= setTimeout(flushReports, REPORT_DELAY_MS);
	};

	const showWidget = (ctx: ExtensionContext): void => {
		if (rows.length === 0) {
			if (widgetShown) ctx.ui.setWidget("subagents", undefined);
			widgetShown = false;
			return;
		}
		if (widgetShown) {
			requestRender?.();
			return;
		}
		widgetShown = true;
		ctx.ui.setWidget(
			"subagents",
			(tui, theme) => {
				requestRender = () => tui.requestRender();
				const spinner = setInterval(() => {
					if (rows.some((row) => isActive(row.state))) tui.requestRender();
				}, 200);
				spinner.unref();
				return {
					render: (width: number) => renderWidget(rows, width, theme),
					invalidate: () => {},
					dispose: () => {
						clearInterval(spinner);
						requestRender = undefined;
					},
				};
			},
			{ placement: "belowEditor" },
		);
	};

	// Once a second: read every child, report the ones that finished, refresh the widget.
	const monitor = (): void => {
		const ctx = context;
		if (!ctx) return;
		const isLive = liveRunChecker();
		const now = Date.now();
		const runs = listRuns(ctx.sessionManager.getSessionId()).map((run) => ({ run, state: effectiveRunState(run, isLive) }));
		for (const { run, state } of runs) {
			const previous = seen.get(run.handle);
			seen.set(run.handle, previous?.state === state ? previous : { state, since: now });
			const finished = (state === "idle" && run.hasStarted) || state === "error" || state === "exited";
			if (!finished) continue;
			if (previous && isActive(previous.state)) queueReport(run, state, now - previous.since);
			// A child spawned after this session started that finished between two reads.
			else if (!previous && Date.parse(run.createdAt) >= startedAt) queueReport(run, state, now - Date.parse(run.createdAt));
		}
		const handles = new Set(runs.map(({ run }) => run.handle));
		for (const handle of seen.keys()) if (!handles.has(handle)) seen.delete(handle);

		rows = runs
			.filter(({ state }) => state !== "exited")
			.map(({ run, state }) => ({ run, state, activity: tracker.read(run) }));
		tracker.forget(new Set(rows.map((row) => row.run.handle)));
		if (ctx.hasUI) showWidget(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		// Relaunch children that were suspended when this session was last quit or switched away from.
		for (const run of listRuns(ctx.sessionManager.getSessionId())) {
			if (!run.suspended || runIsLive(run)) continue;
			if (!existsSync(run.sessionFile)) {
				removeRunDir(run.runDir);
				continue;
			}
			const starting = updateMetadata(run.runDir, { state: "starting", error: undefined }) ?? run;
			try {
				launchRun(starting);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				updateMetadata(run.runDir, { state: "error", error: message });
				if (ctx.hasUI) ctx.ui.notify(`Could not resume subagent ${runDisplayName(run)}: ${message}`, "error");
			}
		}

		context = ctx;
		startedAt = Date.now();
		seen.clear();
		monitor();
		monitorTimer = setInterval(monitor, 1000);
		monitorTimer.unref();

		if (!ctx.hasUI) return;
		// Left on an empty prompt opens the picker while this session has children.
		stopKeys = ctx.ui.onTerminalInput((data) => {
			if (!LEFT_ARROW.has(data) || pickerOpen || rows.length === 0 || ctx.ui.getEditorText() !== "") return undefined;
			pickerOpen = true;
			void openPicker(ctx).finally(() => {
				pickerOpen = false;
			});
			return { consume: true };
		});
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (monitorTimer) clearInterval(monitorTimer);
		if (flushTimer) clearTimeout(flushTimer);
		monitorTimer = undefined;
		flushTimer = undefined;
		pending.clear();
		stopKeys?.();
		stopKeys = undefined;
		context = undefined;
		widgetShown = false;
		ctx.ui.setWidget("subagents", undefined);
		if (event.reason === "reload") return;
		// Suspend running children: stop the process but keep transcript and metadata so resuming this
		// session relaunches them. Children that already exited on their own are discarded.
		for (const run of listRuns(ctx.sessionManager.getSessionId())) {
			if (!runIsLive(run)) {
				if (!run.suspended) removeRunDir(run.runDir);
				continue;
			}
			updateMetadata(run.runDir, { suspended: true });
			killRun(run);
			await waitForRunShutdown(run.runDir);
		}
	});
}
