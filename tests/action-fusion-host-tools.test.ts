/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	editDefinitionForVariant,
	publishedTool,
	requestedToolPath,
	sessionEditVariant,
} from "../src/sol-pi/extensions/action-fusion/base-tools.ts";
import { resolveToolPath } from "../src/sol-pi/extensions/action-fusion/file-queue.ts";
import {
	type ActionFusionOptions,
	createActionFusionExtension,
} from "../src/sol-pi/extensions/action-fusion/index.ts";

/**
 * Stands in for the host's published tool listing. The two `edit` schemas are
 * the shapes Oh My Pi resolves per session; `editSource` is `"builtin"` while
 * the host still publishes its own entry and `"extension"` once SoL-Pi's
 * replacement holds the name, which is when the read description has to answer.
 */
interface PublishedToolStub {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
	readonly sourceInfo: { readonly source: string };
}

const HASHLINE_EDIT_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: { input: { type: "string", description: "Patch text" } },
	required: ["input"],
};
const REPLACE_EDIT_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
	required: ["path"],
};
const WRITE_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: { path: { type: "string" }, content: { type: "string" } },
	required: ["path", "content"],
};
const HASHLINE_READ_DESCRIPTION =
	"Read files via `path`.\n- File + selector → `[foo.ts#1A2B]` snapshot header and numbered lines.";
const PLAIN_READ_DESCRIPTION = "Read files via `path`.\n- Without a selector, content is returned as-is.";

interface ListingOptions {
	readonly editSchema?: Record<string, unknown>;
	readonly editSource?: string;
	readonly readDescription?: string | null;
}

function publishedTools({
	editSchema = REPLACE_EDIT_SCHEMA,
	editSource = "builtin",
	readDescription = PLAIN_READ_DESCRIPTION,
}: ListingOptions = {}): PublishedToolStub[] {
	const tools: PublishedToolStub[] = [
		{ name: "edit", description: "Edit a file", parameters: editSchema, sourceInfo: { source: editSource } },
		{ name: "write", description: "Write a file", parameters: WRITE_SCHEMA, sourceInfo: { source: editSource } },
	];
	if (readDescription !== null) {
		tools.unshift({
			name: "read",
			description: readDescription,
			parameters: { type: "object" },
			sourceInfo: { source: "builtin" },
		});
	}
	return tools;
}

type InvokeTool = (params: Record<string, unknown>) => Promise<AgentToolResult<unknown>>;

interface LoadOptions {
	readonly listing?: ListingOptions;
	readonly fusion?: ActionFusionOptions;
	readonly invokeTool?: InvokeTool;
	/** Model the fired hooks report; `null` fires them without one. */
	readonly model?: { readonly provider: string; readonly id: string } | null;
}

/** A model the host resolves to the `replace` variant. */
const DOWNGRADED_MODEL = { provider: "kimi-code", id: "k3-256k" };

interface Harness {
	readonly edit: ToolDefinition;
	readonly write: ToolDefinition;
	readonly registered: Map<string, ToolDefinition>;
	/** Runs the `session_start` handlers the extension registered. */
	readonly startSession: () => void;
	/** Runs the `before_agent_start` handlers the extension registered. */
	readonly startRun: () => void;
}

function loadTools({ listing, fusion, invokeTool, model = DOWNGRADED_MODEL }: LoadOptions = {}): Harness {
	const registered = new Map<string, ToolDefinition>();
	const handlers = new Map<string, Array<(event: unknown, context: unknown) => void>>();
	const tools = publishedTools(listing);
	const pi = {
		registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool),
		on: (name: string, handler: (event: unknown, context: unknown) => void) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		getAllTools: () => tools,
	} as unknown as ExtensionAPI;
	createActionFusionExtension(fusion)(pi);
	const edit = registered.get("edit");
	const write = registered.get("write");
	if (!edit || !write) throw new Error("action fusion did not register edit and write");
	const fire = (event: string) => {
		const context = model === null ? {} : { model };
		for (const handler of handlers.get(event) ?? []) handler({ type: event }, context);
	};
	return { edit, write, registered, startSession: () => fire("session_start"), startRun: () => fire("before_agent_start") };
}

