/**
 * dedup_embedding.ts
 *
 * Vector-embedding candidate generation for duplicate-page scan.
 * Pre-filters pages by cosine similarity so the downstream LLM detector
 * only sees a small candidate set (issue #359).
 *
 * Reuses existing full-text chunk vectors from LanceDB (the general
 * embedding pipeline already indexes every page's chunks). Pages that
 * haven't been indexed yet fall back to a lightweight summary fetchEmbedding.
 */
import { invoke } from "@tauri-apps/api/core"
import { fetchEmbedding } from "./embedding"
import type { EmbeddingConfig } from "@/stores/wiki-store"

export interface Page {
  id: string
  title: string
  body?: string
  tags?: string[]
}

/** A single chunk vector returned by the Rust `vector_get_page_chunks` command. */
export interface ChunkVector {
  chunk_id: string
  chunk_index: number
  chunk_text: string
  heading_path: string
  embedding: number[]
}

/**
 * Average-pool a list of chunk vectors into a single page-level vector.
 * Each dimension is the mean of that dimension across all chunks.
 * Returns an empty array if `chunks` is empty.
 */
export function averagePool(chunks: ChunkVector[]): number[] {
  if (chunks.length === 0) return []
  const dim = chunks[0].embedding.length
  const sum = new Float64Array(dim)
  for (const c of chunks) {
    for (let i = 0; i < dim; i++) {
      sum[i] += c.embedding[i]
    }
  }
  const out = new Array<number>(dim)
  const n = chunks.length
  for (let i = 0; i < dim; i++) {
    out[i] = sum[i] / n
  }
  return out
}

/**
 * Load page-level vectors for a set of page IDs. For each page, tries
 * to read existing full-text chunk vectors from LanceDB (via the Rust
 * `vector_get_page_chunks` command). If the page has chunks, average-pools
 * them into a single vector. If not (page not yet indexed), falls back to
 * embedding a lightweight summary via fetchEmbedding.
 *
 * Returns a Map<pageId, number[]>.
 */
export async function loadPageVectors(
  projectPath: string,
  pages: Page[],
  cfg: EmbeddingConfig,
  options: { signal?: AbortSignal; onProgress?: (index: number, total: number) => void } = {},
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>()
  for (let i = 0; i < pages.length; i++) {
    throwIfAborted(options.signal)
    const p = pages[i]
    try {
      const chunks = await invoke<ChunkVector[]>("vector_get_page_chunks", {
        projectPath,
        pageId: p.id,
      })
      if (chunks.length > 0) {
        out.set(p.id, averagePool(chunks))
      } else {
        // Fallback: no chunk vectors in LanceDB — embed lightweight summary
        const text = pageToEmbeddingText(p)
        const vec = await fetchEmbedding(text, cfg)
        if (vec) out.set(p.id, vec)
      }
    } catch {
      // Fallback on error too (e.g. LanceDB table not created yet)
      const text = pageToEmbeddingText(p)
      const vec = await fetchEmbedding(text, cfg)
      if (vec) out.set(p.id, vec)
    }
    options.onProgress?.(i + 1, pages.length)
  }
  return out
}

export interface CandidateOptions {
  topK?: number
  threshold?: number
  maxPages?: number
  signal?: AbortSignal
  /**
   * If too many embeddings fail, callers should fall back to the old full scan
   * instead of silently missing most pages. Default: 0.8.
   */
  minSuccessRatio?: number
  /**
   * Per-page character budget for the embedding input text.
   * Real pages can be megabytes; we cap to stay within embedding context windows.
   * Default 1500 chars (matches chunker default).
   */
  textBudgetChars?: number
  /**
   * Called after each page is embedded, with (index, total) 1-based.
   * Optional — progress reporting doesn't affect the result.
   */
  onProgress?: (index: number, total: number) => void
}

export type CandidatePair = readonly [string, string]

export class DuplicatePrefilterCancelledError extends Error {
  name = "AbortError"
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DuplicatePrefilterCancelledError("Duplicate scan cancelled")
}

/**
 * Cosine similarity between two equal-length vectors. Returns 0 if either is
 * zero, vectors differ in length, or either is null/undefined (embedding failed).
 */
