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
 * The session's variant is therefore read from the host after loading: from the
 * built-in `edit` schema while the host still publishes it, and otherwise from
 * the `read` tool, which SoL-Pi never replaces and whose description is rendered
 * from the same edit-mode resolution.
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
 * Matches the patch-language anchor the `read` tool advertises in its
 * description (`[foo.ts#1A2B]` snapshot header) and never in the other variants.
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

function asPublishedTool(entry: PublishedToolEntry): PublishedTool | undefined {
	const parameters = entry.parameters;
	if (typeof parameters !== "function" && (typeof parameters !== "object" || parameters === null)) return undefined;
	const description = typeof entry.description === "string" && entry.description.length > 0 ? entry.description : undefined;
	return { description, parameters: parameters as TSchema };
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
	return match === undefined ? undefined : asPublishedTool(match);
}

/**
 * The host's published definition for `name` while the host still marks it as a
 * built-in, which holds only until SoL-Pi's replacement takes effect.
 */
function publishedBuiltinTool(pi: ExtensionAPI, name: string): PublishedTool | undefined {
	const match = publishedEntries(pi).find(
		(entry) => entry.name === name && entry.sourceInfo?.source === "builtin",
	);
	return match === undefined ? undefined : asPublishedTool(match);
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
 * The model families whose editing support the host downgrades from the patch
 * language to single-file replacement. The downgrade itself stays the host's
 * decision; this only states which models it applies to, so the fused schema
 * can match the schema the host will accept. A pinned `PI_EDIT_VARIANT` or a
 * host that reports its own variant makes this rule unnecessary.
 */
const DOWNGRADED_EDIT_MODEL_RE =
	/(^|[/-])(kimi|mimo|minimax|deepseek|stepfun)([/-]|$)|codex-spark|glm[^/]*?flash[^/]*?5\.3|glm[^/]*?5\.3[^/]*?flash/iu;

/** The parts of a host model this module reads. */
export interface ActiveModelLike {
	readonly provider?: unknown;
	readonly id?: unknown;
}

function downgradedEditModel(model: ActiveModelLike | undefined): boolean {
	const provider = typeof model?.provider === "string" ? model.provider : "";
	const id = typeof model?.id === "string" ? model.id : "";
	if (provider.length === 0 && id.length === 0) return false;
	return DOWNGRADED_EDIT_MODEL_RE.test(`${provider}/${id}`);
}

/**
 * Which edit parameter variant the session uses.
 *
 * `PI_EDIT_VARIANT`, when set, decides outright, because the host honors it
 * above its own resolution. Otherwise the built-in `edit` schema answers while
 * the host still publishes it, and after that the active model does, because the
 * host resolves the variant from the model. The `read` tool's description is the
 * last resort: the host renders it once when it builds its tools, so it reports
 * the variant that was active then, not the current one.
 *
 * `undefined` means nothing could answer yet, and callers keep the variant they
 * already advertise.
 */
export function sessionEditVariant(pi: ExtensionAPI, model?: ActiveModelLike): EditVariant | undefined {
	const pinned = process.env[EDIT_VARIANT_ENV];
	if (pinned === "hashline" || pinned === "replace") return pinned;

	const builtInEdit = publishedBuiltinTool(pi, "edit");
	if (builtInEdit !== undefined) {
		const properties = schemaPropertyNames(builtInEdit.parameters);
		if (properties.includes("input")) return "hashline";
		if (properties.includes("path")) return "replace";
	}

	if (model !== undefined && (typeof model.provider === "string" || typeof model.id === "string")) {
		return downgradedEditModel(model) ? "replace" : "hashline";
	}

	const read = publishedTool(pi, "read");
	if (read?.description === undefined) return undefined;
	return HASHLINE_ANCHOR_RE.test(read.description) ? "hashline" : "replace";
}

/** The `properties` names behind any published parameter schema shape. */
function schemaPropertyNames(parameters: unknown): string[] {
	const document = schemaDocument(parameters);
	if (document === undefined) return [];
	const properties: unknown = Reflect.get(document, "properties");
	return typeof properties === "object" && properties !== null ? Object.keys(properties) : [];
}

/**
 * The JSON Schema document behind a published parameter schema: a schema that
 * already carries a `properties` map, or a callable schema whose document only
 * `toJsonSchema()` exposes.
 */
function schemaDocument(parameters: unknown): object | undefined {
	if (typeof parameters === "function") {
		const toJsonSchema: unknown = Reflect.get(parameters, "toJsonSchema");
		return typeof toJsonSchema === "function" ? (toJsonSchema.call(parameters) as object) : undefined;
	}
	if (typeof parameters !== "object" || parameters === null) return undefined;
	const direct: unknown = Reflect.get(parameters, "properties");
	if (typeof direct === "object" && direct !== null) return parameters;
	const toJsonSchema: unknown = Reflect.get(parameters, "toJsonSchema");
	return typeof toJsonSchema === "function" ? (toJsonSchema.call(parameters) as object) : undefined;
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
