/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Host differences between upstream Pi and Oh My Pi (omp).
 *
 * omp runs Pi extensions through a compatibility layer and exposes the same
 * entry points, but four surfaces differ in ways that change behavior silently
 * when they are assumed:
 *
 * - `ExtensionContext.compact` is callback-only and returns `void` on Pi. omp
 *   returns a promise that settles after the summary is committed, reads the
 *   summarizer guidance under `internalGuidance` instead of
 *   `customInstructions`, and can suppress the resume it would otherwise run
 *   for a turn the compaction interrupted.
 * - Built-in tool parameter schemas are TypeBox objects with a `properties`
 *   map on Pi. omp's built-ins expose callable omptype schemas whose document
 *   is reachable only through `toJsonSchema()`.
 * - Pi calls `renderCall(args, theme, context)` and
 *   `renderResult(result, options, theme, context)`; omp calls
 *   `renderCall(args, options, theme)` and
 *   `renderResult(result, options, theme, args)`.
 * - omp adds managed timers (`setTimeout`/`setInterval`/`clearTimer`) to
 *   `ExtensionContext`; Pi 0.85.1 has none. They are the only host-provided way
 *   to run work after a handler returns while keeping the session alive when
 *   that work throws, which boundary compaction scheduled from `turn_end` needs.
 *
 * These helpers inspect the values the host actually passed instead of asking
 * which host is running, so an unknown future host keeps working as long as it
 * follows one of the two shapes.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";

/** The part of `CompactionResult` that this module reads. */
interface CompactionSummaryResult {
	readonly summary?: unknown;
}

export interface HostCompactionOptions {
	/**
	 * Summarizer guidance. Pi receives it as `customInstructions`; omp receives
	 * it as `internalGuidance`, which is its name for guidance that comes from
	 * the harness rather than from the operator.
	 */
	readonly instructions: string;
	/**
	 * omp only: suppress the automatic resume of the turn compaction interrupts.
	 * Set it when the caller dispatches its own continuation turn, so the model
	 * is not prompted twice.
	 */
	readonly suppressContinuation?: boolean;
	/** Reports the committed summary text. */
	readonly onComplete: (summary: string) => void;
	/** Reports a compaction that failed or was cancelled. */
	readonly onError: (error: Error) => void;
}

