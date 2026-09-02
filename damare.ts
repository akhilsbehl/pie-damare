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

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
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
const PI_PACKAGE_NODE_MODULES = join(getAgentDir(), "npm", "node_modules");

type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

/**
 * Load a currently installed Pi package at factory time. Keeping this out of
 * the static import graph means the package manager can replace a package
 * before this extension loads it, and avoids a machine-specific home path.
 */
async function loadInstalledExtension(packageName: string, relativePath: string): Promise<ExtensionFactory> {
	const extensionPath = join(PI_PACKAGE_NODE_MODULES, packageName, relativePath);
	const module = await import(pathToFileURL(extensionPath).href);
	if (typeof module.default !== "function") {
		throw new Error(`Installed package extension has no default factory: ${packageName}`);
	}
	return module.default as ExtensionFactory;
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

	for (const name of QUIET_BG_TOOLS) {
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

type SubagentCall = { action?: string; task?: string; message?: string };

function renderRawSubagentDetails(call: SubagentCall | undefined, result: any, theme: any): Text {
	const lines: string[] = [];
	if (call?.action === "steer") lines.push(`requested_message: ${call.message ?? ""}`);
	else if (!call?.action && call?.task !== undefined) lines.push(`task: ${call.task}`);

	for (const child of result?.details?.results ?? []) {
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
		box.addChild(new Text("\u200b", 0, 0));
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
						pi.registerTool({
							...definition,
							renderCall(args, theme, context) {
								const id = String((context as any)?.toolCallId ?? "");
								calls.set(id, args as SubagentCall);
								return definition.renderCall?.(args, theme, context) ?? new Text("subagent", 0, 0);
							},
							renderResult(result, options, theme, context) {
								if (!options.expanded) return new Text("", 0, 0);
								const id = String((context as any)?.toolCallId ?? "");
								return renderRawSubagentDetails(calls.get(id), result, theme);
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

export default async function (pi: ExtensionAPI) {
	await registerQuietBackgroundTasks(pi);
	await registerQuietSubagents(pi);
	await registerQuietAgentBrowser(pi);
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
