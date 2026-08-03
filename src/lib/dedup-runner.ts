/**
 * I/O wrapper that connects the pure dedup algorithm in dedup.ts
 * to the project's filesystem + LLM. The UI layer calls these
 * functions; everything below is about read/write/spawn-llm so
 * the algorithm core stays testable without mocks of all that.
 */
import { listDirectory, readFile, writeFile, deleteFile } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import {
  candidatePairsFromVectors,
  clusterByPairs,
  loadPageVectors,
  DuplicatePrefilterCancelledError,
  type CandidatePair,
  type Page as DedupEmbeddingPage,
} from "@/lib/dedup_embedding"
import { loadEmbeddingConfig } from "@/lib/project-store"
import { normalizePath } from "@/lib/path-utils"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"

/**
 * Detection emits a bounded JSON list of duplicate groups — a few tens
 * of tokens per group — so a modest cap covers even a very duplicate-
 * heavy wiki. The cap's real job is a safety net: without it, a model
 * that ignores the reasoning-off lever (an unrecognized reasoning model
 * behind a custom endpoint, e.g. a vLLM Nemotron build) could stream
 * chain-of-thought unbounded until the 30-min backstop fires — which
 * surfaces to the user as a bare "request cancelled". Capping turns a
 * 30-min hang into a fast (truncated) response instead.
 */
const DEDUP_DETECTION_MAX_TOKENS = 8_192
// Conservative defaults: keep enough neighbors for recall while cutting the
// LLM detector prompt into small candidate batches. The threshold is deliberately
// below "near duplicate" territory because this tool must catch cross-language
// aliases, where cosine scores can be weaker on non-multilingual embedders.
const DEDUP_PREFILTER_TOP_K = 8
const DEDUP_PREFILTER_THRESHOLD = 0.68
const DEDUP_DETECTOR_BATCH_SUMMARIES = 80
const DEDUP_EMPTY_PREFILTER_FULL_SCAN_LIMIT = 250

/**
 * Merge rewrites a COMPLETE page that gets written to disk, so it needs
 * a generous cap that won't truncate the canonical content. 16K tokens
 * is ~64KB of text — far beyond any realistic merged entity/concept
 * page — while still bounding a runaway short of the 30-min backstop.
 * Kept local (not the ingest generation ladder) so this module doesn't
 * drag in the heavy ingest dependency graph.
 */
const DEDUP_MERGE_MAX_TOKENS = 16_384
import {
  detectDuplicateGroups,
  extractEntitySummary,
  mergeDuplicateGroup,
  rewriteIndexMd,
  type DedupLlmCall,
  type DuplicateGroup,
  type EntitySummary,
  type MergeResult,
} from "./dedup"
import { loadNotDuplicates } from "./dedup-storage"

// ── Progress reporting ─────────────────────────────────────────────────────

export type DedupScanStage =
  | { stage: "reading"; index: number; total: number }
  | { stage: "loading"; index: number; total: number }
  | { stage: "embedding"; index: number; total: number }
  | { stage: "detecting"; index: number; total: number }

export interface DedupScanOptions {
  signal?: AbortSignal
  /** Called after each progress-relevant step in the scan pipeline. */
  onProgress?: (p: DedupScanStage) => void
}

/**
 * Append a line to the project's dedup diagnostic log. Mirrors the
 * ingest pipeline's `logDiag` (read-append-write); failures to log
 * are silent. Kept best-effort because a logging failure must never
 * take down a merge.
 */
async function logDedupDiag(projectPath: string, message: string): Promise<void> {
  try {
    const logPath = `${projectPath}/.llm-wiki/dedup-diag.log`
    const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19)
    const existing = await readFile(logPath).catch(() => "")
    await writeFile(logPath, existing + `[${timestamp}] ${message}\n`)
  } catch {
    // non-critical
  }
}

/**
 * Wrap streamChat into the (system, user, signal) → string shape
 * the dedup module expects. Same pattern page-merge uses — keeps
 * the algorithm modules free of any LlmConfig knowledge.
 *
 * `maxTokens` is required, not defaulted: detection and merge have
 * very different output-size needs (a tiny JSON list vs. a complete
 * rewritten page), and silently sharing one cap risks truncating a
 * merged page on disk. Forcing each caller to state its budget makes
 * that choice explicit.
 */
