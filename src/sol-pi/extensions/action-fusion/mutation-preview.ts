/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Preview of a fused mutation call for hosts that render built-ins themselves.
 *
 * Oh My Pi draws the built-in `edit`/`write` rows from a table keyed by tool
 * name, and stops using that table for any name an extension replaced: replacing
 * a built-in clears its provenance flag, and the row falls back to a generic
 * argument dump. The host exposes neither its renderer nor a way to keep the
 * flag, so the fused definition draws the argument-derived preview itself and
 * leaves the card frame and the theme to the host.
 *
 * The outcome row ({@link previewMutationResult}) is part of that preview: the
 * host draws no built-in result for a replaced name, so a rejected call would
 * otherwise be indistinguishable from a successful one.
 *
 * Pi attaches a renderer to its built-in definitions, so this module is unused
 * there.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

/** Content lines shown before the preview counts the rest. */
const PREVIEW_LINES = 6;
/** Removed and added lines shown per edit. */
const EDIT_LINES = 4;
/** Edits shown before the preview counts the rest. */
const EDIT_PREVIEW = 2;
/** Longest preview line kept before its middle is elided. */
const MAX_LINE_WIDTH = 120;
/** Result lines shown before the outcome row counts the rest. */
const RESULT_PREVIEW_LINES = 12;

interface PreviewLine {
	readonly color: ThemeColor;
	readonly text: string;
}

/** Fields the outcome row reads from a tool result. */
export interface MutationResultLike {
	readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
	readonly isError?: boolean;
}

/** Fields the preview reads from a call, in every parameter variant. */
interface PreviewArgs {
	readonly path?: unknown;
	readonly content?: unknown;
	readonly input?: unknown;
	readonly old_string?: unknown;
	readonly new_string?: unknown;
	readonly edits?: unknown;
	readonly then_run?: unknown;
}

function clip(line: string): string {
	// Tabs would break the column alignment of the numbered body.
	const expanded = line.replace(/\t/gu, "    ").trimEnd();
	return expanded.length > MAX_LINE_WIDTH ? `${expanded.slice(0, MAX_LINE_WIDTH - 1)}…` : expanded;
}

/** Content lines, where a trailing newline terminates the last line. */
function contentLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Text blocks of a tool result, in order; non-text parts carry no row text. */
function resultText(result: MutationResultLike): string {
	const parts: string[] = [];
	for (const block of result.content ?? []) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim();
}

/** Style one row with the host theme, or return it unchanged when no theme was supplied. */
function styleLine(theme: Theme | undefined, color: ThemeColor, text: string): string {
	return theme ? theme.fg(color, text) : text;
}

function numbered(lines: readonly string[], limit: number): string[] {
	const shown = lines.slice(0, limit).map((line, index) => `${String(index + 1).padStart(3, " ")} ${clip(line)}`);
	const remaining = lines.length - shown.length;
	if (remaining > 0) shown.push(`    … ${remaining} more lines`);
	return shown;
}

/** Replacements an edit call carries, in either parameter variant. */
function editPairs(args: PreviewArgs): Array<[string, string]> {
	const pairs: Array<[string, string]> = [];
	const oldText = args.old_string;
	const newText = args.new_string;
	if (typeof oldText === "string" && typeof newText === "string") pairs.push([oldText, newText]);
	if (Array.isArray(args.edits)) {
		for (const entry of args.edits) {
			if (typeof entry !== "object" || entry === null) continue;
			const entryOld = Reflect.get(entry, "oldText");
			const entryNew = Reflect.get(entry, "newText");
			if (typeof entryOld === "string" && typeof entryNew === "string") pairs.push([entryOld, entryNew]);
		}
	}
	return pairs;
}

