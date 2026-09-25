/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * omp full-output artifacts: how the host exposes the original bytes of a tool
 * result it truncated or minimized inline. Shared by the evidence-preserving
 * reducer (which must verify evidence against the original) and the
 * observation pack (which must archive the original).
 */
import { lstat, readFile } from "node:fs/promises";

/**
 * How a host exposes the full bytes of a truncated tool result. omp stores them
 * as session artifacts resolvable through the session manager; Pi writes them
 * to a temp file the result names directly, which needs no host service.
 */
export interface FullOutputArtifacts {
	readonly getArtifactPath?: (artifactId: string) => Promise<string | null>;
}

/**
 * The artifact id behind omp's inline full-output notices. omp marks a
 * truncated result with `Read artifact://N for full output` and a minimized
 * one — a lossy summary the minimizer rewrote, carrying no truncation
 * metadata — with a `[raw output: artifact://N]` footer. Match each full
 * notice rather than any `artifact://` mention, so command output that merely
 * contains an artifact URL is not mistaken for a truncated result.
 */
export function fullOutputArtifactId(inline: string): string | undefined {
	const truncated = /Read artifact:\/\/([^\s)]+) for full output/u.exec(inline);
	if (truncated?.[1]) return truncated[1];
	return /\[raw output: artifact:\/\/([^\s)\]]+)\]/u.exec(inline)?.[1];
}

/**
 * Read an artifact's bytes, refusing symlinks and unreadable paths. An
 * unresolved id yields undefined so the caller keeps the inline body.
 */
export async function readFullOutputArtifact(
	artifacts: FullOutputArtifacts,
	id: string,
): Promise<string | undefined> {
	try {
		const path = await artifacts.getArtifactPath?.(id);
		if (!path) return undefined;
		const status = await lstat(path);
		if (!status.isFile() || status.isSymbolicLink()) return undefined;
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}