export function buildDedupLlmCall(
  llmConfig: LlmConfig,
  maxTokens: number,
): DedupLlmCall {
  return async (systemPrompt, userMessage, signal) => {
    let result = ""
    let streamError: Error | null = null
    await new Promise<void>((resolve) => {
      streamChat(
        llmConfig,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        {
          onToken: (t) => {
            result += t
          },
          onDone: () => resolve(),
          onError: (err) => {
            streamError = err
            resolve()
          },
        },
        signal,
        // Dedup detection + merge want JSON, never chain-of-thought.
        // Like every other structured caller (ingest, connection-tests,
        // vision-caption, anytxt-search), disable thinking AND cap output
        // so a reasoning-capable model (an Ollama thinking model, or an
        // unrecognized reasoning model behind a custom endpoint) doesn't
        // spend its whole budget on reasoning and run the stream to the
        // 30-min backstop — which surfaces as a bare "Request cancelled".
        { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: maxTokens },
      ).catch((err) => {
        streamError = err instanceof Error ? err : new Error(String(err))
        resolve()
      })
    })
    if (streamError) throw streamError
    return result
  }
}

/** Walk a FileNode tree, yielding every .md file under a given prefix. */
function* walkMd(nodes: FileNode[], prefix: string): Generator<FileNode> {
  for (const node of nodes) {
    if (node.is_dir) {
      if (node.children) yield* walkMd(node.children, prefix)
      continue
    }
    if (node.name.endsWith(".md") && node.path.includes(`${prefix}/`)) {
      yield node
    }
  }
}

/** Convert an absolute filesystem path to a wiki-relative one
 *  (`<project>/wiki/entities/foo.md` → `wiki/entities/foo.md`). */
function toWikiRelative(projectPath: string, absPath: string): string {
  const pp = normalizePath(projectPath)
  const norm = normalizePath(absPath)
  if (norm.startsWith(`${pp}/`)) return norm.slice(pp.length + 1)
  return norm
}

/**
 * Walk wiki/entities/ and wiki/concepts/, build summaries.
 * Pages that fail to parse (no frontmatter, etc.) are skipped
 * silently — they can't participate in dedup anyway.
 */
export async function loadAllEntitySummaries(
  projectPath: string,
  onReading?: (index: number, total: number) => void,
): Promise<EntitySummary[]> {
  const pp = normalizePath(projectPath)
  const tree = await listDirectory(pp)

  // Pre-count so progress reporting knows the total.
  const allNodes: FileNode[] = []
  for (const prefix of ["wiki/entities", "wiki/concepts"]) {
    for (const node of walkMd(tree, prefix)) {
      allNodes.push(node)
    }
  }

  const total = allNodes.length
  const out: EntitySummary[] = []
  for (let i = 0; i < total; i++) {
    const node = allNodes[i]
    try {
      const content = await readFile(node.path)
      const rel = toWikiRelative(pp, node.path)
      const summary = extractEntitySummary(rel, content)
      if (summary) out.push(summary)
    } catch {
      // best-effort — skip unreadable pages
    }
    onReading?.(i + 1, total)
  }
  return out
}

/** Read every .md under wiki/ as { path, content }. The path is
 *  the wiki-relative form callers downstream use. */
export async function loadAllWikiPages(
  projectPath: string,
): Promise<{ path: string; content: string }[]> {
  const pp = normalizePath(projectPath)
  const tree = await listDirectory(pp)
  const out: { path: string; content: string }[] = []
  for (const node of walkMd(tree, "wiki")) {
    try {
      const content = await readFile(node.path)
      out.push({ path: toWikiRelative(pp, node.path), content })
    } catch {
      // ignore
    }
  }
  return out
}

/**
 * Stage 1 + 2 from the user's perspective: scan the project for
 * duplicate-candidate groups. Reads notDuplicates whitelist from
 * disk so previously-confirmed false-positives don't reappear.
 */
