import { readFile, writeFile, fileExists, deleteFile, createDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { SavedImage } from "@/lib/extract-source-images"

/**
 * Per-stage ingest cache.
 *
 * Each completed ingest stage writes its full output to a small JSON file
 * under `.llm-wiki/ingest-stage-cache/<sourceKey>/step-<N>.json`. On retry
 * the pipeline reads `ingest-cache.json` for the last successful stage, then
 * hydrates the in-memory variables directly from these files and resumes at
 * the NEXT stage — so a failed run never re-runs a stage it already finished.
 *
 * This replaces the ad-hoc `wiki/ingest-stepN.log` recovery as the source of
 * truth for resume, and fixes the gap where the `writtenPaths` accumulator
 * (and derived slugs) were not recovered on resume.
 */

export type StageKey = "analysis" | "entity" | "concept" | "summary" | "aggregate" | "caption" | "rag" | "compress" | "reader" | "review"

export interface StepAnalysisCache {
  analysis: string
}
export interface StepEntityCache {
  entityGeneration: string
  writtenPaths: string[]
}
export interface StepConceptCache {
  conceptGeneration: string
  writtenPaths: string[]
}
export interface StepSummaryCache {
  summaryGeneration: string
  summaryRelated: string[]
  writtenPaths: string[]
}
export interface StepAggregateCache {
  aggregateGeneration: string
}
export interface StepCaptionCache {
  enrichedSourceContent: string
}
export interface StepRagCache {
  relatedPages: string
}
export interface StepCompressCache {
  sourceContext: string
}
export interface StepReaderCache {
  sourceContent: string
  savedImages: SavedImage[]
}
export interface StepReviewCache {
  reviewSuggestionOutput: string
}

function sourceCacheKey(sourceIdentity: string): string {
  // Stable, filesystem-safe key derived from the source identity.
  let h = 5381
  for (let i = 0; i < sourceIdentity.length; i++) {
    h = ((h << 5) + h + sourceIdentity.charCodeAt(i)) >>> 0
  }
  return h.toString(36)
}

function stageCacheDir(pp: string, sourceIdentity: string): string {
  return `${normalizePath(pp)}/.llm-wiki/ingest-stage-cache/${sourceCacheKey(sourceIdentity)}`
}

export function stageCachePath(pp: string, sourceIdentity: string, stage: StageKey): string {
  return `${stageCacheDir(pp, sourceIdentity)}/step-${stage}.json`
}

export async function writeStageCache(
  pp: string,
  sourceIdentity: string,
  stage: StageKey,
  data: unknown,
): Promise<void> {
  try {
    await createDirectory(stageCacheDir(pp, sourceIdentity))
    await writeFile(stageCachePath(pp, sourceIdentity, stage), JSON.stringify(data, null, 2))
  } catch {
    // non-critical: stage cache is a resume optimization
  }
}

export async function readStageCache<T>(
  pp: string,
  sourceIdentity: string,
  stage: StageKey,
): Promise<T | null> {
  try {
    return JSON.parse(await readFile(stageCachePath(pp, sourceIdentity, stage))) as T
  } catch {
    return null
  }
}

export async function clearStageCaches(pp: string, sourceIdentity: string): Promise<void> {
  const stages: StageKey[] = ["analysis", "entity", "concept", "summary", "aggregate", "caption", "rag", "compress", "reader", "review"]
  for (const stage of stages) {
    try {
      if (await fileExists(stageCachePath(pp, sourceIdentity, stage))) {
        await deleteFile(stageCachePath(pp, sourceIdentity, stage))
      }
    } catch {
      // best-effort
    }
  }
}
