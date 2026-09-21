/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const queueTails = new Map<string, Promise<void>>();

/** Any URL scheme (`xd://`, `artifact://`, `ssh://`, …), matched after `file://` is handled. */
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//iu;

function stripToolPathPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

/**
 * Resolve the single filesystem target a fused mutation names, or `undefined`
 * when the call names none.
 *
 * Hashline patches carry their targets inside the patch text and internal URLs
 * address devices or hosts rather than local files, so both return `undefined`.
 * Callers serialize on the returned path and hash-check it around the follow-up
 * command; with `undefined` they fall back to a working-directory-wide slot and
 * to the paths the mutation reports in its result details.
 */
export function resolveToolPath(cwd: string, filePath: string | undefined): string | undefined {
	if (typeof filePath !== "string") return undefined;
	const stripped = stripToolPathPrefix(filePath.trim()).trim();
	if (stripped.length === 0) return undefined;
	// Pi accepts file URLs; the queue and hash guard must use the same target.
	if (/^file:\/\//iu.test(stripped)) {
		try {
			return fileURLToPath(stripped);
		} catch {
			// An unparsable file URL names no target; the mutation tool reports it.
			return undefined;
		}
	}
	if (URL_SCHEME_RE.test(stripped)) return undefined;
	if (stripped === "~") return homedir();
	if (stripped.startsWith("~/")) return resolve(homedir(), stripped.slice(2));
	return resolve(cwd, stripped);
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

async function canonicalQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath);
	let current = resolvedPath;
	const missingSegments: string[] = [];

	while (true) {
		try {
			return resolve(await realpath(current), ...missingSegments);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			const parent = dirname(current);
			if (parent === current) return resolvedPath;
			missingSegments.unshift(basename(current));
			current = parent;
		}
	}
}

/**
 * Serialize fused operations for one canonical file path. This queue belongs
 * to SoL-Pi and intentionally does not nest Pi's built-in mutation queue.
 */
export async function withFusedFileQueue<T>(filePath: string, work: () => Promise<T>): Promise<T> {
	return withFusedQueue(await canonicalQueueKey(filePath), work);
}

/** Serialize fused operations on an already-canonical key. */
export async function withFusedQueue<T>(key: string, work: () => Promise<T>): Promise<T> {
	const previous = queueTails.get(key) ?? Promise.resolve();
	let release!: () => void;
	const owned = new Promise<void>((resolveOwned) => {
		release = resolveOwned;
	});
	const tail = previous.then(() => owned);
	queueTails.set(key, tail);

	await previous;
	try {
		return await work();
	} finally {
		release();
		if (queueTails.get(key) === tail) queueTails.delete(key);
	}
}
