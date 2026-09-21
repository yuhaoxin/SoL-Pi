/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { CompactOptions, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
	boundaryTrigger,
	compactSession,
	deferOutsideHandler,
	invokeBaseRenderer,
	resolveCallRender,
	resolveResultRender,
	systemPromptText,
	usesManagedTimers,
	withOptionalProperty,
} from "../src/sol-pi/host-compat.ts";
import { fakeContext, plainTheme } from "./helpers.ts";

/**
 * A schema shaped like the ones omp's built-ins expose: callable, with the JSON
 * Schema document reachable only through `toJsonSchema()` and no `properties`.
 */
function callableSchema(document: Record<string, unknown>): TSchema {
	return Object.assign(() => undefined, { toJsonSchema: () => document }) as unknown as TSchema;
}

const OMP_WRITE_SCHEMA = callableSchema({
	type: "object",
	required: ["path", "content"],
	additionalProperties: false,
	properties: {
		path: { type: "string", description: "Path to the file to write" },
		content: { type: "string" },
		mode: { type: "string" },
	},
});

const THEN_RUN = Type.Optional(Type.Object({ command: Type.String() }));

function propertiesOf(schema: unknown): Record<string, unknown> {
	return (schema as { properties: Record<string, unknown> }).properties;
}

function requiredOf(schema: unknown): unknown {
	return (schema as { required?: unknown }).required;
}

describe("host tool parameter schemas", () => {
	it("spreads a TypeBox host schema without disturbing its optional marks", () => {
		const base = Type.Object({ path: Type.String(), mode: Type.Optional(Type.String()) });
		const fused = withOptionalProperty(base, "then_run", THEN_RUN);

		expect(Object.keys(propertiesOf(fused)).sort()).toEqual(["mode", "path", "then_run"]);
		expect(requiredOf(fused)).toEqual(["path"]);
	});

	it("rebuilds a callable host schema from its JSON document", () => {
		const fused = withOptionalProperty(OMP_WRITE_SCHEMA, "then_run", THEN_RUN);

		expect(Object.keys(propertiesOf(fused)).sort()).toEqual(["content", "mode", "path", "then_run"]);
		expect(requiredOf(fused)).toEqual(["path", "content"]);
		expect((fused as { additionalProperties?: unknown }).additionalProperties).toBe(false);
		expect(propertiesOf(fused).path).toMatchObject({ type: "string" });
	});

	it("keeps an added property optional", () => {
		const fused = withOptionalProperty(OMP_WRITE_SCHEMA, "then_run", THEN_RUN);

		expect(requiredOf(fused)).not.toContain("then_run");
	});
});

describe("host renderer arguments", () => {
	const args = { path: "src/a.ts", then_run: { command: "npm test" } };

	it("reads Pi's renderCall arguments", () => {
		const view = resolveCallRender(plainTheme, { cwd: "/work", args }, args);

		expect(view).toMatchObject({ theme: plainTheme, cwd: "/work", args, piOrder: true });
	});

	it("reads omp's renderCall arguments", () => {
		const view = resolveCallRender({ expanded: false }, plainTheme, args);

		expect(view.theme).toBe(plainTheme);
		expect(view.args).toEqual(args);
		expect(view.piOrder).toBe(false);
		expect(view.cwd).toBe(process.cwd());
	});

	it("reads Pi's renderResult arguments", () => {
		const view = resolveResultRender(plainTheme, { cwd: "/work", args }, {});

		expect(view).toMatchObject({ theme: plainTheme, cwd: "/work", args, piOrder: true });
	});

	it("reads omp's renderResult arguments, which pass the call arguments fourth", () => {
		const view = resolveResultRender(plainTheme, args, {});

		expect(view.args).toEqual(args);
		expect(view.cwd).toBe(process.cwd());
	});

	it("survives a host that renders without a theme", () => {
		const view = resolveCallRender({}, undefined, args);

		expect(view.theme).toBeUndefined();
		expect(view.args).toEqual(args);
	});

	it("delegates to a host renderer with that host's own arguments", () => {
		const renderCall = vi.fn(() => "component");
		const second = { expanded: false };
		const third = plainTheme;

		expect(invokeBaseRenderer({ renderCall }, "renderCall", [args, second, third])).toBe("component");
		expect(renderCall).toHaveBeenCalledWith(args, second, third);
	});

	it("reports a missing host renderer instead of calling into it", () => {
		expect(invokeBaseRenderer({ name: "edit" }, "renderCall", [args, plainTheme])).toBeUndefined();
		expect(invokeBaseRenderer(undefined, "renderResult", [])).toBeUndefined();
	});
});

