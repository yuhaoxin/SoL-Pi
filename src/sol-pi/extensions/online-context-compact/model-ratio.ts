/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

/**
 * Fallback ratio for hosts and models that expose no prompt-cache prices.
 *
 * 12.5 is the Anthropic-shaped premium (writes at 1.25x base input, reads at
 * 0.1x) and the most expensive ratio in common use, so an unknown model defers
 * compaction unless the saving clearly pays for the cache rewrite.
 */
export const DEFAULT_CACHE_WRITE_READ_RATIO = 12.5;

/** Configured ratio policy: a fixed number, `"auto"` model prices, or no ratio at all. */
export type CacheWriteReadRatioOption = number | "auto" | null;

/** Price metadata the derivation reads; hosts expose it as `Model.cost` (USD per million tokens). */
export interface ModelCachePrices {
	readonly cost?:
		| {
				readonly input?: number;
				readonly cacheRead?: number;
				readonly cacheWrite?: number;
		  }
		| undefined;
}

function isPrice(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Cache write/read price ratio of a model: the price of the tokens a compaction
 * rewrites into the cache, over the price of reading them back.
 *
 * The breakeven formula works in read-price units — rewriting a token into the
 * cache costs `ratio` read-prices while each later request reads one saved token
 * at one read-price — so the ratio is a property of the model being served.
 *
 * A zero `cacheWrite` rate is a statement about the *rate card*, not a free
 * write: providers that bill no separate write premium (OpenAI- and
 * DeepSeek-style caching) put the rewritten tokens in the ordinary prompt, so
 * they cost the input rate. Billing those tokens at zero would claim that any
 * compaction repays itself immediately, including on subscription plans where
 * every one of those tokens still draws down quota. `cacheWrite` is therefore
 * only used when the model actually prices cache writes above nothing.
 *
 * Returns `undefined` when no read or write rate can be established — a zero
 * cache-read price is the host catalog's "pricing unknown" row (and would divide
 * by zero) — which leaves the caller's fallback in charge.
 */
export function cacheWriteReadRatioFromModel(model: ModelCachePrices | undefined): number | undefined {
	const cacheRead = model?.cost?.cacheRead;
	const cacheWrite = model?.cost?.cacheWrite;
	const input = model?.cost?.input;
	if (!isPrice(cacheRead) || cacheRead === 0) return undefined;
	const writeRate = isPrice(cacheWrite) && cacheWrite > 0 ? cacheWrite : input;
	if (!isPrice(writeRate) || writeRate === 0) return undefined;
	return writeRate / cacheRead;
}

/** Validate the configured policy; `undefined` means the caller configured nothing and gets `"auto"`. */
export function resolveCacheWriteReadRatioOption(
	value: number | "auto" | null | undefined,
): CacheWriteReadRatioOption {
	if (value === undefined || value === "auto") return "auto";
	if (value === null) return null;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error('Online Context Compact cacheWriteReadRatio must be "auto" or finite and non-negative');
	}
	return value;
}

/**
 * Effective ratio for one decision.
 *
 * `null` (explicitly configured) means the ratio is unavailable: the decision
 * engine then reports `cache_ratio_unavailable` and compacts only for window
 * protection.
 */
export function effectiveCacheWriteReadRatio(
	option: CacheWriteReadRatioOption,
	model: ModelCachePrices | undefined,
): number | null {
	if (typeof option === "number") return option;
	if (option === null) return null;
	return cacheWriteReadRatioFromModel(model) ?? DEFAULT_CACHE_WRITE_READ_RATIO;
}
