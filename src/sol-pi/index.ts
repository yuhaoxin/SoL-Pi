/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { warnIfArchiveOverLimit } from "./archive-growth.ts";
import { loadSolPiConfig, type SolPiConfig } from "./config.ts";
import { rendersToolPromptMetadata } from "./host-compat.ts";
import { registerActionFusion } from "./extensions/action-fusion/index.ts";
import { registerEvidencePreservingReducer } from "./extensions/evidence-preserving-reducer/index.ts";
import { registerObservationPack } from "./extensions/observation-pack/index.ts";
import { registerOnlineContextCompact } from "./extensions/online-context-compact/index.ts";

export interface HostFeatures {
	/** Whether the host renders `promptSnippet`/`promptGuidelines`; see `rendersToolPromptMetadata`. */
	readonly toolPromptMetadata: boolean;
}

/** What Pi 0.85.1 provides, used when a caller has no host context of its own. */
export const PI_HOST_FEATURES: HostFeatures = Object.freeze({ toolPromptMetadata: true });

export function registerConfiguredFeatures(
	pi: ExtensionAPI,
	config: SolPiConfig,
	host: HostFeatures = PI_HOST_FEATURES,
): void {
	if (config.actionFusion) registerActionFusion(pi);
	if (config.observationPack) registerObservationPack(pi, host);
	if (config.evidencePreservingReducer) {
		registerEvidencePreservingReducer(pi, {
			reducerModel: config.evidencePreservingReducerModel,
			reducerProvider: config.evidencePreservingReducerProvider,
		});
	}
	if (config.onlineContextCompact) registerOnlineContextCompact(pi, config.cacheWriteReadRatio, host);
}

export type SolPiConfigLoader = (ctx: ExtensionContext) => SolPiConfig;

export function createSolPiExtension(
	loadConfig: SolPiConfigLoader = (ctx) => loadSolPiConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted()),
): ExtensionFactory {
	return (pi) => {
		let initialized = false;
		pi.on("session_start", (_event, ctx) => {
			if (initialized) return;
			initialized = true;
			registerConfiguredFeatures(pi, loadConfig(ctx), {
				toolPromptMetadata: rendersToolPromptMetadata(ctx),
			});
			void warnIfArchiveOverLimit(ctx);
		});
	};
}

export default function solPiExtension(pi: ExtensionAPI): void {
	createSolPiExtension()(pi);
}