describe("host system prompt", () => {
	it("joins the lines omp returns", () => {
		expect(systemPromptText(fakeContext("/sessions", { getSystemPrompt: () => ["one", "two"] as never }))).toBe(
			"one\ntwo",
		);
	});

	it("passes through the single string Pi returns", () => {
		expect(systemPromptText(fakeContext("/sessions", { getSystemPrompt: () => "prompt" }))).toBe("prompt");
	});
});

describe("host compaction", () => {
	function contextWith(compact: (options: CompactOptions) => unknown): ExtensionContext {
		return fakeContext("/sessions", { compact: compact as never });
	}

	it("reports the summary from a host that resolves its compaction promise", async () => {
		const calls: CompactOptions[] = [];
		const onComplete = vi.fn();
		const context = contextWith(async (options) => {
			calls.push(options);
			(options as { onComplete?: (result: { summary: string }) => void }).onComplete?.({ summary: "omp" });
		});

		await compactSession(context, {
			instructions: "keep the work",
			suppressContinuation: true,
			onComplete,
			onError: vi.fn(),
		});

		expect(onComplete).toHaveBeenCalledWith("omp");
		expect(calls[0]).toMatchObject({
			customInstructions: "keep the work",
			internalGuidance: "keep the work",
			suppressContinuation: true,
		});
	});

	it("reports the summary from a host that only calls back", async () => {
		const onComplete = vi.fn();
		const context = contextWith((options) => {
			void Promise.resolve().then(() =>
				(options as { onComplete?: (result: { summary: string }) => void }).onComplete?.({ summary: "pi" }),
			);
		});

		await compactSession(context, { instructions: "keep", onComplete, onError: vi.fn() });

		expect(onComplete).toHaveBeenCalledWith("pi");
	});

	it("surfaces a rejection that never reaches the callback", async () => {
		const onError = vi.fn();
		const context = contextWith(async () => {
			throw new Error("compaction exploded");
		});

		await compactSession(context, { instructions: "keep", onComplete: vi.fn(), onError });

		expect(onError).toHaveBeenCalledOnce();
		expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
	});
});

describe("host boundary trigger", () => {
	function host(mode: string, managedTimers: boolean): ExtensionContext {
		return fakeContext("/sessions", {
			mode,
			...(managedTimers ? { setTimeout: (() => 0) as never } : {}),
		} as Partial<ExtensionContext>);
	}

	it("compacts from a settle event on Pi", () => {
		expect(boundaryTrigger(host("tui", false))).toBe("settle");
		expect(boundaryTrigger(host("print", false))).toBe("settle");
	});

	it("defers compaction on omp sessions that outlive the run", () => {
		expect(boundaryTrigger(host("tui", true))).toBe("deferred");
		expect(boundaryTrigger(host("rpc", true))).toBe("deferred");
	});

	it("leaves omp print and JSON sessions alone", () => {
		// Those hosts tear down as soon as an interrupted prompt settles, which
		// cancels the compaction and discards the rest of the run.
		expect(boundaryTrigger(host("print", true))).toBe("unavailable");
		expect(boundaryTrigger(host("json", true))).toBe("unavailable");
	});
});

describe("host timers", () => {
	const managedTimerHost = (): ExtensionContext =>
		fakeContext("/sessions", { setTimeout: (() => 0) as never } as Partial<ExtensionContext>);

	it("runs a deferred task after the handler returns", async () => {
		const context = managedTimerHost();
		const task = vi.fn(async () => undefined);

		expect(usesManagedTimers(context)).toBe(true);
		deferOutsideHandler(context, task);
		await vi.waitFor(() => expect(task).toHaveBeenCalledOnce());
	});

	it("contains a rejected deferred task instead of failing the process", async () => {
		const context = managedTimerHost();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			deferOutsideHandler(context, async () => {
				throw new Error("boundary compaction exploded");
			});
			await vi.waitFor(() => expect(consoleError).toHaveBeenCalledOnce());
			expect(String(consoleError.mock.calls[0]?.[0])).toContain("boundary compaction exploded");
		} finally {
			consoleError.mockRestore();
		}
	});

	it("does nothing on a host without managed timers", async () => {
		const context = fakeContext("/sessions");
		const task = vi.fn(async () => undefined);

		expect(usesManagedTimers(context)).toBe(false);
		deferOutsideHandler(context, task);
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(task).not.toHaveBeenCalled();
	});
});