export function cosineSimilarity(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/**
 * Build the embedding input text from a page.
 * Mirrors embedPage's chunker input but keeps it short for similarity comparison.
 */
export function pageToEmbeddingText(page: Page, budget = 1500): string {
  const tagPart = (page.tags ?? []).join(" ")
  const idPart = page.id.split("/").pop()?.replace(/\.md$/i, "") ?? page.id
  const parts = [
    idPart,
    page.title,
    tagPart,
    (page.body ?? "").slice(0, budget),
  ]
  return parts.filter(Boolean).join("\n")
}

/**
 * Embed pages sequentially via fetchEmbedding.
 * Returns pageId → vector (or null if embedding failed for that page).
 */
export async function embedPages(
  pages: Page[],
  cfg: EmbeddingConfig,
  opts: { signal?: AbortSignal; textBudgetChars?: number; onProgress?: (index: number, total: number) => void } = {},
): Promise<Map<string, number[] | null>> {
  const out = new Map<string, number[] | null>()
  const budget = opts.textBudgetChars ?? 1500
  for (let i = 0; i < pages.length; i++) {
    throwIfAborted(opts.signal)
    const text = pageToEmbeddingText(pages[i], budget)
    const vec = await fetchEmbedding(text, cfg)
    throwIfAborted(opts.signal)
    out.set(pages[i].id, vec)
    opts.onProgress?.(i + 1, pages.length)
  }
  return out
}

/**
 * Generate candidate duplicate pairs: each page's top-K nearest neighbors
 * above threshold, self-excluded, symmetric deduplicated.
 *
 * Pages whose embedding failed (null) are silently skipped on the source
 * side; they may still appear as the TARGET of a pair from another page.
 */
export async function candidatePairs(
  pages: Page[],
  cfg: EmbeddingConfig,
  opts: CandidateOptions = {},
): Promise<CandidatePair[]> {
  const topK = opts.topK ?? 8
  const threshold = opts.threshold ?? 0.82
  const maxPages = opts.maxPages ?? 5000
  const minSuccessRatio = opts.minSuccessRatio ?? 0.8

  if (pages.length === 0) return []
  const subset = pages.slice(0, maxPages)
  if (pages.length > subset.length) {
    console.warn(
      `[dedup] embedding prefilter limited scan to ${subset.length}/${pages.length} pages`,
    )
  }

  const embeddings = await embedPages(subset, cfg, {
    signal: opts.signal,
    textBudgetChars: opts.textBudgetChars,
  })

  const embeddedCount = [...embeddings.values()].filter((v) => v && v.length > 0).length
  if (subset.length >= 2 && embeddedCount < 2) {
    throw new Error("Duplicate prefilter could not embed enough pages")
  }
  if (subset.length > 0 && embeddedCount / subset.length < minSuccessRatio) {
    throw new Error(
      `Duplicate prefilter embedded only ${embeddedCount}/${subset.length} pages`,
    )
  }

  const validVectors = new Map<string, number[]>()
  for (const p of subset) {
    const v = embeddings.get(p.id)
    if (v) validVectors.set(p.id, v)
  }

  return candidatePairsFromVectors(validVectors, [...validVectors.keys()], { topK, threshold })
}

/**
 * Generate candidate pairs from pre-computed page-level vectors.
 * Same pairwise logic as `candidatePairs` but skips the embedding step.
 * Each page's top-K nearest neighbors above threshold, self-excluded,
 * symmetric deduplicated.
 */
export function candidatePairsFromVectors(
  vectors: Map<string, number[]>,
  pageIds: string[],
  options: { topK?: number; threshold?: number } = {},
): CandidatePair[] {
  const topK = options.topK ?? 8
  const threshold = options.threshold ?? 0.82

  const pairSet = new Set<string>()
  const pairs: CandidatePair[] = []

  for (let i = 0; i < pageIds.length; i++) {
    const vi = vectors.get(pageIds[i])
    if (!vi) continue
    const scored: Array<{ j: number; sim: number }> = []
    for (let j = 0; j < pageIds.length; j++) {
      if (i === j) continue
      const vj = vectors.get(pageIds[j])
      const sim = cosineSimilarity(vi, vj)
      if (sim >= threshold) scored.push({ j, sim })
    }
    scored.sort((a, b) => b.sim - a.sim)

    for (let k = 0; k < Math.min(topK, scored.length); k++) {
      const a = pageIds[i]
      const b = pageIds[scored[k].j]
      const key = a < b ? `${a}\t${b}` : `${b}\t${a}`
      if (!pairSet.has(key)) {
        pairSet.add(key)
        pairs.push([a, b] as const)
      }
    }
  }

  return pairs
}

/**
 * Union-find clustering of candidate pairs into groups.
 * ITERATIVE find() with path compression to avoid stack overflow on large inputs.
 */
export function clusterByPairs(
  pageIds: string[],
  pairs: CandidatePair[],
): string[][] {
  const parent = new Map<string, string>()
  for (const id of pageIds) parent.set(id, id)

  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    // path compression
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }

  for (const [a, b] of pairs) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  const groups = new Map<string, string[]>()
  for (const id of pageIds) {
    const root = find(id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root)!.push(id)
  }

  return [...groups.values()].filter((g) => g.length > 1)
}