export async function runDuplicateDetection(
  projectPath: string,
  llmConfig: LlmConfig,
  options: DedupScanOptions = {},
): Promise<DuplicateGroup[]> {
  const onProgress = options.onProgress
  const onReading = onProgress ? (i: number, t: number) => onProgress({ stage: "reading", index: i, total: t }) : undefined
  const summaries = await loadAllEntitySummaries(projectPath, onReading)
  if (summaries.length < 2) return []
  const notDup = await loadNotDuplicates(projectPath)
  const llm = buildDedupLlmCall(llmConfig, DEDUP_DETECTION_MAX_TOKENS)
  const embeddingConfig = await loadEmbeddingConfig()

  const embeddingEndpoint =
    typeof embeddingConfig?.endpoint === "string" ? embeddingConfig.endpoint.trim() : ""
  if (embeddingConfig?.enabled && embeddingEndpoint) {
    try {
      // Load page-level vectors: try existing full-text chunk vectors from
      // LanceDB first, falling back to lightweight summary fetchEmbedding
      // for pages not yet indexed.
      const pages = summaries.map(summaryToEmbeddingPage)
      const onLoading = onProgress
        ? (i: number, t: number) => onProgress({ stage: "loading", index: i, total: t })
        : undefined
      const vectors = await loadPageVectors(projectPath, pages, embeddingConfig, {
        signal: options.signal,
        onProgress: onLoading,
      })

      const validPageIds = [...vectors.keys()]
      if (validPageIds.length < 2) {
        console.warn("[dedup] too few pages have vectors; skipping prefilter")
        return detectDuplicateGroups(summaries, llm, {
          signal: options.signal,
          notDuplicates: notDup,
        })
      }

      const pairs = candidatePairsFromVectors(vectors, validPageIds, {
        topK: DEDUP_PREFILTER_TOP_K,
        threshold: DEDUP_PREFILTER_THRESHOLD,
      })
      if (pairs.length === 0) {
        return summaries.length <= DEDUP_EMPTY_PREFILTER_FULL_SCAN_LIMIT
          ? detectDuplicateGroups(summaries, llm, { signal: options.signal, notDuplicates: notDup })
          : []
      }

      const summaryByPath = new Map(summaries.map((s) => [s.path, s]))
      const filteredPairs = filterWhitelistedPairs(pairs, summaryByPath, notDup)
      if (filteredPairs.length === 0) return []

      const clusters = clusterByPairs(validPageIds, filteredPairs)
      if (clusters.length === 0) return []

      const batches = batchCandidateClusters(clusters, summaryByPath)
      const out: DuplicateGroup[] = []
      for (let b = 0; b < batches.length; b++) {
        onProgress?.({ stage: "detecting", index: b + 1, total: batches.length })
        if (options.signal?.aborted) throw new Error("Duplicate scan cancelled")
        const detected = await detectDuplicateGroups(batches[b], llm, {
          signal: options.signal,
          notDuplicates: notDup,
        })
        out.push(...detected)
      }
      return uniqueDuplicateGroups(out)
    } catch (err) {
      if (isAbortError(err) || options.signal?.aborted) throw err
      if (summaries.length > DEDUP_EMPTY_PREFILTER_FULL_SCAN_LIMIT && isEmbeddingCoverageError(err)) {
        console.warn("[dedup] embedding prefilter coverage too low; skipping full fallback for large wiki:", err)
        return []
      }
      console.warn("[dedup] embedding prefilter failed; falling back to full LLM scan:", err)
    }
  }

  onProgress?.({ stage: "detecting", index: 1, total: 1 })
  return detectDuplicateGroups(summaries, llm, {
    signal: options.signal,
    notDuplicates: notDup,
  })
}

function summaryToEmbeddingPage(summary: EntitySummary): DedupEmbeddingPage {
  return {
    id: summary.path,
    title: summary.title,
    body: summary.description ?? "",
    tags: summary.tags,
  }
}

function batchCandidateClusters(
  clusters: string[][],
  summaryByPath: Map<string, EntitySummary>,
): EntitySummary[][] {
  const batches: EntitySummary[][] = []
  let current: EntitySummary[] = []

  for (const cluster of clusters) {
    const summaries = cluster
      .map((pageId) => summaryByPath.get(pageId))
      .filter((summary): summary is EntitySummary => !!summary)
    if (summaries.length < 2) continue

    if (
      current.length > 0
      && current.length + summaries.length > DEDUP_DETECTOR_BATCH_SUMMARIES
    ) {
      batches.push(current)
      current = []
    }

    current.push(...summaries)

    if (current.length >= DEDUP_DETECTOR_BATCH_SUMMARIES) {
      batches.push(current)
      current = []
    }
  }

  if (current.length > 0) batches.push(current)
  return batches
}

function uniqueDuplicateGroups(groups: DuplicateGroup[]): DuplicateGroup[] {
  const seen = new Set<string>()
  const out: DuplicateGroup[] = []
  for (const group of groups) {
    const key = group.pages.map((path) => path.toLowerCase()).sort().join("\t")
    if (seen.has(key)) continue
    seen.add(key)
    out.push(group)
  }
  return out
}

function filterWhitelistedPairs(
  pairs: CandidatePair[],
  summaryByPath: Map<string, EntitySummary>,
  notDuplicates: string[][],
): CandidatePair[] {
  if (notDuplicates.length === 0) return pairs
  const notDupSet = new Set(notDuplicates.map(normalizePathGroupKey))
  return pairs.filter(([a, b]) => {
    const left = summaryByPath.get(a)?.path
    const right = summaryByPath.get(b)?.path
    if (!left || !right) return true
    return !notDupSet.has(normalizePathGroupKey([left, right]))
  })
}

