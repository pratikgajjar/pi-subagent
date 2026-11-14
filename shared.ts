import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type RunState = "starting" | "busy" | "idle" | "exited" | "error";

export interface RunMetadata {
	version: 1;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	childSessionId?: string;
	/** PID published by the child; turn-end events are not process exits. */
	pid?: number;
	/** Transcript leaf before the logical turn, including automatic continuations. */
	turnStartId?: string | null;
	/** The child's own tmux session, or in window mode the session that hosts its window. */
	tmuxSession: string;
	/** "window": the child runs in a window of the parent's tmux session, marked with `@pi-subagent`. */
	tmuxMode?: "window";
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tools, isolation) reused when the run is relaunched. */
	launchArgs?: string[];
	/** Set by the parent when it stops the child on quit or session switch; the child is relaunched on resume. */
	suspended?: boolean;
	state: RunState;
	/** When `state` last changed; `updateMetadata` keeps it current. */
	stateSince?: string;
	/** One line that says what the child was asked to do. */
	task?: string;
	/** When the parent last received the child's result, from `subagent wait` or a completion message. */
	reportedAt?: string;
	hasStarted: boolean;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface InboxMessage {
	message: string;
	delivery: "auto" | "followUp";
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
	customType?: string;
	data?: unknown;
	name?: string;
}

