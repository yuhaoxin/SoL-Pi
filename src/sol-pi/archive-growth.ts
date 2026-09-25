/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { readdir, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runtimeRootIfAvailable } from "./runtime-paths.ts";

export interface ArchiveGrowthLimits {
	readonly maxObjects: number;
	readonly maxBytes: number;
}

/**
 * Archived evidence is never deleted automatically: the limits trip only when
 * a project accumulated far more than a busy session produces, so the warning
 * means "clean up by hand", not "the mechanism misbehaved".
 */
export const ARCHIVE_GROWTH_LIMITS: ArchiveGrowthLimits = Object.freeze({
	maxObjects: 1_024,
	maxBytes: 256 * 1024 * 1024,
});

const DEFAULT_MAX_VISITED = 100_000;

export interface ArchiveGrowth {
	readonly objects: number;
	readonly bytes: number;
	readonly truncated: boolean;
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/u, "")} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/u, "")} KiB`;
	return `${bytes} B`;
}

/**
 * Count archived payload objects under a project's shared `sol-pi` directory.
 *
 * The directory aggregates every session of the project (`sol-pi/<sessionId>`),
 * so the measurement covers evidence left behind by earlier sessions, not just
 * the active one. Only files below an `objects` directory count; ledgers and
 * journals are small and stay out. Missing directories read as empty, and
 * symlinks are never followed.
 */
export async function measureArchiveGrowth(
	root: string,
	maxVisited: number = DEFAULT_MAX_VISITED,
): Promise<ArchiveGrowth> {
	let objects = 0;
	let bytes = 0;
	let visited = 0;
	const stack: { dir: string; inObjects: boolean }[] = [{ dir: root, inObjects: false }];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) break;
		let entries;
		try {
			entries = await readdir(current.dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (visited >= maxVisited) return { objects, bytes, truncated: true };
			visited++;
			const path = join(current.dir, entry.name);
			if (entry.isDirectory()) {
				stack.push({ dir: path, inObjects: current.inObjects || entry.name === "objects" });
				continue;
			}
			if (!entry.isFile() || !current.inObjects) continue;
			try {
				const info = await stat(path);
				objects++;
				bytes += info.size;
			} catch {
				// The object vanished between readdir and stat; it is gone either way.
			}
		}
	}
	return { objects, bytes, truncated: false };
}

/**
 * Warn once per session start when the project's archived evidence exceeds
 * `limits`. The check never deletes anything: reclaiming space is a manual
 * call because archived observations and reducer payloads may still be
 * referenced by placeholders and receipts in live sessions.
 */
export async function warnIfArchiveOverLimit(
	context: ExtensionContext,
	limits: ArchiveGrowthLimits = ARCHIVE_GROWTH_LIMITS,
): Promise<void> {
	let solPiDir: string;
	try {
		const root = runtimeRootIfAvailable(context);
		if (!root) return;
		solPiDir = dirname(root);
	} catch (error) {
		// An unusable runtime root (e.g. an unsafe session id) must be visible,
		// not silent, but must not fail the session start it rides on.
		console.error(`[sol-pi] archive growth check skipped: ${String(error)}`);
		return;
	}
	const growth = await measureArchiveGrowth(solPiDir);
	if (growth.objects <= limits.maxObjects && growth.bytes <= limits.maxBytes) return;
	const size = growth.truncated ? `at least ${formatBytes(growth.bytes)}` : formatBytes(growth.bytes);
	const message =
		`SoL-Pi session archives under ${solPiDir}${sep}… hold ${growth.objects} objects totaling ${size}, ` +
		`over the limit of ${limits.maxObjects} objects / ${formatBytes(limits.maxBytes)}. ` +
		"SoL-Pi never deletes archived evidence automatically; remove old session directories there to reclaim space.";
	if (context.hasUI) context.ui.notify(message, "warning");
	else console.error(message);
}
