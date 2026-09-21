/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Action Fusion - fuse a file mutation and its follow-up command into one turn.
 *
 * Base pi rollouts repeatedly showed the same pair of turns: edit or write a
 * file, then run a command to test, build, or start it. This extension replaces
 * the built-in `edit` and `write` tools with versions that take an optional
 * `then_run` object, apply the mutation, run the command, and return one
 * combined observation. The model decision between the two turns disappears.
 *
 * Everything else about `edit` and `write` is inherited from the built-in
 * definitions: their schemas, prompt text, and renderers. Where the host
 * publishes its built-in tools (`getAllTools()`), the fused schema is that
 * host's current schema — Oh My Pi resolves the `edit` parameter shape per
 * session — and the mutation is delegated back to the built-in through
 * `ctx.invokeTool()`, so the session's edit store, device dispatch, approvals,
 * and settings all apply. Hosts without that surface run the composed
 * definitions, as before.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type BashToolOptions,
	createEditToolDefinition,
	createWriteToolDefinition,
	type EditToolDetails,
	type EditToolOptions,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	type Theme,
	type WriteToolOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import {
	type EditVariant,
	editDefinitionForVariant,
	publishedTool,
	requestedToolPath,
	sessionEditVariant,
} from "./base-tools.ts";
import { resolveToolPath } from "./file-queue.ts";
import {
	invokeBaseRenderer,
	resolveCallRender,
	resolveResultRender,
	withOptionalProperty,
	type ToolRenderView,
} from "../../host-compat.ts";
import { renderSolPiTool, renderThemedLine, showSolPiSavings } from "../../tui.ts";
import {
	createThenRunSchema,
	executeMutationThenRun,
	THEN_RUN_SUCCEEDED,
	type ThenRunInput,
} from "./then-run.ts";

const EDIT_THEN_RUN_DESCRIPTION =
	"Command to run next on this file after the edit succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the edit fails; a non-zero exit is reported but keeps the edit.";
const WRITE_THEN_RUN_DESCRIPTION =
	"Command to run next on this file after the write succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the write fails; a non-zero exit is reported but keeps the write.";

export interface ActionFusionOptions {
	/** Optional programmatic bash overrides, primarily for tests and embedded runtimes. */
	readonly bashOptions?: BashToolOptions;
	/** Overrides for the underlying built-in `edit` tool. */
	readonly editOptions?: EditToolOptions;
	/** Overrides for the underlying built-in `write` tool. */
	readonly writeOptions?: WriteToolOptions;
}

const FUSED_SAVING = "1 model round-trip avoided";

/**
 * Render one fused mutation row.
 *
 * Deferring to the host's own built-in renderer keeps the row identical to an
 * unfused edit or write, with the SoL-Pi badge added only when the call carries
 * `then_run`. Pi ships renderers for `edit`/`write`; omp ships none, so this
 * falls back to a title line when the base is missing rather than calling into a
 * renderer that does not exist.
 */
function renderFusedMutation(
	view: ToolRenderView,
	base: Component | undefined,
	name: string,
	args: Record<string, unknown>,
): Component {
	const path = typeof args.path === "string" && args.path.length > 0 ? args.path : name;
	const body = base ?? renderThemedLine(view.theme, "dim", `${name} ${path}`);
	if (args.then_run === undefined || !view.theme) return body;
	return renderSolPiTool(view.theme, "Action Fusion", FUSED_SAVING, body);
}

/**
 * Built-in tool definitions capture their cwd in closures, so keep one per
 * working directory instead of rebuilding them on every call and every redraw.
 */
function memoizeByCwd<T>(create: (cwd: string) => T): (cwd: string) => T {
	const cache = new Map<string, T>();
	return (cwd) => {
		const cached = cache.get(cwd);
		if (cached) return cached;
		const created = create(cwd);
		cache.set(cwd, created);
		return created;
	};
}

/** The shape Oh My Pi binds for a re-registered built-in; the host owns it. */
type NativeInvokeTool<TDetails> = (
	params: Record<string, unknown>,
	options?: { signal?: AbortSignal; onUpdate?: unknown },
) => Promise<AgentToolResult<TDetails>>;

/**
 * Run the built-in implementation of the tool this definition replaced.
 *
 * Oh My Pi binds a re-registered built-in to an `invokeTool` that runs the
 * native execute with the agent loop's own tool context, so the delegated call
 * keeps the session's edit store, device dispatch, approval, and settings. A
 * host without that surface runs the composed definition instead.
 */
function runBuiltin<TDetails>(
	ctx: ExtensionContext,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	composed: () => Promise<AgentToolResult<TDetails>>,
): Promise<AgentToolResult<TDetails>> {
	if (!("invokeTool" in ctx)) return composed();
	const invokeTool: unknown = ctx.invokeTool;
	if (typeof invokeTool !== "function") return composed();
	// The host binds and owns this callback; the guard above is its only check.
	const delegate = invokeTool as NativeInvokeTool<TDetails>;
	return delegate(params, { signal, onUpdate });
}