interface AssistantMessage {
	role: "assistant";
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

interface AssistantEntry extends SessionEntry {
	type: "message";
	message: AssistantMessage;
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getRunsDir(): string {
	return join(getAgentDir(), "subagents");
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json");
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
}

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

export function runDisplayName(metadata: RunMetadata): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(metadataPath(runDir), "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const metadata = value as Partial<RunMetadata>;
		if (
			metadata.version !== 1 ||
			typeof metadata.handle !== "string" ||
			(metadata.name !== undefined && !isValidRunName(metadata.name)) ||
			typeof metadata.tmuxSession !== "string" ||
			typeof metadata.sessionFile !== "string" ||
			typeof metadata.runDir !== "string"
		) {
			return undefined;
		}
		return metadata as RunMetadata;
	} catch {
		return undefined;
	}
}

export function writeMetadata(metadata: RunMetadata): void {
	mkdirSync(dirname(metadataPath(metadata.runDir)), { recursive: true, mode: 0o700 });
	const target = metadataPath(metadata.runDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

export function updateMetadata(runDir: string, patch: Partial<RunMetadata>): RunMetadata | undefined {
	const current = readMetadata(runDir);
	if (!current) return undefined;
	const now = new Date().toISOString();
	const next: RunMetadata = {
		...current,
		...patch,
		version: 1,
		handle: current.handle,
		runDir: current.runDir,
		updatedAt: now,
	};
	if (patch.state && patch.state !== current.state) next.stateSince = now;
	writeMetadata(next);
	return next;
}

export async function waitForRunShutdown(runDir: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const metadata = readMetadata(runDir);
		if (!metadata || metadata.state === "exited") return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

/** Archive before every cleanup, including failed launches and children that exited on their own. */
export function removeRunDir(runDir: string): string | undefined {
	const sessionFile = join(runDir, "session.jsonl");
	let archived: string | undefined;
	try {
		let content: string;
		try {
			content = readFileSync(sessionFile, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			content = "";
		}
		// Spawn creates an empty file before Pi starts. There is no transcript to keep yet.
		if (content.length > 0) {
			const header = JSON.parse(content.split("\n", 1)[0]);
			if (
				header?.type !== "session" ||
				typeof header.id !== "string" ||
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(header.id) ||
				typeof header.cwd !== "string" || !isAbsolute(header.cwd) ||
				typeof header.timestamp !== "string" ||
				new Date(header.timestamp).toISOString() !== header.timestamp
			) {
				throw new Error("Invalid session header");
			}
			// Match Pi core/session-manager: getDefaultSessionDirPath and newSession.
			// The session header already contains Pi's resolved, absolute cwd.
			const slug = `--${resolve(header.cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const sessionDir = join(getAgentDir(), "sessions", slug);
			const timestamp = header.timestamp.replace(/[:.]/g, "-");
			archived = join(sessionDir, `${timestamp}_${header.id}.jsonl`);
			mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
			// Copy then unlink also works across filesystems. EXCL never replaces an existing session.
			copyFileSync(sessionFile, archived, constants.COPYFILE_EXCL);
			unlinkSync(sessionFile);
		}
	} catch (error) {
		throw new Error(`Could not archive transcript; kept run directory ${runDir}: ${error instanceof Error ? error.message : String(error)}`);
	}
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	return archived;
}

export function tmuxSessionExists(session: string): boolean {
	return spawnSync("tmux", ["has-session", "-t", session], { stdio: "ignore" }).status === 0;
}

/** Window option that marks a child's window with its handle. */
export const WINDOW_MARK = "@pi-subagent";

function tmuxOutput(args: string[]): string | undefined {
	const result = spawnSync("tmux", args, { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * The tmux session that hosts a child's window: the calling pane's session when the caller runs inside tmux,
 * else PI_SUBAGENT_TMUX_SESSION, else the session tmux treats as current (the most recently used client's).
 * Callers outside tmux (daemons, relays) then still put children beside the user's windows, not in loose sessions.
 */
function hostSession(): { id: string; name: string } | undefined {
	const pane = process.env.TMUX ? process.env.TMUX_PANE : undefined;
	const named = process.env.PI_SUBAGENT_TMUX_SESSION;
	const target = pane ? ["-t", pane] : named ? ["-t", `=${named}:`] : [];
	const [id, name] = (tmuxOutput(["display-message", "-p", ...target, "#{session_id}\t#{session_name}"]) ?? "").split("\t");
	return id && name && !name.startsWith("pi-subagent-") ? { id, name } : undefined;
}

/** The child's name as a tmux window name: `:` and `.` separate tmux targets, so they become `-`. */
export function windowName(metadata: RunMetadata): string {
	const name = (metadata.name ?? "").replace(/[\s:.]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
	return name || `sub-${metadata.handle}`;
}

/**
 * The window id of a window-mode run. Found by its mark, not a stored id: tmux reuses
 * window ids after a server restart, and a stale id could name one of the user's windows.
 */
export function runWindow(metadata: RunMetadata): string | undefined {
	if (metadata.tmuxMode !== "window") return undefined;
	const windows = tmuxOutput(["list-windows", "-a", "-F", `#{window_id}\t#{${WINDOW_MARK}}`]) ?? "";
	for (const line of windows.split("\n")) {
		const [id, handle] = line.split("\t");
		if (id && handle === metadata.handle) return id;
	}
	return undefined;
}

function pidIsLive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// Permission errors do not prove that a process exited.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

export function runIsLive(metadata: RunMetadata): boolean {
	return metadata.pid ? pidIsLive(metadata.pid) : liveRunChecker()(metadata);
}

/** Check PIDs, with one pane listing for older children that did not publish a PID. */
export function liveRunChecker(): (metadata: RunMetadata) => boolean {
	const panes = tmuxOutput(["list-panes", "-a", "-F", `#{session_name}\t#{${WINDOW_MARK}}\t#{pane_dead}`]);
	const marked = new Set<string>();
	const sessions = new Set<string>();
	for (const line of (panes ?? "").split("\n")) {
		const [session, handle, dead] = line.split("\t");
		if (dead !== "0") continue;
		sessions.add(session);
		if (handle) marked.add(handle);
	}
	return (metadata) => metadata.pid ? pidIsLive(metadata.pid)
		// A failed tmux query alone is not proof of an exit.
		: panes === undefined || (metadata.tmuxMode === "window" ? marked.has(metadata.handle) : sessions.has(metadata.tmuxSession));
}

/** The tmux target that shows the child: its window id or its own session. */
export function runTarget(metadata: RunMetadata): string | undefined {
	return metadata.tmuxMode === "window" ? runWindow(metadata) : metadata.tmuxSession;
}

/** Close the child's window or session. Never touches a window without the run's mark. */
export function killRun(metadata: RunMetadata): void {
	if (metadata.tmuxMode !== "window") {
		spawnSync("tmux", ["kill-session", "-t", metadata.tmuxSession], { stdio: "ignore" });
		return;
	}
	const window = runWindow(metadata);
	if (window) spawnSync("tmux", ["kill-window", "-t", window], { stdio: "ignore" });
}

export function renameRunWindow(metadata: RunMetadata): void {
	const window = runWindow(metadata);
	if (window) spawnSync("tmux", ["rename-window", "-t", window, windowName(metadata)], { stdio: "ignore" });
}

/** One line that tells the user where the child runs. */
export function runLocation(metadata: RunMetadata): string {
	return metadata.tmuxMode === "window"
		? `Window: ${metadata.tmuxSession}:${windowName(metadata)}`
		: `Attach: tmux attach -t ${metadata.tmuxSession}`;
}

/**
 * Start the child pi process for a run. Inside tmux it opens a detached window in the
 * caller's session; outside tmux it opens its own session. The placement is written to
 * the metadata before the child starts. `initialArgs` are only passed on first spawn.
 */
export function launchRun(metadata: RunMetadata, initialArgs: string[] = []): RunMetadata {
	// A resumed child must not inherit the old process identity.
	metadata = updateMetadata(metadata.runDir, { pid: undefined }) ?? metadata;
	let launcher = "pi";
	const testLauncher = join(metadata.cwd, "pi-test.sh");
	try {
		accessSync(testLauncher, constants.X_OK);
		launcher = testLauncher;
	} catch {
		// Use the installed pi executable.
	}

	const command = [
		"env",
		`PI_SUBAGENT_RUN_DIR=${metadata.runDir}`,
		launcher,
		"--session",
		metadata.sessionFile,
		"--provider",
		metadata.provider,
		"--model",
		metadata.model,
		"--thinking",
		metadata.thinking,
		...(metadata.launchArgs ?? []),
		...initialArgs,
	];

	const host = hostSession();
	if (host) {
		const placed = updateMetadata(metadata.runDir, { tmuxMode: "window", tmuxSession: host.name }) ?? {
			...metadata,
			tmuxMode: "window",
			tmuxSession: host.name,
		};
		const result = spawnSync(
			"tmux",
			["new-window", "-d", "-P", "-F", "#{window_id}", "-t", `${host.id}:`, "-n", windowName(placed), "-c", placed.cwd, "--", ...command],
			{ encoding: "utf8" },
		);
		const window = result.stdout?.trim();
		if (result.status !== 0 || !window) throw new Error(result.stderr.trim() || "Failed to create tmux window");
		if (spawnSync("tmux", ["set-option", "-w", "-t", window, WINDOW_MARK, placed.handle], { stdio: "ignore" }).status !== 0) {
			spawnSync("tmux", ["kill-window", "-t", window], { stdio: "ignore" });
			throw new Error("Failed to mark the subagent window");
		}
		return placed;
	}

	const tmuxSession = `pi-subagent-${metadata.handle}`;
	const placed = updateMetadata(metadata.runDir, { tmuxMode: undefined, tmuxSession }) ?? {
		...metadata,
		tmuxMode: undefined,
		tmuxSession,
	};
	const result = spawnSync(
		"tmux",
		["new-session", "-d", "-s", tmuxSession, "-x", "120", "-y", "40", "-c", placed.cwd, "--", ...command],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(result.stderr.trim() || "Failed to create tmux session");
	return placed;
}

export function effectiveRunState(
	metadata: RunMetadata,
	isLive: (metadata: RunMetadata) => boolean = runIsLive,
): RunState {
	if (metadata.state === "error") return "error";
	if (!isLive(metadata)) return "exited";
	// Never trust a lifecycle notification over the actual process/pane.
	if (metadata.state === "exited") return "busy";
	if (metadata.state === "idle" && hasInboxMessages(metadata.runDir)) return "busy";
	return metadata.state;
}

export function hasInboxMessages(runDir: string): boolean {
	try {
		return readdirSync(inboxDir(runDir)).some((file) => file.endsWith(".json"));
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	const root = getRunsDir();
	if (!existsSync(root)) return [];
	const runs: RunMetadata[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metadata = readMetadata(join(root, entry.name));
		if (!metadata) continue;
		if (parentSessionId && metadata.parentSessionId !== parentSessionId) continue;
		runs.push(metadata);
	}
	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.type === "string" &&
		typeof entry.id === "string" &&
		(entry.parentId === null || typeof entry.parentId === "string")
	);
}

function activeBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);
	while (current && !seen.has(current.id)) {
		branch.push(current);
		seen.add(current.id);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return branch.reverse();
}

function isAssistantEntry(entry: SessionEntry): entry is AssistantEntry {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return false;
	return (entry.message as Record<string, unknown>).role === "assistant";
}

function readBranch(sessionFile: string): SessionEntry[] {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return [];
	}
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch {
			// The final JSONL record may still be in the process of being appended.
		}
	}
	return activeBranch(entries);
}

export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	return readBranch(sessionFile).findLast(isAssistantEntry)?.message;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

/** Read only this logical turn on the active branch, never an earlier result. */
export function readTurnResult(run: RunMetadata, parentName?: string): { message?: AssistantMessage; reportedOverIntercomAt?: string } {
	const branch = readBranch(run.sessionFile);
	const start = run.turnStartId === undefined
		// Older children have no saved boundary. Treat injected messages as new input too.
		? branch.findLastIndex((entry) => entry.type === "custom_message" || (entry.type === "message" && record(entry.message).role === "user"))
		: run.turnStartId === null ? -1 : branch.findIndex((entry) => entry.id === run.turnStartId);
	const turn = branch.slice(start + 1);
	const message = turn.findLast(isAssistantEntry)?.message;
	// An unknown boundary, failed/aborted response or tool-use tail must not hide information.
	if ((run.turnStartId !== null && start < 0) || (message?.stopReason && message.stopReason !== "stop")) return { message };

	const calls = new Set<string>();
	const sentIds = new Set<string>();
	for (const entry of turn) {
		const msg = record(entry.message);
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				const call = record(part);
				const args = record(call.arguments);
				if (call.type === "toolCall" && call.name === "intercom" && (args.action === "send" || args.action === "reply") && typeof call.id === "string") calls.add(call.id);
			}
		}
		const details = record(msg.details);
		if (msg.role === "toolResult" && calls.has(String(msg.toolCallId)) && !msg.isError && details.delivered === true && typeof details.messageId === "string") sentIds.add(details.messageId);
		// Nested calls (e.g. codemode) have no standalone toolResult in the transcript.
		const data = record(entry.data);
		if (entry.type === "custom" && entry.customType === "subagent_intercom_report" && typeof data.messageId === "string") sentIds.add(data.messageId);
	}
	const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
	const final = normalize(message ? assistantText(message, "") : "");
	let parentAlias = parentName;
	for (const entry of turn.toReversed()) {
		if (entry.type !== "custom" || entry.customType !== "intercom_sent") continue;
		const data = record(entry.data);
		if (!sentIds.has(String(data.messageId)) || typeof data.to !== "string" || !run.parentSessionId) continue;
		const byId = data.to.length >= 8 && run.parentSessionId.startsWith(data.to);
		if (!byId && parentAlias === undefined && run.parentSessionFile) {
			parentAlias = readBranch(run.parentSessionFile).findLast((item) => item.type === "session_info")?.name ?? "";
		}
		if (!byId && (!parentAlias || data.to !== parentAlias)) continue;
		const text = record(data.message).text;
		if (typeof text !== "string" || typeof data.timestamp !== "number") continue;
		const sent = normalize(text);
		const date = new Date(data.timestamp);
		if (!sent || !Number.isFinite(date.getTime())) continue;
		// Mechanical only: empty, contained, or <=80 chars AND <=20% of the sent text.
		if (!final || sent.includes(final) || (final.length <= 80 && final.length <= sent.length / 5)) {
			return { message, reportedOverIntercomAt: date.toISOString() };
		}
	}
	return { message };
}

export function assistantText(message: AssistantMessage, empty = "(no response text)"): string {
	if (!Array.isArray(message.content)) return message.errorMessage ?? empty;
	const parts: string[] = [];
	for (const item of message.content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim() || message.errorMessage || empty;
}