export interface ToolRenderView {
	/** Host theme, or undefined when the host renders without one. */
	readonly theme: Theme | undefined;
	/** Working directory of the tool execution. */
	readonly cwd: string;
	/** Tool-call arguments the host supplied for this render. */
	readonly args: Record<string, unknown>;
	/** True when the host passes the render context in Pi's position. */
	readonly piOrder: boolean;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** `.properties` when the host schema is a TypeBox object, otherwise undefined. */
function ownProperties(parameters: unknown): Record<string, TSchema> | undefined {
	const properties = plainObject(parameters)?.properties;
	const declared = plainObject(properties);
	return declared && Object.keys(declared).length > 0 ? (declared as Record<string, TSchema>) : undefined;
}

/** The JSON Schema document behind either host's parameter schema. */
function jsonSchemaDocument(parameters: unknown): Record<string, unknown> {
	const document = plainObject(parameters);
	if (document) {
		const toJsonSchema = document.toJsonSchema;
		return typeof toJsonSchema === "function" ? jsonSchemaDocument(toJsonSchema.call(document)) : document;
	}
	if (typeof parameters === "function") {
		const toJsonSchema = (parameters as { toJsonSchema?: unknown }).toJsonSchema;
		if (typeof toJsonSchema === "function") return jsonSchemaDocument(toJsonSchema.call(parameters));
	}
	return {};
}

/**
 * Add one optional property to a built-in tool's parameter schema.
 *
 * Pi's built-ins use TypeBox schemas, so their property nodes already carry the
 * required/optional marks and can be spread into a new `Type.Object` unchanged.
 * omp's built-ins have no `properties` map, and spreading `undefined` there
 * yields an object schema containing only the added property: the fused `edit`
 * and `write` tools reached the model with no `path` or `content`, so every file
 * mutation failed. The omp path rebuilds each property from the JSON Schema
 * document and marks a property optional exactly when the document does not
 * require it.
 *
 * The declared type is the base schema's, so callers keep the host tool's
 * parameter inference; the added property exists at runtime and is read through
 * the input cast in each tool's `execute`.
 */
export function withOptionalProperty<TParams extends TSchema>(
	baseParameters: TParams,
	key: string,
	value: TSchema,
): TParams {
	const properties = ownProperties(baseParameters);
	if (properties) return Type.Object({ ...properties, [key]: value }) as unknown as TParams;

	const document = jsonSchemaDocument(baseParameters);
	const declared = plainObject(document.properties) ?? {};
	const required = new Set(Array.isArray(document.required) ? document.required : []);
	const merged: Record<string, TSchema> = {};
	for (const [name, node] of Object.entries(declared)) {
		const property = Type.Unsafe(node as Record<string, unknown>) as TSchema;
		merged[name] = required.has(name) ? property : (Type.Optional(property) as TSchema);
	}
	merged[key] = value;
	const strict = document.additionalProperties;
	const options = typeof strict === "boolean" ? ({ additionalProperties: strict } as never) : undefined;
	return Type.Object(merged, options) as unknown as TParams;
}

function themeLike(value: unknown): Theme | undefined {
	const candidate = plainObject(value);
	const styling = candidate && typeof candidate.fg === "function" && typeof candidate.bold === "function";
	return styling ? (candidate as unknown as Theme) : undefined;
}

function renderView(theme: Theme | undefined, context: Record<string, unknown>, args: unknown, piOrder: boolean): ToolRenderView {
	const cwd = context.cwd;
	return {
		theme,
		cwd: typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd(),
		args: plainObject(args) ?? {},
		piOrder,
	};
}

/** Resolve `renderCall` arguments. Pi: `(args, theme, context)`; omp: `(args, options, theme)`. */
export function resolveCallRender(second: unknown, third: unknown, args: unknown): ToolRenderView {
	const piTheme = themeLike(second);
	if (piTheme) return renderView(piTheme, plainObject(third) ?? {}, args, true);
	return renderView(themeLike(third), {}, args, false);
}

/**
 * Resolve `renderResult` arguments. Both hosts pass the theme third; only the
 * fourth differs: Pi passes a render context carrying `cwd`/`args`, omp passes
 * the tool-call arguments directly.
 */
export function resolveResultRender(themeArgument: unknown, contextArgument: unknown, args: unknown): ToolRenderView {
	const theme = themeLike(themeArgument);
	const context = plainObject(contextArgument) ?? {};
	const hostArgs = plainObject(context.args) ?? plainObject(contextArgument) ?? args;
	return renderView(theme, context, hostArgs, theme !== undefined);
}

/**
 * Run a host built-in's own renderer with the arguments that host supplied.
 *
 * The built-in definition came from the host, so its renderer already matches
 * the host's signature and is forwarded verbatim. omp's built-in definitions
 * carry no renderers at all, so callers must accept `undefined` and fall back to
 * something they render themselves.
 */
export function invokeBaseRenderer(
	base: unknown,
	method: "renderCall" | "renderResult",
	args: readonly unknown[],
): Component | undefined {
	const renderer = plainObject(base)?.[method];
	if (typeof renderer !== "function") return undefined;
	return (renderer as (...callArgs: unknown[]) => Component).apply(base, args as unknown[]);
}

/**
 * Run a native compaction on either host and resolve once it settles.
 *
 * Pi's `compact()` reports through callbacks only. omp additionally returns a
 * promise that resolves after the summary is committed, and a rejection can
 * arrive there without `onError` ever running, so both signals are wired and the
 * first one to report wins.
 */
export async function compactSession(context: ExtensionContext, options: HostCompactionOptions): Promise<void> {
	let finished = false;
	let resolveSettled!: () => void;
	const settled = new Promise<void>((resolve) => {
		resolveSettled = resolve;
	});
	const finish = (): void => {
		if (finished) return;
		finished = true;
		resolveSettled();
	};
	const failure = (error: unknown): void => {
		options.onError(error instanceof Error ? error : new Error(String(error)));
		finish();
	};

	const request = {
		customInstructions: options.instructions,
		internalGuidance: options.instructions,
		onComplete: (result: CompactionSummaryResult) => {
			try {
				options.onComplete(typeof result?.summary === "string" ? result.summary : "");
			} finally {
				finish();
			}
		},
		onError: failure,
		...(options.suppressContinuation === undefined ? {} : { suppressContinuation: options.suppressContinuation }),
	};

	let returned: unknown;
	try {
		returned = (context.compact as unknown as (value: unknown) => unknown)(request);
	} catch (error) {
		failure(error);
		return;
	}
	const then = (returned as { then?: unknown } | null | undefined)?.then;
	if (typeof then !== "function") {
		await settled;
		return;
	}
	try {
		await returned;
	} catch (error) {
		failure(error);
	}
}

/**
 * The effective system prompt as one string.
 *
 * Pi returns it as a single string; omp returns the prompt's lines. Joining the
 * lines keeps token accounting identical on both hosts.
 */
export function systemPromptText(context: ExtensionContext): string {
	const prompt: unknown = context.getSystemPrompt();
	if (Array.isArray(prompt)) return prompt.join("\n");
	return typeof prompt === "string" ? prompt : "";
}

/**
 * Whether the host renders a tool's `promptSnippet` and `promptGuidelines` into
 * the system prompt.
 *
 * Pi 0.85.1 normalizes both into its prompt builder, so a tool's usage guidance
 * reaches the model there. omp declares `promptGuidelines` but never reads it and
 * has no `promptSnippet` field at all, so on such a host the same guidance has to
 * travel in the tool description instead. Managed timers are the observable host
 * marker this port already keys its other differences off.
 */
export function rendersToolPromptMetadata(context: ExtensionContext): boolean {
	return !usesManagedTimers(context);
}

export type BoundaryTrigger = "deferred" | "settle" | "unavailable";

/**
 * How this host can run a compaction decided at a plan boundary.
 *
 * - `settle`: the host stops the run and emits a settle event after the loop
 *   unwinds, so the compaction runs from that event (Pi).
 * - `deferred`: the host has managed timers and a session that outlives the run,
 *   so the compaction is scheduled off the agent loop and the host's own abort
 *   machinery interrupts the turn (omp interactive and RPC sessions).
 * - `unavailable`: neither. omp's print and JSON sessions tear down as soon as an
 *   interrupted prompt settles, which cancels the in-flight compaction and
 *   discards the rest of the run, so such a session must be left alone.
 */
export function boundaryTrigger(context: ExtensionContext): BoundaryTrigger {
	if (!usesManagedTimers(context)) return "settle";
	return context.mode === "tui" || context.mode === "rpc" ? "deferred" : "unavailable";
}

/**
 * Whether the host provides managed extension timers.
 *
 * Only such a host can run a task after the current handler returns without the
 * session treating a throw as fatal, which is what lets boundary compaction run
 * outside the agent loop's dispatch.
 */
export function usesManagedTimers(context: ExtensionContext): boolean {
	return typeof (context as unknown as { setTimeout?: unknown }).setTimeout === "function";
}

/**
 * Schedule `task` to run after the current handler returns.
 *
 * The timer is deliberately not unref'd: a compaction decided on the last turn
 * of a run must still run before the host exits, and the managed timers this
 * host offers are explicitly unref'd. A raw timer callback runs outside handler
 * dispatch, so the task is wrapped — a synchronous throw or rejected promise is
 * reported instead of becoming a process-level fatal exception. A host without
 * managed timers has no way to defer work, so this does nothing there; callers
 * decide the trigger from {@link boundaryTrigger}.
 */
export function deferOutsideHandler(context: ExtensionContext, task: () => Promise<void>): void {
	if (!usesManagedTimers(context)) return;
	setTimeout(() => {
		void (async () => {
			await task();
		})().catch((error: unknown) => {
			const reason = error instanceof Error ? error.message : String(error);
			console.error(`[sol-pi] deferred boundary task failed: ${reason}`);
		});
	}, 0);
}
