/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveCallRender, resolveResultRender, withApproval } from "../../host-compat.ts";
import { decorateWithSolPi, renderThemedLine } from "../../tui.ts";
import { PLAN_STATUSES, type PlanStep } from "./plan.ts";

const COMPACT_CONDITION = "compacts only when projected savings are positive";

const UPDATE_PLAN_DESCRIPTION =
	"Replace the complete working plan. A newly completed step becomes a safe point where SoL-Pi may compact context if doing so is economical.";
/** Pi renders these as the tool's guidelines; hosts that drop that field get them appended instead. */
const UPDATE_PLAN_GUIDANCE = [
	"Send the complete plan on every update_plan call.",
	"Keep at most one step in_progress and mark finished steps completed.",
	"When completing a step, include concise progress evidence when available.",
];

export interface OnlineToolsOptions {
	/** Whether the host renders `promptGuidelines`; see `rendersToolPromptMetadata`. */
	readonly toolPromptMetadata?: boolean;
}

export type PlanProgress = {
	readonly files_changed: readonly string[];
	readonly verification: readonly string[];
	readonly decisions: readonly string[];
};

export type PlanUpdateInput = {
	readonly toolCallId: string;
	readonly steps: readonly PlanStep[];
	readonly progress: PlanProgress | undefined;
	readonly signal: AbortSignal | undefined;
	readonly context: ExtensionContext;
};

export type OnlineToolHandlers = {
	readonly updatePlan: (input: PlanUpdateInput) => Promise<AgentToolResult<Readonly<Record<string, unknown>>>>;
};

const progressSchema = Type.Object(
	{
		files_changed: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 128 }),
		verification: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 64 }),
		decisions: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 64 }),
	},
	{ additionalProperties: false },
);

const planStepSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 16_384 }),
		goal: Type.String({ minLength: 1, maxLength: 16_384 }),
		status: Type.Union(PLAN_STATUSES.map((status) => Type.Literal(status))),
	},
	{ additionalProperties: false },
);

export function registerOnlineTools(
	pi: ExtensionAPI,
	handlers: OnlineToolHandlers,
	options: OnlineToolsOptions = {},
): void {
	const promptMetadata = options.toolPromptMetadata ?? true;
	const updatePlanParameters = Type.Object(
		{
			steps: Type.Array(planStepSchema, { minItems: 1, maxItems: 128 }),
			progress: Type.Optional(progressSchema),
		},
		{ additionalProperties: false },
	);
	// Writes only session plan state; omp would otherwise default the tool to exec tier.
	const updatePlanTool: ToolDefinition<typeof updatePlanParameters> = {
		name: "update_plan",
		label: "Update plan",
		description: promptMetadata
			? UPDATE_PLAN_DESCRIPTION
			: `${UPDATE_PLAN_DESCRIPTION} ${UPDATE_PLAN_GUIDANCE.join(" ")}`,
		promptSnippet: "Keep the working plan current",
		promptGuidelines: UPDATE_PLAN_GUIDANCE,
		renderShell: "self",
		parameters: updatePlanParameters,
		executionMode: "sequential",
		execute: async (toolCallId, params, signal, _onUpdate, context) =>
			await handlers.updatePlan({
				toolCallId,
				steps: params.steps,
				progress: params.progress,
				signal,
				context,
			}),
		renderCall(params, second, third) {
			const view = resolveCallRender(second, third, params);
			const completed = params.steps.filter((step) => step.status === "completed").length;
			return decorateWithSolPi(
				view.theme,
				"Online Context Compact",
				COMPACT_CONDITION,
				renderThemedLine(view.theme, "dim", `Plan: ${params.steps.length} steps, ${completed} completed`),
			);
		},
		renderResult(result, options, themeArgument, contextArgument) {
			const view = resolveResultRender(themeArgument, contextArgument, {});
			const boundary = (result.details as { boundary?: boolean } | undefined)?.boundary === true;
			const isPartial = (options as { isPartial?: boolean }).isPartial === true;
			return decorateWithSolPi(
				view.theme,
				"Online Context Compact",
				COMPACT_CONDITION,
				renderThemedLine(
					view.theme,
					isPartial ? "warning" : "dim",
					isPartial ? "Updating plan..." : boundary ? "Progress boundary recorded" : "Plan recorded",
				),
			);
		},
	};
	pi.registerTool(withApproval(updatePlanTool, "write"));
}
