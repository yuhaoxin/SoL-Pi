/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Action Fusion on an omp-shaped host: the built-in definitions carry no
 * renderers, and the host enforces a per-tool approval tier.
 */
import type * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createActionFusionExtension } from "../src/sol-pi/extensions/action-fusion/index.ts";
import { componentText, FakePi, plainTheme } from "./helpers.ts";

/** omp's built-in edit/write definitions have no renderers but carry an approval. */
vi.mock("@earendil-works/pi-coding-agent", async (importActual) => {
	const actual = await importActual<typeof PiCodingAgent>();
	const withoutRenderers = <T extends object>(definition: T, approval: unknown): T => {
		const { renderCall: _call, renderResult: _result, ...rest } = definition as Record<string, unknown>;
		return { ...rest, approval } as T;
	};
	return {
		...actual,
		createEditToolDefinition: (cwd: string) =>
			withoutRenderers(actual.createEditToolDefinition(cwd), () => "write"),
		createWriteToolDefinition: (cwd: string) =>
			withoutRenderers(actual.createWriteToolDefinition(cwd), "write"),
	};
});

function registeredTool(pi: FakePi, name: string): ToolDefinition {
	createActionFusionExtension()(pi.asExtensionApi() as ExtensionAPI);
	return pi.tool(name);
}

function approvalOf(tool: ToolDefinition): (args: unknown) => unknown {
	const approval = (tool as { approval?: unknown }).approval;
	if (typeof approval !== "function") throw new Error("fused tool declares no approval");
	return approval as (args: unknown) => unknown;
}

describe("fused tool approval tiers", () => {
	it("resolves a then_run call to the exec tier", () => {
		const edit = registeredTool(new FakePi(), "edit");

		expect(approvalOf(edit)({ path: "a.ts", then_run: { command: "npm test" } })).toBe("exec");
	});

	it("delegates a plain call to the built-in's own approval", () => {
		const edit = registeredTool(new FakePi(), "edit");
		const write = registeredTool(new FakePi(), "write");

		expect(approvalOf(edit)({ path: "a.ts", old_string: "x", new_string: "y" })).toBe("write");
		expect(approvalOf(write)({ path: "a.ts", content: "x" })).toBe("write");
	});

	it("still resolves a fused write carrying then_run to exec", () => {
		const write = registeredTool(new FakePi(), "write");

		expect(approvalOf(write)({ path: "a.ts", content: "x", then_run: { command: "node a.ts" } })).toBe("exec");
	});
});

describe("fused tool result merging", () => {
	it("asks the host to replace each fused call row with its result row", () => {
		const pi = new FakePi();
		createActionFusionExtension()(pi.asExtensionApi() as ExtensionAPI);

		expect((pi.tool("edit") as { mergeCallAndResult?: unknown }).mergeCallAndResult).toBe(true);
		expect((pi.tool("write") as { mergeCallAndResult?: unknown }).mergeCallAndResult).toBe(true);
	});
});

describe("fused call preview without a host renderer", () => {
	it("draws the write preview from the call arguments", () => {
		const write = registeredTool(new FakePi(), "write");
		const args = { path: "src/app.ts", content: "first\nsecond\nthird" };

		const text = componentText(
			write.renderCall?.(args, plainTheme, { cwd: process.cwd(), args } as never) as never,
		);

		expect(text).toContain("write src/app.ts · 3 lines");
		expect(text).toContain("1 first");
		expect(text).toContain("3 third");
	});

	it("draws the edit preview as removed and added lines with the follow-up command", () => {
		const edit = registeredTool(new FakePi(), "edit");
		const args = {
			path: "src/app.ts",
			old_string: "const a = 1;",
			new_string: "const a = 2;",
			then_run: { command: "npm run build" },
		};

		const text = componentText(edit.renderCall?.(args, plainTheme, { cwd: process.cwd(), args } as never) as never);

		expect(text).toContain("edit src/app.ts · 1 edit");
		expect(text).toContain("- const a = 1;");
		expect(text).toContain("+ const a = 2;");
		expect(text).toContain("→ npm run build");
	});

	it("previews a hashline patch from its patch text", () => {
		const edit = registeredTool(new FakePi(), "edit");
		const args = { input: "[a.ts#1A2B]\nPUT 1.=1:\n+rewritten" };

		const text = componentText(edit.renderCall?.(args, plainTheme, { cwd: process.cwd(), args } as never) as never);

		expect(text).toContain("PUT 1.=1:");
	});
});
