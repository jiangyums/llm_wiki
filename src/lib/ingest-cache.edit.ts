import { readFile, writeFile, fileExists } from "@/commands/fs"
import { normalizePath, isAbsolutePath } from "@/lib/path-utils"

/**
 * SHA256-based ingest cache.
 * Stores hash of source file content → skips re-ingest if unchanged.
 * Cache file: .llm-wiki/ingest-cache.json
 */

export interface CacheEntry {
  hash: string
  timestamp: number
  filesWritten: string[]
  /** false when the file-write phase completed but later steps
   *  (embedding) failed or were interrupted. Re-ingest skips
   *  the cache when this is false so every step gets retried. */
  fullyIngested?: boolean
  /** Highest successfully completed ingest stage (1-10).
   *  Used to resume a failed run from the next stage instead of re-running
   *  everything. Persisted per source so it survives queue/app restarts. */
  lastStage?: number
}

interface CacheData {
  entries: Record<string, CacheEntry> // keyed by source filename
}

export async function sha256(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}

function cachePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/ingest-cache.json`
}

export async function loadCache(projectPath: string): Promise<CacheData> {
  try {
    const raw = await readFile(cachePath(projectPath))
    return JSON.parse(raw) as CacheData
  } catch {
    return { entries: {} }
  }
}

async function saveCache(projectPath: string, cache: CacheData): Promise<void> {
  try {
    await writeFile(cachePath(projectPath), JSON.stringify(cache, null, 2))
  } catch {
    // non-critical
  }
}

/**
 * Check if a source file has already been ingested with the same content.
 * Returns the list of previously written files if cached, or null if ingest
 * is needed.
 *
 * IMPORTANT: a cache hit is only returned if every previously-written file
 * still exists on disk. Otherwise we treat the cache as stale and fall
 * through to a full re-ingest. Historically we returned the cached list
 * blindly, which surfaced ghost entries in the activity panel — clicking
 * them gave the preview panel a missing file, and the auto-save path then
 * materialized a `[Binary file: ...]` stub at the now-empty location.
 */
export async function checkIngestCache(
  projectPath: string,
  sourceFileName: string,
  sourceContent: string,
): Promise<string[] | null> {
  const cache = await loadCache(projectPath)
  const entry = cache.entries[sourceFileName]
  if (!entry) return null

  const currentHash = await sha256(sourceContent)
  if (entry.hash !== currentHash) return null

  // If a previous ingest wrote the files but failed before completing
  // all post-file steps (embedding), don't trust the cache.
  if (entry.fullyIngested !== true) {
    console.log(
      `[ingest-cache] cache miss for ${sourceFileName}: previous ingest was incomplete (fullyIngested=${entry.fullyIngested})`,
    )
    return null
  }

  const pp = normalizePath(projectPath)
  for (const filePath of entry.filesWritten) {
    const fullPath = isAbsolutePath(filePath)
      ? normalizePath(filePath)
      : `${pp}/${filePath}`
    try {
      if (!(await fileExists(fullPath))) {
        console.log(
          `[ingest-cache] cache miss for ${sourceFileName}: ${filePath} no longer on disk`,
        )
        return null
      }
    } catch {
      // If the existence check itself fails, fall back to re-ingest —
      // safer than trusting a stale cache entry.
      return null
    }
  }

  return entry.filesWritten
}

/**
 * Save ingest result to cache after successful ingest.
 */
export async function saveIngestCache(
  projectPath: string,
  sourceFileName: string,
  sourceContent: string,
  filesWritten: string[],
  fullyIngested: boolean = false,
): Promise<void> {
  const cache = await loadCache(projectPath)
  const hash = await sha256(sourceContent)
  const prev = cache.entries[sourceFileName]
  const newEntries = { ...cache.entries }
  newEntries[sourceFileName] = {
    ...prev,
    hash,
    timestamp: Date.now(),
    filesWritten,
    fullyIngested,
  }
  await saveCache(projectPath, { entries: newEntries })
}

/**
 * Record that a stage completed successfully. Persists `lastStage` per source
 * so a failed run can resume from the next stage after a restart. Creates the
 * entry if it does not exist yet (e.g. mid first-run) with a placeholder hash
 * that `saveIngestCache` corrects on successful completion.
 */
export async function saveIngestStageProgress(
  projectPath: string,
  sourceFileName: string,
  stage: number,
  contentHash?: string,
): Promise<void> {
  const cache = await loadCache(projectPath)
  const prev = cache.entries[sourceFileName]
  const newEntries = { ...cache.entries }
  newEntries[sourceFileName] = {
    hash: prev?.hash || contentHash || "",
    timestamp: Date.now(),
    filesWritten: prev?.filesWritten ?? [],
    fullyIngested: prev?.fullyIngested,
    lastStage: Math.max(prev?.lastStage ?? 0, stage),
  }
  await saveCache(projectPath, { entries: newEntries })
}

/** Read the last successfully completed stage for a source (0 = none). */
export async function readIngestLastStage(
  projectPath: string,
  sourceFileName: string,
): Promise<number> {
  const cache = await loadCache(projectPath)
  return cache.entries[sourceFileName]?.lastStage ?? 0
}

/**
 * Mark a cached source as fully ingested (all post-file steps completed).
 * Called after the embedding step succeeds so that future re-adds can
 * trust the cache entry. Safe to call even if no cache entry exists yet
 * (no-op).
 */
export async function markIngestCacheComplete(
  projectPath: string,
  sourceFileName: string,
): Promise<void> {
  const cache = await loadCache(projectPath)
  const entry = cache.entries[sourceFileName]
  if (!entry) return
  entry.fullyIngested = true
  entry.timestamp = Date.now()
  await saveCache(projectPath, {
    entries: { ...cache.entries, [sourceFileName]: entry },
  })
}

/**
 * Remove a source file entry from cache (e.g., when source is deleted).
 */
export async function removeFromIngestCache(
  projectPath: string,
  sourceFileName: string,
): Promise<void> {
  const cache = await loadCache(projectPath)
  const newEntries = { ...cache.entries }
  delete newEntries[sourceFileName]
  await saveCache(projectPath, { entries: newEntries })
}