export function createActionFusionExtension(options: ActionFusionOptions = {}): ExtensionFactory {
	const baseEdit = memoizeByCwd((cwd: string) => createEditToolDefinition(cwd, options.editOptions));
	const baseWrite = memoizeByCwd((cwd: string) => createWriteToolDefinition(cwd, options.writeOptions));

	return (pi: ExtensionAPI) => {
		const editTemplate = baseEdit(process.cwd());
		const writeTemplate = baseWrite(process.cwd());
		// Read the published built-ins before registering: both registrations below
		// replace their entries, and the host resolves `edit`'s parameter shape per
		// session, so this is the only moment its schema may be readable.
		const publishedEdit = publishedTool(pi, "edit");
		const publishedWrite = publishedTool(pi, "write");

		// The host reads these properties on every request, so the session-start
		// handler below can correct the advertised shape in place once it learns
		// which variant the session resolved to; re-registering a tool after the
		// session started does not take effect.
		const advertisedEdit: { parameters: TSchema; description: string } = {
			parameters: withOptionalProperty(
				publishedEdit?.parameters ?? editTemplate.parameters,
				"then_run",
				createThenRunSchema(EDIT_THEN_RUN_DESCRIPTION),
			),
			description: publishedEdit?.description ?? editTemplate.description,
		};
		let advertisedVariant: EditVariant | undefined;

		const writeParameters = withOptionalProperty(
			publishedWrite?.parameters ?? writeTemplate.parameters,
			"then_run",
			createThenRunSchema(WRITE_THEN_RUN_DESCRIPTION),
		);

		pi.registerTool<typeof advertisedEdit.parameters, EditToolDetails | undefined>({
			...editTemplate,
			get parameters() {
				return advertisedEdit.parameters;
			},
			get description() {
				return advertisedEdit.description;
			},
			async execute(toolCallId, input, signal, onUpdate, ctx) {
				const { then_run, ...editInput } = input as typeof input & { then_run?: ThenRunInput };
				// Forwarded to the host untouched; its declared type follows the edit
				// shape the host resolved for this session.
				const params = editInput as Record<string, unknown>;
				const result = await executeMutationThenRun({
					toolCallId,
					targetPath: resolveToolPath(ctx.cwd, requestedToolPath(editInput)),
					thenRun: then_run,
					bashOptions: options.bashOptions,
					signal,
					ctx,
					mutate: () =>
						runBuiltin(ctx, params, signal, onUpdate, () =>
							baseEdit(ctx.cwd).execute(
								toolCallId,
								params as Parameters<typeof editTemplate.execute>[1],
								signal,
								onUpdate,
								ctx,
							),
						),
				});
				if (
					then_run &&
					result.content.some((block) => block.type === "text" && block.text.includes(THEN_RUN_SUCCEEDED))
				) {
					showSolPiSavings(ctx, "Action Fusion", "1 model round-trip avoided");
				}
				return result;
			},
			renderCall: (args, second, third) => {
				const view = resolveCallRender(second, third, args);
				const base = invokeBaseRenderer(baseEdit(view.cwd), "renderCall", [args, second, third]);
				return renderFusedMutation(view, base, "edit", view.args);
			},
			renderResult: (result, resultOptions, themeArg, contextArg) => {
				const view = resolveResultRender(themeArg, contextArg, {});
				const base = invokeBaseRenderer(baseEdit(view.cwd), "renderResult", [
					result,
					resultOptions,
					themeArg,
					contextArg,
				]);
				return renderFusedMutation(view, base, "edit", view.args);
			},
		});

		pi.registerTool<typeof writeParameters, undefined>({
			...writeTemplate,
			parameters: writeParameters,
			description: publishedWrite?.description ?? writeTemplate.description,
			async execute(toolCallId, input, signal, onUpdate, ctx) {
				const { then_run, ...writeInput } = input as typeof input & { then_run?: ThenRunInput };
				// Forwarded to the host untouched; its declared type follows the shape
				// the host resolved for this session.
				const params = writeInput as Record<string, unknown>;
				const result = await executeMutationThenRun({
					toolCallId,
					targetPath: resolveToolPath(ctx.cwd, requestedToolPath(writeInput)),
					thenRun: then_run,
					bashOptions: options.bashOptions,
					signal,
					ctx,
					mutate: () =>
						runBuiltin(ctx, params, signal, onUpdate, () =>
							baseWrite(ctx.cwd).execute(
								toolCallId,
								params as Parameters<typeof writeTemplate.execute>[1],
								signal,
								onUpdate,
								ctx,
							),
						),
				});
				if (
					then_run &&
					result.content.some((block) => block.type === "text" && block.text.includes(THEN_RUN_SUCCEEDED))
				) {
					showSolPiSavings(ctx, "Action Fusion", "1 model round-trip avoided");
				}
				return result;
			},
			renderCall: (args, second, third) => {
				const view = resolveCallRender(second, third, args);
				const base = invokeBaseRenderer(baseWrite(view.cwd), "renderCall", [args, second, third]);
				return renderFusedMutation(view, base, "write", view.args);
			},
			renderResult: (result, resultOptions, themeArg, contextArg) => {
				const view = resolveResultRender(themeArg, contextArg, {});
				const base = invokeBaseRenderer(baseWrite(view.cwd), "renderResult", [
					result,
					resultOptions,
					themeArg,
					contextArg,
				]);
				return renderFusedMutation(view, base, "write", view.args);
			},
		});

		// The host publishes the session's edit variant only once action methods are
		// callable, so the shape advertised above is corrected here — after loading
		// and before the first model request.
		pi.on("session_start", () => {
			const variant = sessionEditVariant(pi);
			if (variant === undefined || variant === advertisedVariant) return;
			const template = editDefinitionForVariant(process.cwd(), variant, options.editOptions);
			advertisedVariant = variant;
			advertisedEdit.parameters = withOptionalProperty(
				template.parameters,
				"then_run",
				createThenRunSchema(EDIT_THEN_RUN_DESCRIPTION),
			);
			advertisedEdit.description = template.description;
		});
	};
}

export type { ThenRunInput } from "./then-run.ts";
export {
	assertUnchangedBeforeCommand,
	executeMutationThenRun,
	THEN_RUN_FAILED,
	THEN_RUN_SKIPPED,
	THEN_RUN_SUCCEEDED,
} from "./then-run.ts";

export function registerActionFusion(pi: ExtensionAPI): void {
	createActionFusionExtension()(pi);
}

export default registerActionFusion;