function context(cwd: string, invokeTool?: InvokeTool): ExtensionContext {
	return {
		cwd,
		mode: "json",
		hasUI: false,
		model: undefined,
		ui: {},
		sessionManager: { getSessionId: () => "action-fusion-host-tools", getSessionFile: () => undefined },
		...(invokeTool ? { invokeTool } : {}),
	} as unknown as ExtensionContext;
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

function propertiesOf(tool: ToolDefinition): string[] {
	const parameters = tool.parameters as unknown as { properties?: Record<string, unknown> };
	return Object.keys(parameters.properties ?? {});
}

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "action-fusion-host-tools-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	delete process.env.PI_EDIT_VARIANT;
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Action Fusion host built-in inheritance", () => {
	it("advertises the parameter shape the host published for the active session", () => {
		expect(propertiesOf(loadTools({ listing: { editSchema: HASHLINE_EDIT_SCHEMA } }).edit)).toEqual([
			"input",
			"then_run",
		]);
		expect(propertiesOf(loadTools({ listing: { editSchema: REPLACE_EDIT_SCHEMA } }).edit)).toEqual([
			"path",
			"old_string",
			"new_string",
			"then_run",
		]);
		expect(propertiesOf(loadTools().write)).toEqual(["path", "content", "then_run"]);
	});

	it("prefers the built-in entry and tolerates a host without a tool listing", () => {
		const tools = publishedTools({ editSchema: HASHLINE_EDIT_SCHEMA });
		expect(publishedTool({ getAllTools: () => tools } as unknown as ExtensionAPI, "edit")?.description).toBe(
			"Edit a file",
		);

		expect(publishedTool({} as unknown as ExtensionAPI, "edit")).toBeUndefined();
		expect(
			publishedTool(
				{
					getAllTools: () => {
						throw new Error("Extension runtime not initialized.");
					},
				} as unknown as ExtensionAPI,
				"edit",
			),
		).toBeUndefined();

		const shadowed = [
			{ name: "edit", description: "Extension shadow", parameters: {}, sourceInfo: { source: "extension" } },
			...tools,
		];
		expect(publishedTool({ getAllTools: () => shadowed } as unknown as ExtensionAPI, "edit")?.description).toBe(
			"Edit a file",
		);
	});

	it("reads the variant from the built-in edit schema while the host still publishes it", () => {
		const variantOf = (listing: ListingOptions) =>
			sessionEditVariant({ getAllTools: () => publishedTools(listing) } as unknown as ExtensionAPI);

		expect(variantOf({ editSchema: HASHLINE_EDIT_SCHEMA, readDescription: PLAIN_READ_DESCRIPTION })).toBe("hashline");
		expect(variantOf({ editSchema: REPLACE_EDIT_SCHEMA, readDescription: HASHLINE_READ_DESCRIPTION })).toBe("replace");
	});

	it("falls back to the read description once the host no longer publishes the built-in edit", () => {
		const variantOf = (listing: ListingOptions) =>
			sessionEditVariant({ getAllTools: () => publishedTools(listing) } as unknown as ExtensionAPI);
		const replaced: ListingOptions = { editSource: "extension" };

		expect(variantOf({ ...replaced, readDescription: HASHLINE_READ_DESCRIPTION })).toBe("hashline");
		expect(variantOf({ ...replaced, readDescription: PLAIN_READ_DESCRIPTION })).toBe("replace");
		expect(variantOf({ ...replaced, readDescription: null })).toBeUndefined();
		expect(
			sessionEditVariant({
				getAllTools: () => {
					throw new Error("Extension runtime not initialized");
				},
			} as unknown as ExtensionAPI),
		).toBeUndefined();

		process.env.PI_EDIT_VARIANT = "hashline";
		expect(variantOf({ ...replaced, readDescription: PLAIN_READ_DESCRIPTION })).toBe("hashline");
		delete process.env.PI_EDIT_VARIANT;
	});

	it("restores the edit variant switch after building a variant definition", () => {
		const previous = process.env.PI_EDIT_VARIANT;
		process.env.PI_EDIT_VARIANT = "replace";
		const definition = editDefinitionForVariant("/tmp", "hashline");
		expect(definition.description.length).toBeGreaterThan(0);
		expect(process.env.PI_EDIT_VARIANT).toBe("replace");

		if (previous === undefined) delete process.env.PI_EDIT_VARIANT;
		else process.env.PI_EDIT_VARIANT = previous;
	});

	it("resolves the variant from the active model once the host replaces its own edit", () => {
		const variantFor = (model: { provider: string; id: string }) =>
			sessionEditVariant({ getAllTools: () => publishedTools({ editSource: "extension" }) } as unknown as ExtensionAPI, model);

		expect(variantFor({ provider: "kimi-code", id: "k3-256k" })).toBe("replace");
		expect(variantFor({ provider: "deepseek", id: "deepseek-flash" })).toBe("replace");
		expect(variantFor({ provider: "z-ai", id: "glm-5.3-flash" })).toBe("replace");
		expect(variantFor({ provider: "openai-codex", id: "gpt-6-astra" })).toBe("hashline");
		expect(variantFor({ provider: "anthropic", id: "claude-opus-4" })).toBe("hashline");
	});

	it("corrects the advertised edit shape from either hook that runs before a request", () => {
		const expected = editDefinitionForVariant(process.cwd(), "replace");
		const fromSessionStart = loadTools({ listing: { editSource: "extension" } });
		expect(fromSessionStart.edit.description).toBe("Edit a file");
		fromSessionStart.startSession();
		expect(fromSessionStart.edit.description).toBe(expected.description);
		expect(propertiesOf(fromSessionStart.edit)).toContain("then_run");

		const fromAgentStart = loadTools({ listing: { editSource: "extension" } });
		fromAgentStart.startRun();
		expect(fromAgentStart.edit.description).toBe(expected.description);
	});

	it("keeps the advertised shape when the host publishes no variant signal", () => {
		const harness = loadTools({ listing: { editSource: "extension", readDescription: null }, model: null });
		const before = harness.edit.description;

		harness.startSession();
		harness.startRun();

		expect(harness.edit.description).toBe(before);
		expect(propertiesOf(harness.edit)).toEqual(["path", "old_string", "new_string", "then_run"]);
	});

	it("treats hashline patches and device targets as having no single file", () => {
		expect(requestedToolPath({ input: "[a.ts#1A2B]\nPUT 1.=1:\n+x\n" })).toBeUndefined();
		expect(requestedToolPath({ path: "a.ts" })).toBe("a.ts");
		expect(requestedToolPath({ path: "" })).toBeUndefined();
		expect(resolveToolPath("/cwd", undefined)).toBeUndefined();
		expect(resolveToolPath("/cwd", "xd://resolve")).toBeUndefined();
		expect(resolveToolPath("/cwd", "artifact://obs_1")).toBeUndefined();
		expect(resolveToolPath("/cwd", "target.txt")).toBe("/cwd/target.txt");
	});

	it("delegates the mutation to the host built-in and still fuses then_run", async () => {
		const dir = await createTempDir();
		const target = join(dir, "delegated.txt");
		const composedWrites: string[] = [];
		const invokeTool = vi.fn<InvokeTool>(async (params) => {
			await writeFile(String(params.path), String(params.content), "utf8");
			return { content: [{ type: "text", text: "wrote" }], details: { path: String(params.path) } };
		});
		const commands: string[] = [];
		const { write } = loadTools({
			fusion: {
				bashOptions: {
					operations: {
						exec: async (command, commandCwd) => {
							commands.push(`${commandCwd}:${command}`);
							expect(await readFile(target, "utf8")).toBe("fused\n");
							return { exitCode: 0 };
						},
					},
				},
				writeOptions: {
					operations: {
						mkdir: async () => {},
						writeFile: async (path) => {
							composedWrites.push(path);
						},
					},
				},
			},
		});

		const result = await write.execute(
			"host-delegated",
			{ path: target, content: "fused\n", then_run: { command: "check delegated" } },
			undefined,
			undefined,
			context(dir, invokeTool),
		);

		expect(invokeTool).toHaveBeenCalledTimes(1);
		expect(invokeTool.mock.calls[0]?.[0]).toEqual({ path: target, content: "fused\n" });
		expect(composedWrites).toEqual([]);
		expect(commands).toEqual([`${dir}:check delegated`]);
		expect(text(result)).toContain("[then_run:succeeded]");
	});

	it("fuses a hashline edit that names no path and guards the file the host reported", async () => {
		const dir = await createTempDir();
		const target = join(dir, "hashline.txt");
		await writeFile(target, "before\n", "utf8");
		const invokeTool = vi.fn<InvokeTool>(async () => {
			await writeFile(target, "after\n", "utf8");
			return { content: [{ type: "text", text: "edited" }], details: { path: target } };
		});
		const commands: string[] = [];
		const { edit } = loadTools({
			listing: { editSchema: HASHLINE_EDIT_SCHEMA },
			fusion: {
				bashOptions: {
					operations: {
						exec: async (command) => {
							commands.push(command);
							expect(await readFile(target, "utf8")).toBe("after\n");
							return { exitCode: 0 };
						},
					},
				},
			},
		});

		const result = await edit.execute(
			"hashline-edit",
			{ input: `[${target}#1A2B]\nPUT 1.=1:\n+after\n`, then_run: { command: "check hashline" } },
			undefined,
			undefined,
			context(dir, invokeTool),
		);

		expect(invokeTool.mock.calls[0]?.[0]).toEqual({ input: expect.stringContaining("PUT 1.=1:") });
		expect(commands).toEqual(["check hashline"]);
		expect(text(result)).toContain("[then_run:succeeded]");
	});

	it("skips then_run when a file the host reported is missing", async () => {
		const dir = await createTempDir();
		const gone = join(dir, "gone.txt");
		let commands = 0;
		const invokeTool = vi.fn<InvokeTool>(async () => ({
			content: [{ type: "text", text: "edited" }],
			details: { perFileResults: [{ path: gone }, { path: join(dir, "kept.txt") }] },
		}));
		const { edit } = loadTools({
			listing: { editSchema: HASHLINE_EDIT_SCHEMA },
			fusion: {
				bashOptions: {
					operations: {
						exec: async () => {
							commands++;
							return { exitCode: 0 };
						},
					},
				},
			},
		});

		await expect(
			edit.execute(
				"hashline-missing",
				{ input: "[gone.txt#1A2B]\nREM 1\n", then_run: { command: "must not run" } },
				undefined,
				undefined,
				context(dir, invokeTool),
			),
		).rejects.toThrow("[then_run:skipped]");
		expect(commands).toBe(0);
	});

	it("fuses a device write that has no filesystem target", async () => {
		const dir = await createTempDir();
		const invokeTool = vi.fn<InvokeTool>(async () => ({
			content: [{ type: "text", text: "No pending action to apply" }],
			details: {},
		}));
		const commands: string[] = [];
		const { write } = loadTools({
			fusion: {
				bashOptions: {
					operations: {
						exec: async (command) => {
							commands.push(command);
							return { exitCode: 0 };
						},
					},
				},
			},
		});

		const result = await write.execute(
			"device-write",
			{ path: "xd://resolve", content: "the change is reviewed", then_run: { command: "after device write" } },
			undefined,
			undefined,
			context(dir, invokeTool),
		);

		expect(invokeTool.mock.calls[0]?.[0]).toEqual({ path: "xd://resolve", content: "the change is reviewed" });
		expect(commands).toEqual(["after device write"]);
		expect(text(result)).toContain("[then_run:succeeded]");
	});
});