function normalizePathGroupKey(paths: readonly string[]): string {
  return paths.map((path) => path.toLowerCase()).sort().join("\t")
}

function isAbortError(err: unknown): boolean {
  return err instanceof DuplicatePrefilterCancelledError
    || (err instanceof Error && err.name === "AbortError")
}

function isEmbeddingCoverageError(err: unknown): boolean {
  return err instanceof Error
    && /could not embed enough pages|embedded only \d+\/\d+ pages/i.test(err.message)
}

/**
 * Stage 3 + persistence: execute one user-confirmed merge.
 *
 * Steps:
 *   1. Load each group page's full content + every other wiki page
 *   2. Run mergeDuplicateGroup (LLM body merge + frontmatter
 *      union + cross-reference rewrites)
 *   3. Snapshot every touched file to .llm-wiki/page-history/
 *      dedup-<timestamp>/
 *   4. Write canonical content
 *   5. Apply cross-reference rewrites
 *   6. Delete merged-away files
 *   7. Apply index.md rewrite (separate pass — index isn't in
 *      otherWikiPages because removing references is a different
 *      operation than slug-rewriting them)
 */
export async function executeMerge(
  projectPath: string,
  group: DuplicateGroup,
  canonicalPath: string,
  llmConfig: LlmConfig,
  options: { signal?: AbortSignal } = {},
): Promise<MergeResult> {
  const pp = normalizePath(projectPath)

  // 1. Resolve each group page to its content by wiki-relative path.
  //    Direct path lookup (no slug map) keeps colliding basenames
  //    distinct — each entry points at exactly one file.
  const allPages = await loadAllWikiPages(pp)
  const byPath = new Map(allPages.map((p) => [p.path, p]))
  const groupPages: { path: string; content: string }[] = []
  for (const relPath of group.pages) {
    const page = byPath.get(relPath)
    if (!page) {
      throw new Error(
        `Page "${relPath}" not found on disk — was the page deleted between detection and merge?`,
      )
    }
    groupPages.push({ path: relPath, content: page.content })
  }

  const groupPaths = new Set(groupPages.map((p) => p.path))
  const otherPages = allPages.filter((p) => !groupPaths.has(p.path))

  // Merge rewrites a COMPLETE page that gets written to disk, so it gets
  // the generous merge budget — never the small detection cap, which
  // would truncate the canonical content.
  const llm = buildDedupLlmCall(llmConfig, DEDUP_MERGE_MAX_TOKENS)
  const result = await mergeDuplicateGroup(
    {
      group: groupPages,
      canonicalPath,
      otherWikiPages: otherPages,
    },
    llm,
    { signal: options.signal },
  )

  // 2. Snapshot backup before any writes. If a write fails partway
  //    through, the user has the pre-merge state intact in
  //    .llm-wiki/page-history/.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupDir = `${pp}/.llm-wiki/page-history/dedup-${stamp}`
  for (const b of result.backup) {
    const sanitized = b.path.replace(/[/\\]/g, "_")
    await writeFile(`${backupDir}/${sanitized}`, b.content)
  }

  // 3. Write canonical
  await writeFile(`${pp}/${result.canonicalPath}`, result.canonicalContent)

  // 4. Apply rewrites
  for (const r of result.rewrites) {
    await writeFile(`${pp}/${r.path}`, r.newContent)
  }

  // 5. Delete merged-away pages
  for (const dead of result.pagesToDelete) {
    try {
      await deleteFile(`${pp}/${dead}`)
    } catch (err) {
      // Surface as a warning — backup is still safe.
      console.warn(`[dedup] failed to delete ${dead}: ${err}`)
    }
  }

  // 6. Rewrite index.md to drop merged-away entries.
  const indexPath = `${pp}/wiki/index.md`
  const indexEntry = allPages.find((p) => p.path === "wiki/index.md")
  if (indexEntry) {
    const removed = new Set(group.pages.filter((p) => p !== canonicalPath))
    const survivingSlug = (canonicalPath.split("/").pop() ?? "").replace(/\.md$/, "")
    const rewritten = rewriteIndexMd(indexEntry.content, removed, survivingSlug)
    if (rewritten !== indexEntry.content) {
      try {
        await writeFile(indexPath, rewritten)
      } catch (err) {
        await logDedupDiag(
          pp,
          `index.md rewrite write failed for group [${group.pages.join(", ")}] → ${canonicalPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        throw err
      }
    }
  }

  return result
}
