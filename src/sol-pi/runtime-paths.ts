/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu;

/**
 * The directory this extension archives session evidence under, or `undefined`
 * when the host has no persistent session directory.
 *
 * omp runs print and `--no-session` sessions without a session directory. There
 * is nothing to persist for such a session, so mechanisms that store evidence
 * skip it instead of failing the request they are handling.
 */
export function runtimeRootIfAvailable(ctx: ExtensionContext): string | undefined {
	const sessionDir = ctx.sessionManager.getSessionDir();
	if (!sessionDir) return undefined;
	const sessionId = ctx.sessionManager.getSessionId();
	if (!SESSION_ID_PATTERN.test(sessionId)) {
		throw new Error("SoL-Pi requires a safe Pi session id");
	}
	return join(sessionDir, "sol-pi", sessionId);
}

/**
 * The directory this extension archives session evidence under.
 *
 * @throws when the session has no persistent directory, or when its id could
 * escape the session directory. Callers that must not fail the work they are
 * handling use {@link runtimeRootIfAvailable} instead.
 */
export function runtimeRoot(ctx: ExtensionContext): string {
	const root = runtimeRootIfAvailable(ctx);
	if (!root) throw new Error("SoL-Pi requires a persistent Pi session directory");
	return root;
}
