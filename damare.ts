/**
 * Damare - quiet tool display mode
 *
 * This extension overrides built-in tools to provide custom rendering:
 * - Collapsed mode: Only shows the tool call (command/path), no output
 * - Expanded mode: Shows full output like the built-in renderers
 *
 * This demonstrates how a "minimal mode" could work, where ctrl+o cycles through:
 * - Standard: Shows truncated output (current default)
 * - Expanded: Shows full output (current expanded)
 * - Minimal: Shows only tool call, no output (this extension's collapsed mode)
 *
 * Usage:
 *   pi -e ./damare.ts
 *
 * Then use ctrl+o to toggle between minimal (collapsed) and full (expanded) views.
 */

import { getAgentDir, InteractiveMode, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { homedir } from "os";

/**
 * Shorten a path by replacing home directory with ~
 */
function shortenPath(path: string): string {
	const home = homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

// Cache for built-in tools by cwd
const toolCache = new Map<string, ReturnType<typeof createBuiltInTools>>();

function createBuiltInTools(cwd: string) {
	return {
		bash: createBashTool(cwd),
		read: createReadTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		find: createFindTool(cwd),
		grep: createGrepTool(cwd),
		ls: createLsTool(cwd),
	};
}

function getBuiltInTools(cwd: string) {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = createBuiltInTools(cwd);
		toolCache.set(cwd, tools);
	}
	return tools;
}

type ToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];

const QUIET_BG_TOOLS = new Set(["bash", "bg_list", "bg_output", "bg_stop"]);
// Damare owns bash rendering itself (see export default below), so the
// pi-bg-tasks bash definition is stashed here instead of being re-registered
// quietly like bg_list/bg_output/bg_stop.
let capturedBgBash: ToolDefinition | undefined;
const PI_PACKAGE_NODE_MODULES = join(getAgentDir(), "npm", "node_modules");

type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
type WorkflowScriptFormatter = (source: string) => Promise<string>;

let workflowScriptFormatter: Promise<WorkflowScriptFormatter> | undefined;

/**
 * Resolve an installed package entry that may ship as either TypeScript source
 * or compiled JavaScript depending on version. Selection is filesystem-based
 * rather than error-code-based because the extension is transpiled to CJS by
 * pi's jiti loader, where a missing ESM module surfaces as `MODULE_NOT_FOUND`,
 * not `ERR_MODULE_NOT_FOUND`.
 */
async function importInstalledModule(extensionPath: string): Promise<{ default?: unknown }> {
	const alternate = extensionPath.endsWith(".ts")
		? extensionPath.replace(/\.ts$/, ".js")
		: extensionPath.endsWith(".js")
			? extensionPath.replace(/\.js$/, ".ts")
			: undefined;
	const candidates = alternate ? [extensionPath, alternate] : [extensionPath];

	let lastError: unknown;
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		try {
			return await import(pathToFileURL(candidate).href);
		} catch (error) {
			lastError = error;
		}
	}
	if (lastError) throw lastError;
	throw new Error(`Installed extension module not found: ${extensionPath}`);
}

/**
 * Load a currently installed Pi package at factory time. Keeping this out of
 * the static import graph means the package manager can replace a package
 * before this extension loads it, and avoids a machine-specific home path.
 */
async function loadInstalledExtension(packageName: string, relativePath: string): Promise<ExtensionFactory> {
	const extensionPath = join(PI_PACKAGE_NODE_MODULES, packageName, relativePath);
	const module = await importInstalledModule(extensionPath);
	if (typeof module.default !== "function") {
		throw new Error(`Installed package extension has no default factory: ${packageName}`);
	}
	return module.default as ExtensionFactory;
}

/**
 * Prettier v3 formatting is asynchronous. Load Pi's managed copy and its
 * JavaScript parser plugins explicitly before a tool result is rendered.
 */
