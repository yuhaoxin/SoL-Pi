/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * The host resolves the built-in `edit` tool's parameter schema per session and
 * publishes every registered tool's current description and schema through
 * `ExtensionAPI.getAllTools()`.
 *
 * SoL-Pi needs both facts, and neither is available where it registers:
 *
 * - Extension loading cannot call host action methods, so `getAllTools()` is
 *   unavailable while a factory runs.
 * - Registering a tool replaces its registry entry, so once SoL-Pi registers its
 *   fused `edit`, the host's own `edit` entry is no longer published.
 *
 * What stays observable is `read`: SoL-Pi never replaces it, its description is
 * rendered from the same edit-mode resolution, and it names the hashline anchors
 * only in the `hashline` variant. Reading it from a `session_start` handler —
 * which runs after action methods become callable and before the first model
 * request — is therefore how the fused tool learns which schema to advertise.
 */

import {
	createEditToolDefinition,
	type EditToolOptions,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

/** A built-in tool's published metadata, as far as SoL-Pi reads it. */
export interface PublishedTool {
	/** Tool description the host sends to the model, if it published a non-empty one. */
	readonly description: string | undefined;
	/** Parameter schema the host currently offers for this tool. */
	readonly parameters: TSchema;
}

/** The edit parameter variants SoL-Pi can advertise. */
export type EditVariant = "hashline" | "replace";

/** The fields SoL-Pi reads from the host's published tool metadata. */
interface PublishedToolEntry {
	name?: unknown;
	description?: unknown;
	parameters?: unknown;
	sourceInfo?: { source?: unknown };
}

/** The environment switch the host honors for its edit variant. */
const EDIT_VARIANT_ENV = "PI_EDIT_VARIANT";

/**
 * Matches the hashline anchor the `read` tool advertises in its description
 * (`[foo.ts#1A2B]` snapshot header) and never in the other variants.
 */
const HASHLINE_ANCHOR_RE = /snapshot header|\[[^\]\s]*#[0-9A-Fa-f]{4}\]/u;

function publishedEntries(pi: ExtensionAPI): PublishedToolEntry[] {
	const getAllTools = (pi as unknown as { getAllTools?: unknown }).getAllTools;
	if (typeof getAllTools !== "function") return [];
	try {
		const entries = (getAllTools as () => unknown).call(pi);
		if (!Array.isArray(entries)) return [];
		// The host's published contract is `ToolInfo[]`; every field is re-checked on read.
		const published: PublishedToolEntry[] = entries as PublishedToolEntry[];
		return published;
	} catch {
		// Extension loading refuses action methods until the session starts.
		return [];
	}
}

/**
 * The host's published definition for `name`, preferring the entry the host
 * itself marks as a built-in.
 *
 * Returns `undefined` when the host publishes no tool listing, refuses the call
 * (extension loading), or has no entry for the name; callers then keep the
 * definition they compose themselves.
 */
export function publishedTool(pi: ExtensionAPI, name: string): PublishedTool | undefined {
	const entries = publishedEntries(pi);
	const builtIn = entries.find((entry) => entry.name === name && entry.sourceInfo?.source === "builtin");
	const match = builtIn ?? entries.find((entry) => entry.name === name);
	if (match === undefined) return undefined;
	const parameters = match.parameters;
	if (typeof parameters !== "function" && (typeof parameters !== "object" || parameters === null)) return undefined;
	const description = typeof match.description === "string" && match.description.length > 0 ? match.description : undefined;
	return { description, parameters: parameters as TSchema };
}

/**
 * The `path` a host tool call names, when its parameter shape has one.
 *
 * Oh My Pi's hashline `edit` carries its targets inside the patch text instead,
 * and a device call names an internal URL rather than a file, so callers treat
 * `undefined` as "no single filesystem target".
 */
export function requestedToolPath(params: object): string | undefined {
	const value: unknown = Reflect.get(params, "path");
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Which edit parameter variant the session uses.
 *
 * `PI_EDIT_VARIANT`, when set, decides outright, because the host honors it
 * above its own resolution. Otherwise the answer comes from the `read` tool's
 * published description (see the module comment). `undefined` means the host
 * could not be asked, and callers keep the variant they already advertise.
 */
export function sessionEditVariant(pi: ExtensionAPI): EditVariant | undefined {
	const pinned = process.env[EDIT_VARIANT_ENV];
	if (pinned === "hashline" || pinned === "replace") return pinned;
	const read = publishedTool(pi, "read");
	if (read?.description === undefined) return undefined;
	return HASHLINE_ANCHOR_RE.test(read.description) ? "hashline" : "replace";
}

/**
 * Build the host's own definition for one edit variant.
 *
 * The host's edit factory takes no variant argument, but its constructor reads
 * `PI_EDIT_VARIANT` first, so the switch is set for the synchronous construction
 * and restored before returning; no other code runs in that window.
 */
export function editDefinitionForVariant(cwd: string, variant: EditVariant, options?: EditToolOptions) {
	const previous = process.env[EDIT_VARIANT_ENV];
	try {
		process.env[EDIT_VARIANT_ENV] = variant;
		return createEditToolDefinition(cwd, options);
	} finally {
		if (previous === undefined) delete process.env[EDIT_VARIANT_ENV];
		else process.env[EDIT_VARIANT_ENV] = previous;
	}
}
