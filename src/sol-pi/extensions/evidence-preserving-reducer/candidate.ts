/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
	type FullOutputArtifacts,
	fullOutputArtifactId,
	readFullOutputArtifact,
} from "../../full-output.ts";
import { recordValue } from "./config.ts";

/** Markers written by the action-fusion extension around a fused command's output. */
const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
const THEN_RUN_FAILED = "[then_run:failed]";

export interface ReducibleToolResult {
	readonly command: string;
	readonly body: string;
	/**
	 * The host truncated the inline result and the full bytes could not be
	 * recovered, so `body` is only a preview. Reducing it would check evidence
	 * against bytes the command never produced as a whole, so callers must skip
	 * the result instead.
	 */
	readonly fullOutputMissing?: boolean;
	/** Put the receipt back where the raw output was, leaving the rest of the result alone. */
	readonly projectReceipt: (receipt: string) => ToolResultEvent["content"];
}

function textContent(event: ToolResultEvent): string {
	return event.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

export function detailsFullOutputPath(details: unknown): string | undefined {
	const value = recordValue(details, "fullOutputPath");
	return typeof value === "string" ? value : undefined;
}

async function safePiBashTempPath(path: string | undefined): Promise<boolean> {
	if (!path || !/^pi-bash-[^/\\]+\.log$/u.test(basename(path))) return false;
	try {
		const [candidate, root, status] = await Promise.all([realpath(path), realpath(tmpdir()), lstat(path)]);
		return status.isFile() && !status.isSymbolicLink() && dirname(candidate) === root;
	} catch {
		return false;
	}
}
interface ExactBody {
	readonly body: string;
	readonly fullOutputMissing: boolean;
}

/** The artifact id omp's truncation metadata carries (`details.meta.truncation`). */
function truncationArtifactId(details: unknown): string | undefined {
	const truncation = recordValue(recordValue(details, "meta"), "truncation");
	const id = recordValue(truncation, "artifactId");
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Recover the exact bytes the command produced rather than the preview the
 * result carries. Pi writes large bash output to a `pi-bash-*.log` temp file;
 * omp stores it as a session artifact and inlines only a truncation notice. An
 * omp result whose artifact cannot be read is marked `fullOutputMissing` so the
 * caller skips it instead of checking evidence against a truncated preview.
 */
async function exactBodyFromInline(
	inline: string,
	details: unknown,
	artifacts?: FullOutputArtifacts,
): Promise<ExactBody> {
	const detailsPath = detailsFullOutputPath(details);
	const inlineMatch = inline.match(/Full output:\s*([^\]\r\n]+)/u);
	const candidate = detailsPath ?? inlineMatch?.[1]?.trim();
	if (candidate && (await safePiBashTempPath(candidate))) {
		try {
			return { body: await readFile(candidate, "utf8"), fullOutputMissing: false };
		} catch {
			return { body: inline, fullOutputMissing: false };
		}
	}
	const metaId = truncationArtifactId(details);
	const inlineId =
		metaId === undefined && typeof artifacts?.getArtifactPath === "function"
			? fullOutputArtifactId(inline)
			: undefined;
	const artifactId = metaId ?? inlineId;
	if (artifactId === undefined || artifacts === undefined) return { body: inline, fullOutputMissing: false };
	const body = await readFullOutputArtifact(artifacts, artifactId);
	return body === undefined ? { body: inline, fullOutputMissing: true } : { body, fullOutputMissing: false };
}

/**
 * Identify the log inside a tool result: either a plain bash result, or the
 * command output appended by a fused `edit`/`write` call.
 */
export async function reducibleToolResult(
	event: ToolResultEvent,
	artifacts?: FullOutputArtifacts,
): Promise<ReducibleToolResult | undefined> {
	if (event.toolName === "bash") {
		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (!command) return undefined;
		const inline = textContent(event);
		const exact = await exactBodyFromInline(inline, event.details, artifacts);
		return {
			command,
			body: exact.body,
			fullOutputMissing: exact.fullOutputMissing,
			projectReceipt: (receipt) => [{ type: "text", text: receipt }],
		};
	}
	if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
	const thenRun = recordValue(event.input, "then_run");
	const commandValue = recordValue(thenRun, "command");
	if (typeof commandValue !== "string" || !commandValue) return undefined;
	const marker = event.isError ? THEN_RUN_FAILED : THEN_RUN_SUCCEEDED;
	for (let index = 0; index < event.content.length; index++) {
		const block = event.content[index];
		if (!block || block.type !== "text") continue;
		const markerIndex = block.text.indexOf(marker);
		if (markerIndex < 0) continue;
		const suffixStart = markerIndex + marker.length;
		const suffix = block.text.slice(suffixStart);
		const separator = suffix.match(/^(?:\r?\n)+/u)?.[0] ?? "\n";
		const inline = suffix.slice(separator === "\n" && !suffix.startsWith("\n") ? 0 : separator.length);
		const exact = await exactBodyFromInline(inline, event.details, artifacts);
		return {
			command: commandValue,
			body: exact.body,
			fullOutputMissing: exact.fullOutputMissing,
			projectReceipt: (receipt) =>
				event.content.map((content, contentIndex) =>
					contentIndex === index && content.type === "text"
						? { ...content, text: `${content.text.slice(0, suffixStart)}${separator}${receipt}` }
						: content,
				),
		};
	}
	return undefined;
}
