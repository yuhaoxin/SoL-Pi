/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type BashToolOptions, createBashToolDefinition, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withFusedFileQueue, withFusedQueue } from "./file-queue.ts";

export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
export const THEN_RUN_FAILED = "[then_run:failed]";
export const THEN_RUN_SKIPPED = "[then_run:skipped]";

export interface ThenRunInput {
	command: string;
	timeout?: number;
}

export function createThenRunSchema(description: string) {
	return Type.Optional(
		Type.Object(
			{
				command: Type.String({ description: "Bash command to run" }),
				timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
			},
			{ description },
		),
	);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Whether the follow-up command failed, read from the host's own report.
 *
 * Hosts differ: some throw for a definite non-zero exit, while others return a
 * completed result that carries `isError` — which they also set for a timeout —
 * and `details.exitCode` for a failed exit. Reading both keeps a failed command
 * from being reported as a success.
 */
export function commandFailed(result: unknown): boolean {
	if (typeof result !== "object" || result === null) return false;
	// `isError` is a host extension of the tool result type, so it is read from
	// the record rather than the vendored type.
	const record = result as Record<string, unknown>;
	if (record.isError === true) return true;
	const details = record.details;
	if (typeof details !== "object" || details === null) return false;
	const exitCode = (details as Record<string, unknown>).exitCode;
	return typeof exitCode === "number" && exitCode !== 0;
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function thenRunSkippedError(error: unknown): Error {
	return new Error(
		`${errorText(error)}\n\n${THEN_RUN_SKIPPED} The file mutation did not complete successfully; the command was not run.`,
	);
}

async function fileSha256(path: string): Promise<string> {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function assertUnchangedBeforeCommand(
	path: string,
	yieldForInterference: () => Promise<void> = () => new Promise<void>((resolve) => setImmediate(resolve)),
): Promise<void> {
	try {
		const mutationHash = await fileSha256(path);
		await yieldForInterference();
		const commandHash = await fileSha256(path);
		if (mutationHash !== commandHash) {
			throw new Error("target content changed after the fused mutation");
		}
	} catch (error) {
		throw new Error(`${THEN_RUN_SKIPPED} ${errorText(error)}; the command was not run.`);
	}
}

/**
 * Absolute paths the mutation reported in its result details: `path` for a
 * single-file result and `perFileResults[].path` for a multi-file one, which is
 * how a hashline patch that spans files reports its targets.
 */
function mutatedPaths(details: unknown): string[] {
	if (typeof details !== "object" || details === null) return [];
	const record = details as Record<string, unknown>;
	const paths = new Set<string>();
	if (typeof record.path === "string" && record.path.length > 0) paths.add(record.path);
	if (Array.isArray(record.perFileResults)) {
		for (const entry of record.perFileResults) {
			const entryPath =
				typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).path : undefined;
			if (typeof entryPath === "string" && entryPath.length > 0) paths.add(entryPath);
		}
	}
	return [...paths];
}

/**
 * Files whose content the follow-up command must not race: what the mutation
 * reported, or the called target when the host reported none. A call that names
 * no file and reports none (a device write) leaves the command unchecked.
 */
function guardedPaths(details: unknown, targetPath: string | undefined): string[] {
	const reported = mutatedPaths(details);
	if (reported.length > 0) return reported;
	return targetPath === undefined ? [] : [targetPath];
}

/**
 * Apply a file mutation and, when the model asked for one, run its follow-up
 * command before returning a single observation.
 *
 * Both steps run inside one SoL-Pi queue slot, so another fused mutation of the
 * same target cannot interleave. The slot is keyed by `targetPath`; a call that
 * names no single file — a hashline patch, or a device write — takes a working
 * directory wide slot instead, because its target list is only known once the
 * mutation reports it. Pi's built-in mutation tool keeps its own queue; the two
 * queues are not nested.
 */
export async function executeMutationThenRun<TDetails>({
	toolCallId,
	targetPath,
	thenRun,
	mutate,
	bashOptions,
	signal,
	ctx,
}: {
	toolCallId: string;
	targetPath: string | undefined;
	thenRun: ThenRunInput | undefined;
	mutate: () => Promise<AgentToolResult<TDetails>>;
	bashOptions: BashToolOptions | undefined;
	signal: AbortSignal | undefined;
	ctx: ExtensionContext;
}): Promise<AgentToolResult<TDetails>> {
	const fused = async (): Promise<AgentToolResult<TDetails>> => {
		let mutationResult: AgentToolResult<TDetails>;
		try {
			mutationResult = await mutate();
		} catch (error) {
			if (thenRun !== undefined) {
				throw thenRunSkippedError(error);
			}
			throw error;
		}

		if (thenRun === undefined) {
			return mutationResult;
		}

		for (const path of guardedPaths(mutationResult.details, targetPath)) {
			await assertUnchangedBeforeCommand(path);
		}
		const bash = createBashToolDefinition(ctx.cwd, bashOptions);
		try {
			const bashResult = await bash.execute(`${toolCallId}:then_run`, thenRun, signal, undefined, ctx);
			const output = resultText(bashResult);
			const failed = commandFailed(bashResult);
			const status = failed ? THEN_RUN_FAILED : THEN_RUN_SUCCEEDED;
			return {
				...mutationResult,
				...(failed ? { isError: true } : {}),
				content: [...mutationResult.content, { type: "text", text: output ? `${status}\n${output}` : status }],
			};
		} catch (error) {
			const mutationOutput = resultText(mutationResult);
			throw new Error([mutationOutput, THEN_RUN_FAILED, errorText(error)].filter(Boolean).join("\n\n"));
		}
	};

	return targetPath === undefined
		? withFusedQueue(`${ctx.cwd}\u0000fused`, fused)
		: withFusedFileQueue(targetPath, fused);
}
