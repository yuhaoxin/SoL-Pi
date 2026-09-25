/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runtimeRootIfAvailable } from "../../runtime-paths.ts";
import { createLedger, type Ledger } from "../observation-pack/ledger.ts";

/** Journal location inside the session runtime root. */
export const DECISION_JOURNAL_PATH = join("online-context-compact", "decisions.jsonl");

/**
 * Append-only audit trail of boundary compaction decisions and their outcomes.
 *
 * Compaction economics are otherwise invisible: a boundary that did not
 * compact leaves no trace, so a skipped or deferred compaction is
 * indistinguishable from a bug. Every `turn_end` evaluation appends one
 * `decision` record (including the breakeven inputs and the reason), and every
 * compaction attempt appends one `outcome` record. Writes per session root
 * are chained so records keep their decision-before-outcome order.
 *
 * Auditing must never break the mechanism: sessions without a persistent
 * directory are skipped, and write failures are logged to stderr instead of
 * propagated.
 */
export class DecisionJournal {
	private readonly ledgers = new Map<string, Ledger>();
	private readonly tails = new Map<string, Promise<void>>();

	async append(context: ExtensionContext, entry: Record<string, unknown>): Promise<void> {
		let root: string | undefined;
		let ledger: Ledger | undefined;
		try {
			root = runtimeRootIfAvailable(context);
			if (!root) return;
			ledger = this.ledgers.get(root);
			if (!ledger) {
				ledger = createLedger(join(root, DECISION_JOURNAL_PATH));
				this.ledgers.set(root, ledger);
			}
		} catch (error) {
			console.error(`[online-context-compact] decision journal unavailable: ${String(error)}`);
			return;
		}
		const journal = ledger;
		const tail = this.tails.get(root) ?? Promise.resolve();
		const next = tail
			.then(() => journal(entry))
			.catch((error: unknown) =>
				console.error(`[online-context-compact] decision journal write failed: ${String(error)}`),
			);
		this.tails.set(root, next);
		await next;
	}
}