async function loadWorkflowScriptFormatter(): Promise<WorkflowScriptFormatter> {
	const prettierPath = join(PI_PACKAGE_NODE_MODULES, "prettier", "index.mjs");
	const babelPluginPath = join(PI_PACKAGE_NODE_MODULES, "prettier", "plugins", "babel.mjs");
	const estreePluginPath = join(PI_PACKAGE_NODE_MODULES, "prettier", "plugins", "estree.mjs");
	const [prettier, babelPlugin, estreePlugin] = await Promise.all([
		import(pathToFileURL(prettierPath).href),
		import(pathToFileURL(babelPluginPath).href),
		import(pathToFileURL(estreePluginPath).href),
	]);
	if (typeof prettier.format !== "function") {
		throw new Error("Pi-managed Prettier has no format function");
	}
	return (source) => prettier.format(source, { parser: "babel", plugins: [babelPlugin, estreePlugin] });
}

async function formatWorkflowScript(source: string): Promise<string> {
	try {
		workflowScriptFormatter ??= loadWorkflowScriptFormatter();
		return await (await workflowScriptFormatter)(source);
	} catch {
		return source;
	}
}

async function registerQuietBackgroundTasks(pi: ExtensionAPI): Promise<void> {
	const captured = new Map<string, ToolDefinition>();
	const forwardingPi = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (definition: ToolDefinition) => {
					if (QUIET_BG_TOOLS.has(definition.name)) {
						captured.set(definition.name, definition);
						return;
					}
					pi.registerTool(definition);
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as ExtensionAPI;

	const bgTasksExtension = await loadInstalledExtension("pi-bg-tasks", "extensions/bg-tasks/index.ts");
	await bgTasksExtension(forwardingPi);

	// Keep background completion messages in the agent context, but hide their
	// transcript rendering in Damare's quiet mode.
	pi.registerMessageRenderer("bg-task-notification", () => ({
		render: () => [],
		invalidate: () => {},
	}));

	capturedBgBash = captured.get("bash");
	if (!capturedBgBash) {
		throw new Error("Expected background-task tool was not captured: bash");
	}
	for (const name of QUIET_BG_TOOLS) {
		if (name === "bash") continue;
		const definition = captured.get(name);
		if (!definition) {
			throw new Error(`Expected background-task tool was not captured: ${name}`);
		}
		pi.registerTool({
			...definition,
			renderResult() {
				return new Text("", 0, 0);
			},
		});
	}
}

const QUIET_SUBAGENT_TOOLS = new Set(["subagent", "subagent_wait", "subagent_supervisor"]);

type SubagentCall = { action?: string; task?: string; message?: string; workflowScript?: string };

type SubagentChildResult = { index?: unknown; task?: unknown; finalOutput?: unknown };

/**
 * Preserve the user's Ctrl-K state while the installed subagent executor runs.
 * Its only UI mutation is a forced collapse; every other UI member is forwarded.
 */
function withoutForcedSubagentCollapse(ctx: any): any {
	if (!ctx?.ui) return ctx;

	const ui = new Proxy(ctx.ui, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (property === "setToolsExpanded" && typeof value === "function") {
				return (expanded: unknown, ...args: unknown[]) =>
					expanded === false ? undefined : value.apply(target, [expanded, ...args]);
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	return new Proxy(ctx, {
		get(target, property, receiver) {
			return property === "ui" ? ui : Reflect.get(target, property, receiver);
		},
	});
}

function renderRawSubagentDetails(
	call: SubagentCall | undefined,
	formattedWorkflowScript: string | undefined,
	result: any,
	theme: any,
): Text {
	const lines: string[] = [];
	if (call?.action === "steer") lines.push(`requested_message: ${call.message ?? ""}`);
	else if (!call?.action && call?.task !== undefined) lines.push(`task: ${call.task}`);
	if (typeof call?.workflowScript === "string" && call.workflowScript.length > 0) {
		const script = formattedWorkflowScript ?? call.workflowScript;
		lines.push(`workflowScript:\n${script.split("\n").map((line) => `  ${line}`).join("\n")}`);
	}

	const children = Array.isArray(result?.details?.results) ? result.details.results : [];
	const orderedChildren = children
		.map((child: unknown, position: number) => ({ child, position }))
		.filter((entry): entry is { child: SubagentChildResult; position: number } =>
			typeof entry.child === "object" && entry.child !== null,
		)
		.sort((left, right) => {
			const leftIndex = typeof left.child.index === "number" && Number.isFinite(left.child.index) ? left.child.index : undefined;
			const rightIndex = typeof right.child.index === "number" && Number.isFinite(right.child.index) ? right.child.index : undefined;
			if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex || left.position - right.position;
			if (leftIndex !== undefined) return -1;
			if (rightIndex !== undefined) return 1;
			return left.position - right.position;
		});
	for (const { child } of orderedChildren) {
		if (typeof child.task === "string") lines.push(`task: ${child.task}`);
		if (typeof child.finalOutput === "string") lines.push(child.finalOutput);
	}
	return new Text(lines.length ? `\n${lines.map((line) => theme.fg("toolOutput", line)).join("\n")}` : "", 0, 0);
}

function getMessageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	return (message?.content ?? [])
		.filter((entry: any) => entry.type === "text")
		.map((entry: any) => entry.text)
		.join("\n");
}

function getSubagentNotificationOutput(message: any): string {
	const details = message?.details;
	if (typeof details?.resultPreview === "string") return details.resultPreview.trim();

	const lines = getMessageText(message).split("\n");
	const header = lines[0] ?? "";
	const isSingleCompletion = /^(Background task|Detached foreground task) (completed|failed|paused|stopped): /.test(header);
	const isGroupedCompletion = /^Background tasks completed \(\d+\): /.test(header);
	if (!isSingleCompletion && !isGroupedCompletion) return lines.join("\n").trim();

	const isMetadata = (line: string) => /^(Parallel handoff|Workflow run|Child runs|Reconciled detached child|Session|Session file|Session share error): /.test(line);
	let body = lines.slice(2);
	if (isSingleCompletion) {
		if (/^Scheduled run from \*\*/.test(body[0] ?? "")) {
			body = body.slice(body[1]?.trim() === "" ? 2 : 1);
		}
		const metadataIndex = body.findIndex(isMetadata);
		const resultEnd = metadataIndex >= 0
			? metadataIndex > 0 && body[metadataIndex - 1]?.trim() === "" ? metadataIndex - 1 : metadataIndex
			: body.length;
		return body.slice(0, resultEnd).join("\n").trim();
	}
	return body.filter((line) => !/^\d+\. /.test(line) && !isMetadata(line)).join("\n").trim();
}

function renderSubagentNotification(message: any, options: any, theme: any): Box | Text {
	const output = getSubagentNotificationOutput(message);
	if (!options.expanded) {
		// Keep the collapsed completion row coloured without exposing its output.
		const box = new Box(1, 0, (text: string) => theme.bg("toolPendingBg", text));
		box.addChild(new Text("Subagent result — Ctrl-K to expand", 0, 0));
		return box;
	}
	if (!output) return new Text("", 0, 0);
	const box = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
	box.addChild(new Text(`\n${theme.fg("toolOutput", output)}`, 0, 0));
	return box;
}

async function registerQuietSubagents(pi: ExtensionAPI): Promise<void> {
	if (process.env.PI_SUBAGENT_CHILD === "1") {
		return;
	}

	const captured = new Map<string, ToolDefinition>();
	const forwardingPi = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "sendMessage") {
				return (message: any, options?: any) => {
					if (message?.customType === "subagent-notify") {
						return pi.sendMessage({ ...message, display: true }, options);
					}
					return pi.sendMessage(message, options);
				};
			}
			if (property === "registerTool") {
				return (definition: ToolDefinition) => {
					if (QUIET_SUBAGENT_TOOLS.has(definition.name)) {
						captured.set(definition.name, definition);
						if (definition.name !== "subagent") {
							pi.registerTool({ ...definition, renderResult: () => new Text("", 0, 0) });
							return;
						}
						const calls = new Map<string, SubagentCall>();
						const formattedWorkflowScripts = new Map<string, string>();
						pi.registerTool({
							...definition,
							async execute(toolCallId, params, signal, onUpdate, ctx) {
								if (typeof params?.workflowScript === "string") {
									formattedWorkflowScripts.set(String(toolCallId), await formatWorkflowScript(params.workflowScript));
								}
								return definition.execute(toolCallId, params, signal, onUpdate, withoutForcedSubagentCollapse(ctx));
							},
							renderCall(args, theme, context) {
								const id = String((context as any)?.toolCallId ?? "");
								calls.set(id, args as SubagentCall);
								return definition.renderCall?.(args, theme, context) ?? new Text("subagent", 0, 0);
							},
							renderResult(result, options, theme, context) {
								if (!options.expanded) return new Text("", 0, 0);
								const id = String((context as any)?.toolCallId ?? "");
								return renderRawSubagentDetails(calls.get(id), formattedWorkflowScripts.get(id), result, theme);
							},
						});
						return;
					}
					pi.registerTool(definition);
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as ExtensionAPI;

	const subagentsExtension = await loadInstalledExtension("pi-subagents", "index.ts");
	await subagentsExtension(forwardingPi);

	// Keep background subagent messages in the agent context, but render their
	// raw output only when Damare's expanded view is selected.
	pi.registerMessageRenderer("subagent-notify", renderSubagentNotification);
	for (const messageType of [
		"subagent_notify",
		"subagent_supervisor_request",
		"subagent-supervisor-request",
		"subagent_control_notice",
		"subagent-control-notice",
		"subagent_steering_notice",
		"subagent-steering-notice",
		"subagent_watchdog_warning",
		"subagent-watchdog-warning",
		"subagent-wait-subscription",
		"subagent_wait_subscription",
		"subagents-admin",
		"subagents_admin",
	]) {
		pi.registerMessageRenderer(messageType, () => ({
			render: () => [],
			invalidate: () => {},
		}));
	}

	if (!captured.has("subagent")) {
		throw new Error("Expected subagent tool was not captured: subagent");
	}
}

function isQuietAgentBrowserTool(name: string): boolean {
	return name === "agent_browser" || name.startsWith("agent_browser_");
}

async function registerQuietAgentBrowser(pi: ExtensionAPI): Promise<void> {
	const captured = new Map<string, ToolDefinition>();
	const forwardingPi = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool") {
				return (definition: ToolDefinition) => {
					if (isQuietAgentBrowserTool(definition.name)) {
						captured.set(definition.name, definition);
						return;
					}
					pi.registerTool(definition);
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as ExtensionAPI;

	const agentBrowserExtension = await loadInstalledExtension(
		"pi-agent-browser-native",
		"dist/extensions/agent-browser/index.js",
	);
	await agentBrowserExtension(forwardingPi);

	if (!captured.has("agent_browser")) {
		throw new Error("Expected agent-browser tool was not captured: agent_browser");
	}
	for (const [name, definition] of captured) {
		pi.registerTool({
			...definition,
			renderResult() {
				return new Text("", 0, 0);
			},
		});
	}
}

// =============================================================================
// Thinking-block suppression by model
// =============================================================================
// Pi has no extension API for thinking-block visibility, so Damare adds a
// per-model default by patching the live interactive session:
//   - SettingsManager#getHideThinkingBlock returns the model default while no
//     manual toggle has happened this session.
//   - InteractiveMode#applyRuntimeSettings is wrapped to capture the resolved
//     session model before Pi re-reads that setting (this runs before the
//     initial transcript is rendered).
//   - Ctrl+T (or Settings > Hide thinking blocks) still wins for the session.

/**
 * Models whose thinking blocks start hidden. Patterns match both
 * `provider/modelId` and bare `modelId`, with `*` and `?` wildcards.
 *
 * These are open-weight models whose thinking is long "thinking out loud" text
 * with little skimmable value. Closed models are deliberately absent: they emit
 * only a short thinking summary, which is worth keeping visible.
 *
 * Override for one run with `PI_DAMARE_HIDE_THINKING_MODELS` (comma- or
 * space-separated patterns).
 */
const DEFAULT_HIDE_THINKING_MODELS = [
	"openrouter/deepseek/*",
	"deepseek/*",
	"deepseek-ai/*",
	"qwen/*",
	"openrouter/qwen/*",
	"moonshotai/*",
	"openrouter/moonshotai/*",
	"zai/*",
	"z-ai/*",
	"openrouter/z-ai/*",
	"minimax/*",
	"openrouter/minimax/*",
];

const HIDE_THINKING_STATE = Symbol.for("pie-damare.hideThinkingState");
const HIDE_THINKING_PATCHED = Symbol.for("pie-damare.hideThinkingPatched");

type ThinkingModelRef = { provider: string; id: string };

interface HideThinkingState {
	activeModel?: ThinkingModelRef;
	/** Set once the user toggles visibility in this process. */
	userToggled: boolean;
	/** Live InteractiveMode instance, so mid-session model changes re-apply. */
	interactive?: any;
}

function getHideThinkingState(): HideThinkingState {
	const host = globalThis as any;
	return (host[HIDE_THINKING_STATE] ??= { userToggled: false } as HideThinkingState);
}

function hideThinkingPatterns(): string[] {
	const override = process.env.PI_DAMARE_HIDE_THINKING_MODELS;
	if (override && override.trim()) {
		return override.split(/[\s,]+/).filter(Boolean);
	}
	return DEFAULT_HIDE_THINKING_MODELS;
}

/** Minimal glob match (`*`, `?`) so we do not depend on minimatch. */
function globMatches(pattern: string, value: string): boolean {
	const regex = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${regex}$`).test(value);
}

function shouldHideThinkingForModel(model: ThinkingModelRef | undefined): boolean {
	if (!model?.id) return false;
	return hideThinkingPatterns().some(
		(pattern) => globMatches(pattern, `${model.provider}/${model.id}`) || globMatches(pattern, model.id),
	);
}

/** Track the active model; a change discards the manual toggle from the old model. */
function updateActiveModel(model: ThinkingModelRef | undefined): void {
	if (!model?.id) return;
	const state = getHideThinkingState();
	if (state.activeModel?.provider !== model.provider || state.activeModel?.id !== model.id) {
		state.userToggled = false;
	}
	state.activeModel = { provider: model.provider, id: model.id };
}

/** Push the model default onto the live transcript, honouring a manual toggle. */
function applyThinkingVisibility(model: ThinkingModelRef | undefined): void {
	if (model?.id) updateActiveModel(model);
	const state = getHideThinkingState();
	if (state.userToggled) return;
	const instance = state.interactive;
	if (!instance) return;
	// Read through the patched getter so an explicit `hideThinkingBlock: true`
	// in settings still hides thinking for closed models too.
	const hidden =
		instance.settingsManager?.getHideThinkingBlock?.() ?? shouldHideThinkingForModel(state.activeModel);
	if (instance.hideThinkingBlock !== hidden) {
		instance.hideThinkingBlock = hidden;
		instance.updateThinkingBlockVisibility?.();
	}
}

/** Install the process-wide patches exactly once (survives extension reloads). */
function installThinkingSuppressionPatch(): void {
	const host = globalThis as any;
	if (host[HIDE_THINKING_PATCHED]) return;
	host[HIDE_THINKING_PATCHED] = true;

	const originalGet = SettingsManager.prototype.getHideThinkingBlock;
	SettingsManager.prototype.getHideThinkingBlock = function (this: SettingsManager): boolean {
		const state = getHideThinkingState();
		if (!state.userToggled && shouldHideThinkingForModel(state.activeModel)) {
			return true;
		}
		return originalGet.call(this);
	};

	const originalSet = SettingsManager.prototype.setHideThinkingBlock;
	SettingsManager.prototype.setHideThinkingBlock = function (this: SettingsManager, hide: boolean): void {
		getHideThinkingState().userToggled = true;
		return originalSet.call(this, hide);
	};

	const originalApply = InteractiveMode.prototype.applyRuntimeSettings;
	(InteractiveMode.prototype as any).applyRuntimeSettings = function (this: any, ...args: unknown[]) {
		const state = getHideThinkingState();
		state.interactive = this;
		const model = this?.session?.model;
		if (model?.provider && model?.id) {
			updateActiveModel({ provider: model.provider, id: model.id });
		}
		return originalApply.apply(this, args);
	};
}

function registerThinkingSuppression(pi: ExtensionAPI): void {
	installThinkingSuppressionPatch();

	pi.on("session_start", (event, ctx) => {
		// New/resumed/forked sessions re-apply the per-model default. A reload
		// keeps whatever the user toggled in the current session.
		if (event.reason !== "reload") {
			getHideThinkingState().userToggled = false;
		}
		applyThinkingVisibility(ctx.model as ThinkingModelRef | undefined);
	});

	pi.on("model_select", (event, ctx) => {
		applyThinkingVisibility((event.model ?? ctx.model) as ThinkingModelRef | undefined);
	});
}

export default async function (pi: ExtensionAPI) {
	registerThinkingSuppression(pi);
	await registerQuietBackgroundTasks(pi);
	await registerQuietSubagents(pi);
	await registerQuietAgentBrowser(pi);
	// =========================================================================
	// Bash Tool
	// =========================================================================
	pi.registerTool({
		...capturedBgBash,
		name: "bash",
		label: "bash",
		description:
			capturedBgBash?.description ??
			"Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
		parameters: capturedBgBash?.parameters ?? getBuiltInTools(process.cwd()).bash.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (capturedBgBash) {
				return capturedBgBash.execute(toolCallId, params, signal, onUpdate, ctx);
			}
			const tools = getBuiltInTools(ctx.cwd);
			return tools.bash.execute(toolCallId, params, signal, onUpdate, ctx);
		},

		renderCall(args, theme, _context) {
			const timeout = args.timeout !== undefined ? theme.fg("muted", ` (${args.timeout}s)`) : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("bash"))}${timeout}`, 0, 0);
		},

		renderResult(result, { expanded }, theme, context) {
			if (!expanded) return new Text("", 0, 0);

			const command = typeof context.args?.command === "string" ? context.args.command : "...";
			const textContent = result.content.find((content) => content.type === "text");
			const output = textContent?.type === "text" ? `\n${theme.fg("toolOutput", textContent.text)}` : "";
			return new Text(`\n${theme.fg("accent", `$ ${command}`)}${output}`, 0, 0);
		},
	});

	// =========================================================================
	// Read Tool
	// =========================================================================
	pi.registerTool({
		name: "read",
		label: "read",
		description:
			"Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files.",
		parameters: getBuiltInTools(process.cwd()).read.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tools = getBuiltInTools(ctx.cwd);
			return tools.read.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			const path = shortenPath(args.path || "");
			let pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");

			// Show line range if specified
			if (args.offset !== undefined || args.limit !== undefined) {
				const startLine = args.offset ?? 1;
				const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
				pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}

			return new Text(`${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			// Minimal mode: show nothing in collapsed state
			if (!expanded) {
				return new Text("", 0, 0);
			}

			// Expanded mode: show full output
			const textContent = result.content.find((c) => c.type === "text");
			if (!textContent || textContent.type !== "text") {
				return new Text("", 0, 0);
			}

			const lines = textContent.text.split("\n");
			const output = lines.map((line) => theme.fg("toolOutput", line)).join("\n");
			return new Text(`\n${output}`, 0, 0);
		},
	});

	// =========================================================================
	// Write Tool
	// =========================================================================
	pi.registerTool({
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: getBuiltInTools(process.cwd()).write.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tools = getBuiltInTools(ctx.cwd);
			return tools.write.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			const path = shortenPath(args.path || "");
			const pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
			const lineCount = args.content ? args.content.split("\n").length : 0;
			const lineInfo = lineCount > 0 ? theme.fg("muted", ` (${lineCount} lines)`) : "";

			return new Text(`${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay}${lineInfo}`, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			// Minimal mode: show nothing (file was written)
			if (!expanded) {
				return new Text("", 0, 0);
			}

			// Expanded mode: show error if any
			if (result.content.some((c) => c.type === "text" && c.text)) {
				const textContent = result.content.find((c) => c.type === "text");
				if (textContent?.type === "text" && textContent.text) {
					return new Text(`\n${theme.fg("error", textContent.text)}`, 0, 0);
				}
			}

			return new Text("", 0, 0);
		},
	});

	// =========================================================================
	// Edit Tool
	// =========================================================================
	pi.registerTool({
		name: "edit",
		label: "edit",
		description:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
		parameters: getBuiltInTools(process.cwd()).edit.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tools = getBuiltInTools(ctx.cwd);
			return tools.edit.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			const path = shortenPath(args.path || "");
			const pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");

			return new Text(`${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			// Minimal mode: show nothing in collapsed state
			if (!expanded) {
				return new Text("", 0, 0);
			}

			// Expanded mode: show diff or error
			const textContent = result.content.find((c) => c.type === "text");
			if (!textContent || textContent.type !== "text") {
				return new Text("", 0, 0);
			}

			// For errors, show the error message
			const text = textContent.text;
			if (text.includes("Error") || text.includes("error")) {
				return new Text(`\n${theme.fg("error", text)}`, 0, 0);
			}

			// Otherwise show the text (would be nice to show actual diff here)
			return new Text(`\n${theme.fg("toolOutput", text)}`, 0, 0);
		},
	});

	// =========================================================================
	// Find Tool
	// =========================================================================
	pi.registerTool({
		name: "find",
		label: "find",
		description:
			"Find files by name pattern (glob). Searches recursively from the specified path. Output limited to 200 results.",
		parameters: getBuiltInTools(process.cwd()).find.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tools = getBuiltInTools(ctx.cwd);
			return tools.find.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			const pattern = args.pattern || "";
			const path = shortenPath(args.path || ".");
			const limit = args.limit;

			let text = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", pattern)}`;
			text += theme.fg("toolOutput", ` in ${path}`);
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` (limit ${limit})`);
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			if (!expanded) {
				// Minimal: just show count
				const textContent = result.content.find((c) => c.type === "text");
				if (textContent?.type === "text") {
					const count = textContent.text.trim().split("\n").filter(Boolean).length;
					if (count > 0) {
						return new Text(theme.fg("muted", ` → ${count} files`), 0, 0);
					}
				}
				return new Text("", 0, 0);
			}

			// Expanded: show full results
			const textContent = result.content.find((c) => c.type === "text");
			if (!textContent || textContent.type !== "text") {
				return new Text("", 0, 0);
			}

			const output = textContent.text
				.trim()
				.split("\n")
				.map((line) => theme.fg("toolOutput", line))
				.join("\n");

			return new Text(`\n${output}`, 0, 0);
		},
	});

	// =========================================================================
	// Grep Tool
	// =========================================================================
	pi.registerTool({
		name: "grep",
		label: "grep",
		description:
			"Search file contents by regex pattern. Uses ripgrep for fast searching. Output limited to 200 matches.",
		parameters: getBuiltInTools(process.cwd()).grep.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tools = getBuiltInTools(ctx.cwd);
			return tools.grep.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			const pattern = args.pattern || "";
			const path = shortenPath(args.path || ".");
			const glob = args.glob;
			const limit = args.limit;

			let text = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", `/${pattern}/`)}`;
			text += theme.fg("toolOutput", ` in ${path}`);
			if (glob) {
				text += theme.fg("toolOutput", ` (${glob})`);
			}
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` limit ${limit}`);
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			if (!expanded) {
				// Minimal: just show match count
				const textContent = result.content.find((c) => c.type === "text");
				if (textContent?.type === "text") {
					const count = textContent.text.trim().split("\n").filter(Boolean).length;
					if (count > 0) {
						return new Text(theme.fg("muted", ` → ${count} matches`), 0, 0);
					}
				}
				return new Text("", 0, 0);
			}

			// Expanded: show full results
			const textContent = result.content.find((c) => c.type === "text");
			if (!textContent || textContent.type !== "text") {
				return new Text("", 0, 0);
			}

			const output = textContent.text
				.trim()
				.split("\n")
				.map((line) => theme.fg("toolOutput", line))
				.join("\n");

			return new Text(`\n${output}`, 0, 0);
		},
	});

	// =========================================================================
	// Ls Tool
	// =========================================================================
	pi.registerTool({
		name: "ls",
		label: "ls",
		description:
			"List directory contents with file sizes. Shows files and directories with their sizes. Output limited to 500 entries.",
		parameters: getBuiltInTools(process.cwd()).ls.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tools = getBuiltInTools(ctx.cwd);
			return tools.ls.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, _context) {
			const path = shortenPath(args.path || ".");
			const limit = args.limit;

			let text = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", path)}`;
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` (limit ${limit})`);
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			if (!expanded) {
				// Minimal: just show entry count
				const textContent = result.content.find((c) => c.type === "text");
				if (textContent?.type === "text") {
					const count = textContent.text.trim().split("\n").filter(Boolean).length;
					if (count > 0) {
						return new Text(theme.fg("muted", ` → ${count} entries`), 0, 0);
					}
				}
				return new Text("", 0, 0);
			}

			// Expanded: show full listing
			const textContent = result.content.find((c) => c.type === "text");
			if (!textContent || textContent.type !== "text") {
				return new Text("", 0, 0);
			}

			const output = textContent.text
				.trim()
				.split("\n")
				.map((line) => theme.fg("toolOutput", line))
				.join("\n");

			return new Text(`\n${output}`, 0, 0);
		},
	});
}
