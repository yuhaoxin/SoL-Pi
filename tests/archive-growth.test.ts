/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSolPiExtension } from "../src/sol-pi/index.ts";
import {
	ARCHIVE_GROWTH_LIMITS,
	measureArchiveGrowth,
	warnIfArchiveOverLimit,
} from "../src/sol-pi/archive-growth.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

const TIGHT_LIMITS = { maxObjects: 2, maxBytes: 1_000 };

async function makeArchiveTree(): Promise<{ dir: string; solPiDir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "sol-pi-archive-growth-"));
	const solPiDir = join(dir, "sol-pi");
	const observations = join(solPiDir, "session-old", "observation-pack", "objects");
	const reducerObjects = join(solPiDir, "session-new", "evidence-preserving-reducer", "objects", "ab");
	await mkdir(observations, { recursive: true });
	await mkdir(reducerObjects, { recursive: true });
	await writeFile(join(observations, "obs_aaaaaaaaaaaaaaaaaaaaaaaa.txt"), "x".repeat(200));
	await writeFile(join(observations, "obs_bbbbbbbbbbbbbbbbbbbbbbbb.txt"), "y".repeat(300));
	await writeFile(join(reducerObjects, "abc123.txt"), "z".repeat(400));
	// Ledgers and journals sit next to the objects but are not archived payloads.
	await writeFile(join(solPiDir, "session-old", "observation-pack", "ledger.jsonl"), "{}\n".repeat(50));
	return { dir, solPiDir };
}

describe("archive growth measurement", () => {
	it("counts only archived objects across every session of the project", async () => {
		const { solPiDir } = await makeArchiveTree();
		const growth = await measureArchiveGrowth(solPiDir);
		expect(growth).toEqual({ objects: 3, bytes: 900, truncated: false });
	});

	it("returns zeros for a project without archives", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sol-pi-archive-growth-"));
		expect(await measureArchiveGrowth(join(dir, "sol-pi"))).toEqual({ objects: 0, bytes: 0, truncated: false });
	});

	it("reports truncation once the visit cap is hit", async () => {
		const { solPiDir } = await makeArchiveTree();
		const growth = await measureArchiveGrowth(solPiDir, 2);
		expect(growth.truncated).toBe(true);
	});
});

describe("archive growth warning", () => {
	it("notifies when the project archives exceed a limit", async () => {
		const { dir } = await makeArchiveTree();
		const manager = new FakeSessionManager([], "session-a", dir);
		const notifications: { message: string; level: string }[] = [];
		const context = fakeContext(manager, {
			hasUI: true,
			ui: {
				notify: (message: string, level: string) => {
					notifications.push({ message, level });
				},
			},
		} as unknown as Partial<ExtensionContext>);

		await warnIfArchiveOverLimit(context, TIGHT_LIMITS);

		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.level).toBe("warning");
		expect(notifications[0]?.message).toContain("3 objects");
		expect(notifications[0]?.message).toContain("900 B");
	});

	it("stays quiet while the archives are within the limits", async () => {
		const { dir } = await makeArchiveTree();
		const manager = new FakeSessionManager([], "session-a", dir);
		const notifications: string[] = [];
		const context = fakeContext(manager, {
			hasUI: true,
			ui: {
				notify: (message: string) => {
					notifications.push(message);
				},
			},
		} as unknown as Partial<ExtensionContext>);

		await warnIfArchiveOverLimit(context);

		expect(notifications).toEqual([]);
	});

	it("warns on stderr when the session has no UI", async () => {
		const { dir } = await makeArchiveTree();
		const manager = new FakeSessionManager([], "session-a", dir);
		const context = fakeContext(manager);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

		await warnIfArchiveOverLimit(context, TIGHT_LIMITS);

		expect(error).toHaveBeenCalledOnce();
		expect(error.mock.calls[0]?.[0]).toContain("3 objects");
		error.mockRestore();
	});

	it("runs from the session_start wiring of the packaged extension", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sol-pi-archive-growth-"));
		const objects = join(dir, "sol-pi", "session-old", "observation-pack", "objects");
		await mkdir(objects, { recursive: true });
		await Promise.all(
			Array.from({ length: ARCHIVE_GROWTH_LIMITS.maxObjects + 1 }, (_, index) =>
				writeFile(join(objects, `obs_${String(index).padStart(24, "0")}.txt`), "x"),
			),
		);
		const manager = new FakeSessionManager([], "session-a", dir);
		const pi = new FakePi(manager);
		createSolPiExtension()(pi.asExtensionApi());
		const notifications: { message: string; level: string }[] = [];
		const context = fakeContext(manager, {
			hasUI: true,
			ui: {
				notify: (message: string, level: string) => {
					notifications.push({ message, level });
				},
			},
		} as unknown as Partial<ExtensionContext>);

		await pi.emit("session_start", { type: "session_start" }, context);

		await vi.waitFor(() => expect(notifications).toHaveLength(1));
		expect(notifications[0]?.level).toBe("warning");
		expect(notifications[0]?.message).toContain(`${ARCHIVE_GROWTH_LIMITS.maxObjects + 1} objects`);
	});
});