/** What the call changes, as styled body lines. */
function body(args: PreviewArgs): PreviewLine[] {
	const lines: PreviewLine[] = [];
	if (typeof args.content === "string") {
		for (const line of numbered(contentLines(args.content), PREVIEW_LINES)) {
			lines.push({ color: "dim", text: line });
		}
		return lines;
	}
	const pairs = editPairs(args);
	if (pairs.length > 0) {
		for (const [oldText, newText] of pairs.slice(0, EDIT_PREVIEW)) {
			for (const line of contentLines(oldText).slice(0, EDIT_LINES)) {
				lines.push({ color: "error", text: `- ${clip(line)}` });
			}
			for (const line of contentLines(newText).slice(0, EDIT_LINES)) {
				lines.push({ color: "success", text: `+ ${clip(line)}` });
			}
		}
		const remaining = pairs.length - Math.min(pairs.length, EDIT_PREVIEW);
		if (remaining > 0) lines.push({ color: "dim", text: `    … ${remaining} more edits` });
		return lines;
	}
	// Patch text, as the patch-language variant sends it, already reads as a diff.
	if (typeof args.input === "string") {
		for (const line of numbered(contentLines(args.input), PREVIEW_LINES)) {
			lines.push({ color: "dim", text: line });
		}
	}
	return lines;
}

function thenRunCommand(args: PreviewArgs): string | undefined {
	const thenRun = args.then_run;
	if (typeof thenRun !== "object" || thenRun === null) return undefined;
	const command = Reflect.get(thenRun, "command");
	return typeof command === "string" && command.length > 0 ? `→ ${clip(command)}` : undefined;
}

/** The tool name, target path, and size of the change on the first line. */
function headerText(name: string, args: PreviewArgs): string {
	const path = typeof args.path === "string" && args.path.length > 0 ? args.path : name;
	const sizes: string[] = [];
	if (typeof args.content === "string") {
		const count = contentLines(args.content).length;
		sizes.push(`${count} line${count === 1 ? "" : "s"}`);
	} else {
		const edits = editPairs(args).length;
		if (edits > 0) sizes.push(`${edits} edit${edits === 1 ? "" : "s"}`);
	}
	return `${name} ${path}${sizes.length > 0 ? ` · ${sizes.join(", ")}` : ""}`;
}

/**
 * Render a fused `edit`/`write` call row from its arguments.
 *
 * The preview is argument-derived only: it shows what the call is about to
 * change, which is what the reader needs while the result does not exist yet.
 */
export function previewMutationCall(
	theme: Theme | undefined,
	name: string,
	args: Record<string, unknown>,
): Component {
	const fields = args as PreviewArgs;
	const rows = body(fields);
	const command = thenRunCommand(fields);
	const lines = [headerText(name, fields), ...rows.map((row) => row.text)];
	const colors: ThemeColor[] = ["accent", ...rows.map((row) => row.color)];
	if (command !== undefined) {
		colors.push("dim");
		lines.push(command);
	}
	if (!theme) return new Text(lines.join("\n"), 0, 0);
	const styled = lines.map((line, index) =>
		index === 0 ? theme.fg("accent", theme.bold(line)) : theme.fg(colors[index] ?? "dim", line),
	);
	return new Text(styled.join("\n"), 0, 0);
}

/**
 * Render the outcome row of a fused `edit`/`write` call from its result.
 *
 * Oh My Pi draws no built-in result for the fused definitions, so without this
 * row a rejected call — the Seen-Line Guard's "never displayed" refusal, which a
 * straight retry with the same `[path#tag]` header then clears — looks exactly
 * like a successful one: both cards show the same argument preview. The first
 * line carries the outcome mark and the rest is the host's own result text,
 * capped at {@link RESULT_PREVIEW_LINES} lines so a follow-up command's output
 * cannot swamp the row.
 */
export function previewMutationResult(
	theme: Theme | undefined,
	result: MutationResultLike,
): Component | undefined {
	const text = resultText(result);
	if (!text) return undefined;
	const error = result.isError === true;
	const lines = contentLines(text);
	const shown = lines.slice(0, RESULT_PREVIEW_LINES);
	const rows = shown.map((line, index) => {
		const color: ThemeColor = error ? "error" : index === 0 ? "success" : "dim";
		const marked = index === 0 ? `${error ? "✗" : "✓"} ${line}` : line;
		return styleLine(theme, color, marked);
	});
	const remaining = lines.length - shown.length;
	if (remaining > 0) rows.push(styleLine(theme, "dim", `    … ${remaining} more lines`));
	return new Text(rows.join("\n"), 0, 0);
}
