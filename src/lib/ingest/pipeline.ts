import {
  createDirectory,
  deleteFile,
  fileExists,
  readFile,
  readFileAsBase64,
  writeFile,
  listDirectory,
} from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage } from "@/lib/llm-providers"
import { useWikiStore } from "@/stores/wiki-store"
import { parseWithMineruResult } from "@/lib/mineru"
import { useChatStore } from "@/stores/chat-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { getFileName, isAbsolutePath, normalizePath } from "@/lib/path-utils"
import {
  sourceIdentityForPath,
  sourceSummarySlugFromIdentity,
} from "@/lib/source-identity"
import { parseFrontmatterArray, writeFrontmatterArray } from "@/lib/sources-merge"
import { loadCache, sha256, markIngestCacheComplete, saveIngestCache, saveIngestStageProgress } from "@/lib/ingest-cache"
import {
  writeStageCache,
  readStageCache,
  clearStageCaches,
  type StepAnalysisCache,
  type StepEntityCache,
  type StepConceptCache,
  type StepSummaryCache,
  type StepCaptionCache,
  type StepRagCache,
  type StepCompressCache,
  type StepReaderCache,
  type StepReviewCache,
} from "@/lib/ingest/stage-cache"
import { sanitizeIngestedFileContent } from "@/lib/ingest-sanitize"
import { mergePageContent, type MergeFn } from "@/lib/page-merge"
import { searchRelatedWikiPages, mergeRelatedPages, type ManifestPage } from "./ingest-search"
import { withProjectLock } from "@/lib/project-mutex"
import { parseFrontmatter } from "@/lib/frontmatter"
import {
  extractAndSaveMarkdownImages,
  type SavedImage,
} from "@/lib/extract-source-images"
import { captionMarkdownImages } from "@/lib/image-caption-pipeline"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { detectLanguage } from "@/lib/detect-language"
import { sameScriptFamily } from "@/lib/language-metadata"
import {
  loadProjectWikiSchemaRouting,
  validateWikiPageRouting,
} from "@/lib/wiki-schema"

import { parseFileBlocks, FILE_BLOCK_REGEX, requireBlocks, isSafeIngestPath } from "./file-blocks"
import {
  buildAnalysisPrompt,
  buildGenerationPrompt,
  buildAggregatePrompt,
  buildPageMergeSystemPrompt,
  buildReviewSuggestionPrompt,
  languageRule,
} from "./prompts"
import {
  currentWikiDate,
  stampGeneratedFrontmatterDates,
  isListingPath,
  isAppManagedAggregatePath,
  computeIngestSourceBudget,
  computeIngestGenerationMaxTokens,
  computeIngestReviewMaxTokens,
  trimInlineStatus,
  injectSourcesField,
  formatIngestWarningLogEntry,
  REVIEW_STAGE_MIN_SIGNAL_CHARS,
  REVIEW_STAGE_MIN_FILE_BLOCKS,
} from "./utils"
import {
  ingestImageExtractionPromises,
  imageExtractionKey,
  extractSourceImagesOnceByKey,
  extractSourceImagesOnce,
  promptImageUrlToAbs,
  stripWikiMediaAbsPaths,
  sourceSummaryMediaRefsForExternalMarkdown,
  resolveCaptionConfig,
  injectImagesIntoSourceSummary,
  appendSavedImageRefsForCaption,
} from "./images"

import { compressLongSource } from "./long-source"

import { wikiIndex } from "./index-records"
import { IngestError, LlmApiError, type IngestErrorCategory } from "./errors"

// ── Stage Resume Sentinel ──

const NO_NEED_RESTORE = Symbol.for("NO_NEED_RESTORE")
const NEED_RESTORE = Symbol.for("NEED_RESTORE")

// ── Helper Functions ──

function getStore() {
  return useChatStore.getState()
}

async function tryReadFile(path: string): Promise<string> {
  try {
    return await readFile(path)
  } catch {
    return ""
  }
}

async function tryReadSourceTextFile(path: string): Promise<string> {
  try {
    return await readFile(path, { extractImages: false })
  } catch {
    return ""
  }
}

async function logDiag(pp: string, message: string): Promise<void> {
  try {
    const logPath = `${pp}/wiki/ingest-diag.log`
    const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19)
    const existing = await readFile(logPath).catch(() => "")
    await writeFile(logPath, existing + `[${timestamp}] ${message}\n`)
  } catch {
    // non-critical
  }
}

function classifyLlmError(err: Error): IngestErrorCategory {
  if (!(err instanceof LlmApiError)) return "unknown"
  if (err.httpStatus !== undefined) return "network"
  if (err.message.includes("timed out")) return "network"
  if (err.message.includes("Network error")) return "network"
  return "unknown"
}

function throwIfIngestAborted(signal: AbortSignal | undefined, activityId?: string): void {
  if (!signal?.aborted) return
  if (activityId) {
    useActivityStore.getState().updateItem(activityId, {
      status: "error",
      detail: "Ingest cancelled",
    })
  }
  throw new IngestError("cancelled", "Ingest cancelled")
}

async function appendIngestWarningLog(
  projectPath: string,
  sourceIdentity: string,
  warnings: readonly string[],
): Promise<void> {
  if (warnings.length === 0) return
  const logPath = `${projectPath}/.llm-wiki/ingest-warnings.log`
  try {
    await createDirectory(`${projectPath}/.llm-wiki`)
    const existing = await tryReadFile(logPath)
    const next = `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${formatIngestWarningLogEntry(sourceIdentity, warnings).trimEnd()}\n`
    await writeFile(logPath, next)
  } catch (err) {
    console.warn(
      `[ingest] Failed to write ingest warning log for "${sourceIdentity}":`,
      err instanceof Error ? err.message : err,
    )
  }
}

// ── Content Language Guard ──

function contentMatchesTargetLanguage(content: string, target: string): boolean {
  const fmEnd = content.indexOf("\n---\n", 3)
  let body = fmEnd > 0 ? content.slice(fmEnd + 5) : content
  body = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\$\$[\s\S]*?\$\$/g, "")
    .replace(/\$[^$\n]*\$/g, "")
  const sample = body.slice(0, 1500)
  if (sample.trim().length < 20) return true

  const detected = detectLanguage(sample)
  const cjk = new Set(["Chinese", "Traditional Chinese", "Japanese", "Korean"])
  const distinctNonLatin = new Set(["Arabic", "Persian", "Hindi", "Thai", "Hebrew"])
  const targetIsCjk = cjk.has(target)
  const detectedIsCjk = cjk.has(detected)
  if (targetIsCjk) return detectedIsCjk
  if (distinctNonLatin.has(target)) return detected === target
  if (distinctNonLatin.has(detected)) return sameScriptFamily(target, detected)
  return !detectedIsCjk
}

// ── Page Manifest Extraction ──

function extractPageManifest(analysis: string): ManifestPage[] {
  const pages: ManifestPage[] = []
  const entityRe = /\*\*entity\*\*:\s*`([^`]+)`\s*-\s*(.+)$/gmi
  const conceptRe = /\*\*concept\*\*:\s*`([^`]+)`\s*-\s*(.+)$/gmi
  for (const match of analysis.matchAll(entityRe)) {
    const slug = match[1].replace(/\.md$/i, "")
    const title = match[2].trim()
    if (slug && title) pages.push({ type: "entity", slug, title })
  }
  for (const match of analysis.matchAll(conceptRe)) {
    const slug = match[1].replace(/\.md$/i, "")
    const title = match[2].trim()
    if (slug && title) pages.push({ type: "concept", slug, title })
  }
  return pages
}

interface AnalysisParams {
  pp: string
  llmConfig: LlmConfig
  sourceIdentity: string
  folderContext: string | undefined
  sourceContext: string
  purpose: string
  relatedPages: string
  schema: string
  signal: AbortSignal | undefined
  activityId?: string
}

interface AnalysisResult {
  analysis: string
  manifestPages: ManifestPage[]
  manifestEntitySlugs: Set<string>
  manifestConceptSlugs: Set<string>
  pendingSlugs: Set<string>
  enrichedRelatedPages: string
}

async function runAnalysis(params: AnalysisParams): Promise<AnalysisResult> {
  const { pp, llmConfig, sourceIdentity, folderContext, sourceContext, purpose, relatedPages, schema, signal, activityId } = params

  const relatedPageCount = countRelatedPages(relatedPages)
  await logDiag(pp, `Stage analysis: sending analysis request (related pages=${relatedPageCount})...`)
  let analysis = ""
  const analysisMessages: ChatMessage[] = [
    { role: "system", content: buildAnalysisPrompt(purpose, relatedPages, sourceContext, schema) },
    { role: "user", content: `Analyze this source document:\n\n**File:** ${sourceIdentity}${folderContext ? `\n**Folder context:** ${folderContext}` : ""}\n\n---\n\n${sourceContext}` },
  ]
  let analysisReasoning = ""
  try { await writeFile(`${pp}/wiki/ingest-step1-prompt.log`, JSON.stringify(analysisMessages, null, 2)) } catch {}
  await streamChat(
    llmConfig,
    analysisMessages,
    {
      onToken: (token) => { analysis += token },
      onDone: () => {},
      onError: (err) => {
        throw new IngestError(classifyLlmError(err), `Analysis failed: ${err.message}`, err)
      },
      onReasoningToken: (token) => { analysisReasoning += token },
    },
    signal,
    { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: 4096 },
  )
  try { await writeFile(`${pp}/wiki/ingest-step1-reasoning.log`, analysisReasoning) } catch {}

  throwIfIngestAborted(signal, activityId)

  await logDiag(pp, `Stage analysis complete — analysis.length=${analysis?.length ?? 0}`)
  try { await writeFile(`${pp}/wiki/ingest-step1.log`, analysis ?? "(empty)") } catch {}
  if (!analysis?.trim()) {
    throw new IngestError("llm_output", `Analysis generation returned empty output for "${sourceIdentity}"`)
  }

  const { blocks: analysisBlocks } = parseFileBlocks(analysis)
  requireBlocks(analysisBlocks, "Analysis", { requiredPaths: ["wiki/.manifest"] })
  const manifestBlock = analysisBlocks.find((b) => b.path === "wiki/.manifest")!
  const manifestPages = extractPageManifest(manifestBlock.content)
  const manifestEntitySlugs = new Set(
    manifestPages.filter(p => p.type === "entity").map(p => p.slug),
  )
  const manifestConceptSlugs = new Set(
    manifestPages.filter(p => p.type === "concept").map(p => p.slug),
  )
  const pendingSlugs = new Set(manifestPages.map(p => p.slug))
  const enrichedRelatedPages = mergeRelatedPages(relatedPages, manifestPages)
  await logDiag(pp, `Stage analysis manifest: ${manifestPages.length} pages (${manifestEntitySlugs.size} entities, ${manifestConceptSlugs.size} concepts)`)

  return { analysis, manifestPages, manifestEntitySlugs, manifestConceptSlugs, pendingSlugs, enrichedRelatedPages }
}

// ── Entity Page Generation ──

interface EntityPageParams {
  pp: string
  llmConfig: LlmConfig
  sourceIdentity: string
  sourceSummaryPath: string
  sourceContext: string
  analysis: string
  relatedPages: string
  schema: string
  purpose: string
  overview: string
  signal?: AbortSignal
  onFileWritten?: (relativePath: string) => void
  activityId?: string
}

interface EntityPageResult {
  entityGeneration: string
  writtenPaths: string[]
  writeWarnings: string[]
  hardFailures: string[]
}

async function runEntityPageGeneration(params: EntityPageParams): Promise<EntityPageResult> {
  const { pp, llmConfig, sourceIdentity, sourceSummaryPath, sourceContext, analysis, relatedPages, schema, purpose, overview, signal, onFileWritten, activityId } = params

  const manifestPages = extractPageManifest(analysis)
  const pendingSlugs = new Set(manifestPages.map(p => p.slug))
  const enrichedRelatedPages = mergeRelatedPages(relatedPages, manifestPages)

  await logDiag(pp, "Stage entity: sending entity generation request...")

  const entityMessages: ChatMessage[] = [
    { role: "system", content: buildGenerationPrompt(schema, purpose, enrichedRelatedPages, sourceIdentity, overview, sourceContext, "entities") },
    {
      role: "user",
      content: [
        `Source document to process: **${sourceIdentity}**`,
        "",
        "The Stage 1 analysis below is CONTEXT to inform your output. Do NOT echo",
        "its tables, bullet points, or prose. Your output must be FILE/REVIEW",
        "blocks as specified in the system prompt — nothing else.",
        "",
        "## Stage 1 Analysis (context only — do not repeat)",
        "",
        analysis,
        "",
        "## Source Context",
        "",
        sourceContext,
        "",
        "---",
        "",
        `Now emit the FILE blocks for entity pages derived from **${sourceIdentity}**.`,
        "Your response MUST begin with `---FILE:` as the very first characters.",
        "No preamble. No analysis prose. Start immediately.",
        "Do NOT generate concept, summary, index, overview, or log pages.",
        "Only generate entity pages.",
      ].join("\n"),
    },
  ]
  try { await writeFile(`${pp}/wiki/ingest-step2a-entity-prompt.log`, JSON.stringify(entityMessages, null, 2)) } catch {}
  let entityGeneration = ""
  let entityReasoning = ""
  let hadError = false
  await streamChat(
    llmConfig,
    entityMessages,
    {
      onToken: (token) => { entityGeneration += token },
      onDone: () => {},
      onError: () => {
        hadError = true
      },
      onReasoningToken: (token) => { entityReasoning += token },
    },
    signal,
    { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: computeIngestGenerationMaxTokens(llmConfig.maxContextSize) },
  )
  await logDiag(pp, `Stage entity generation — length=${entityGeneration.length}`)
  try { await writeFile(`${pp}/wiki/ingest-step2a-entity.log`, entityGeneration) } catch {}
  try { await writeFile(`${pp}/wiki/ingest-step2a-entity-reasoning.log`, entityReasoning) } catch {}

  if (hadError) throw new IngestError("system", "Entity page generation failed")
  if (!entityGeneration.trim()) {
    throw new IngestError("llm_output", `Entity page generation returned empty output for "${sourceIdentity}"`)
  }
  throwIfIngestAborted(signal, activityId)

  const entityWriteResult = await writeFileBlocksWithConflictCheck(pp, entityGeneration, llmConfig, sourceIdentity, sourceSummaryPath, signal, enrichedRelatedPages, activityId)
  if (entityWriteResult.writtenPaths.length === 0) {
    throw new IngestError("llm_output", `Entity page generation produced no valid FILE blocks for "${sourceIdentity}"`)
  }
  await appendIngestWarningLog(pp, sourceIdentity, entityWriteResult.warnings)

  for (const p of entityWriteResult.writtenPaths) {
    onFileWritten?.(p)
  }
  await logDiag(pp, `Stage entity writeFileBlocks returned ${entityWriteResult.writtenPaths.length} entity paths`)

  for (const p of entityWriteResult.writtenPaths) {
    const slug = p.replace(/^wiki\/[^/]+\//, "").replace(/\.md$/, "")
    pendingSlugs.delete(slug)
  }
  await cleanupRelated(pp, entityWriteResult.writtenPaths, pendingSlugs)

  return {
    entityGeneration,
    writtenPaths: entityWriteResult.writtenPaths,
    writeWarnings: entityWriteResult.warnings,
    hardFailures: entityWriteResult.hardFailures,
  }
}

// ── Concept Page Generation ──

interface ConceptPageParams {
  pp: string
  llmConfig: LlmConfig
  sourceIdentity: string
  sourceSummaryPath: string
  sourceContext: string
  analysis: string
  relatedPages: string
  schema: string
  purpose: string
  overview: string
  accumulatedWrittenPaths: string[]
  accumulatedWarnings: string[]
  accumulatedHardFailures: string[]
  signal?: AbortSignal
  onFileWritten?: (relativePath: string) => void
  activityId?: string
}

interface ConceptPageResult {
  conceptGeneration: string
  writtenPaths: string[]
  writeWarnings: string[]
  hardFailures: string[]
}

async function runConceptPageGeneration(params: ConceptPageParams): Promise<ConceptPageResult> {
  const { pp, llmConfig, sourceIdentity, sourceSummaryPath, sourceContext, analysis, relatedPages, schema, purpose, overview, accumulatedWrittenPaths, accumulatedWarnings, accumulatedHardFailures, signal, onFileWritten, activityId } = params

  const manifestPages = extractPageManifest(analysis)
  const enrichedRelatedPages = mergeRelatedPages(relatedPages, manifestPages)
  const pendingSlugs = new Set(manifestPages.map(p => p.slug))

  await logDiag(pp, "Stage concept: sending concept generation request...")

  let conceptGeneration = ""
  const conceptMessages: ChatMessage[] = [
    { role: "system", content: buildGenerationPrompt(schema, purpose, enrichedRelatedPages, sourceIdentity, overview, sourceContext, "concepts") },
    {
      role: "user",
      content: [
        `Source document to process: **${sourceIdentity}**`,
        "",
        "The Stage 1 analysis below is CONTEXT to inform your output. Do NOT echo",
        "its tables, bullet points, or prose. Your output must be FILE/REVIEW",
        "blocks as specified in the system prompt — nothing else.",
        "",
        "## Stage 1 Analysis (context only — do not repeat)",
        "",
        analysis,
        "",
        "## Source Context",
        "",
        sourceContext,
        "",
        "---",
        "",
        `Now emit the FILE blocks for concept pages derived from **${sourceIdentity}**.`,
        "Your response MUST begin with `---FILE:` as the very first characters.",
        "No preamble. No analysis prose. Start immediately.",
        "Do NOT generate entity, summary, index, overview, or log pages.",
        "Only generate concept pages.",
      ].join("\n"),
    },
  ]
  let conceptReasoning = ""
  try { await writeFile(`${pp}/wiki/ingest-step2a-concept-prompt.log`, JSON.stringify(conceptMessages, null, 2)) } catch {}
  let hadError = false
  await streamChat(
    llmConfig,
    conceptMessages,
    {
      onToken: (token) => { conceptGeneration += token },
      onDone: () => {},
      onError: () => {
        hadError = true
      },
      onReasoningToken: (token) => { conceptReasoning += token },
    },
    signal,
    { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: computeIngestGenerationMaxTokens(llmConfig.maxContextSize) },
  )
  await logDiag(pp, `Stage concept generation — length=${conceptGeneration.length}`)
  try { await writeFile(`${pp}/wiki/ingest-step2a-concept.log`, conceptGeneration) } catch {}
  try { await writeFile(`${pp}/wiki/ingest-step2a-concept-reasoning.log`, conceptReasoning) } catch {}

  if (hadError) throw new IngestError("system", "Concept page generation failed")
  if (!conceptGeneration.trim()) {
    throw new IngestError("llm_output", `Concept page generation returned empty output for "${sourceIdentity}"`)
  }
  throwIfIngestAborted(signal, activityId)

  const conceptWriteResult = await writeFileBlocksWithConflictCheck(pp, conceptGeneration, llmConfig, sourceIdentity, sourceSummaryPath, signal, enrichedRelatedPages, activityId)
  if (conceptWriteResult.writtenPaths.length === 0) {
    throw new IngestError("llm_output", `Concept page generation produced no valid FILE blocks for "${sourceIdentity}"`)
  }
  await appendIngestWarningLog(pp, sourceIdentity, conceptWriteResult.warnings)

  const allWrittenPaths = [...accumulatedWrittenPaths, ...conceptWriteResult.writtenPaths]
  const allWarnings = [...accumulatedWarnings, ...conceptWriteResult.warnings]
  const allHardFailures = [...accumulatedHardFailures, ...conceptWriteResult.hardFailures]

  for (const p of conceptWriteResult.writtenPaths) {
    onFileWritten?.(p)
  }
  await logDiag(pp, `Stage concept writeFileBlocks returned ${conceptWriteResult.writtenPaths.length} concept paths`)

  for (const p of conceptWriteResult.writtenPaths) {
    const slug = p.replace(/^wiki\/[^/]+\//, "").replace(/\.md$/, "")
    pendingSlugs.delete(slug)
  }
  await cleanupRelated(pp, allWrittenPaths, pendingSlugs)

  return {
    conceptGeneration,
    writtenPaths: allWrittenPaths,
    writeWarnings: allWarnings,
    hardFailures: allHardFailures,
  }
}

// ── Source Summary Page Generation ──

interface SourceSummaryPageParams {
  pp: string
  llmConfig: LlmConfig
  sourceIdentity: string
  sourceSummaryPath: string
  sourceContext: string
  analysis: string
  schema: string
  accumulatedWrittenPaths: string[]
  accumulatedWarnings: string[]
  accumulatedHardFailures: string[]
  signal?: AbortSignal
  onFileWritten?: (relativePath: string) => void
  activityId?: string
}

interface SourceSummaryPageResult {
  summaryGeneration: string
  summaryRelated: string[]
  writtenPaths: string[]
  writeWarnings: string[]
  hardFailures: string[]
}

async function runSourceSummaryPageGeneration(params: SourceSummaryPageParams): Promise<SourceSummaryPageResult> {
  const { pp, llmConfig, sourceIdentity, sourceSummaryPath, sourceContext, analysis, schema, accumulatedWrittenPaths, accumulatedWarnings, accumulatedHardFailures, signal, onFileWritten, activityId } = params

  await logDiag(pp, "Stage summary: sending source summary generation request...")

  const generatedSlugs = accumulatedWrittenPaths
    .filter((p) => !isListingPath(p) && !p.startsWith("wiki/sources/"))
    .map((p) => p.replace(/^wiki\/[^/]+\//, "").replace(/\.md$/, ""))
  const generatedSlugsBlock = generatedSlugs.length > 0
    ? generatedSlugs.map((s) => `- ${s}`).join("\n")
    : "(no entity or concept pages)"
  const summaryRelatedPages = await searchRelatedWikiPages(pp, sourceIdentity, sourceContext)

  let summaryGeneration = ""
  const summaryMessages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You are a wiki maintainer. Generate a single source summary page.",
        languageRule(sourceContext),
        "",
        `The original source file is: **${sourceIdentity}**`,
        `Today's date is **${currentWikiDate()}**.`,
        schema ? `## Project Schema\n${schema}` : "",
        "",
        "## Pages Generated From This Source (authoritative slug list)",
        generatedSlugsBlock,
        "",
        summaryRelatedPages,
        "",
        "## What to generate",
        "",
        `A single source summary page at **${sourceSummaryPath}**.`,
        "",
        "## Frontmatter Rules",
        "",
        "1. The VERY FIRST line MUST be exactly `---`.",
        "2. Arrays use inline YAML form: `[a, b, c]`.",
        "3. required fields: type (must be \"source\"), title, created, updated, tags, related.",
        "4. `related` must include slugs for ALL entity and concept pages derived from this source.",
        "   All `related` slugs MUST be selected from the authoritative slug list above —",
        "   do NOT invent slugs that are not present in the generated pages list.",
        "5. `tags` should summarize the key topics.",
        "",
        "## Output Format (STRICT — deviations will cause parse failure)",
        "",
        "1. The FIRST character of your response MUST be `-` (the opening of `---FILE:`).",
        "2. DO NOT output any preamble such as \"Here is the file:\", \"Based on the analysis...\", or any introductory prose.",
        "3. Your response MUST end with exactly `---END FILE---` on its own line. If the parser does not find `---END FILE---`, your entire output is discarded.",
        "4. Your ENTIRE response is a single FILE block — nothing else.",
        "",
        "FILE block template:",
        "```",
        `---FILE: ${sourceSummaryPath}---`,
        "(complete file content with YAML frontmatter)",
        "---END FILE---",
        "```",
        "",
        "If you start with anything other than `---FILE:`, the entire response will be discarded.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Generate the source summary page for **${sourceIdentity}**.`,
        "",
        "## Stage 1 Analysis",
        "",
        analysis,
        "",
        "## Source Text",
        "",
        sourceContext,
        "",
        "---",
        "",
        `Now emit the FILE block for the source summary page at ${sourceSummaryPath}.`,
        "Your response MUST begin with `---FILE:`.",
        "No preamble. No analysis prose. Start immediately.",
      ].join("\n"),
    },
  ]
  try { await writeFile(`${pp}/wiki/ingest-step2b-prompt.log`, JSON.stringify(summaryMessages, null, 2)) } catch {}
  let summaryReasoning = ""
  await streamChat(
    llmConfig,
    summaryMessages,
    {
      onToken: (token) => { summaryGeneration += token },
      onDone: () => {},
      onError: (err) => {
        logDiag(pp, `Stage summary LLM error: ${err.message}`)
        console.warn(`[ingest] Summary generation failed: ${err.message}`)
      },
      onReasoningToken: (token) => { summaryReasoning += token },
    },
    signal,
    { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: computeIngestGenerationMaxTokens(llmConfig.maxContextSize) },
  )
  await logDiag(pp, `Stage summary complete — generation.length=${summaryGeneration.length}`)
  try { await writeFile(`${pp}/wiki/ingest-step2b.log`, summaryGeneration) } catch {}
  try { await writeFile(`${pp}/wiki/ingest-step2b-reasoning.log`, summaryReasoning) } catch {}

  if (!summaryGeneration.trim()) {
    throw new IngestError("llm_output", `Source summary generation returned empty output for "${sourceIdentity}"`)
  }
  throwIfIngestAborted(signal, activityId)

  const summaryWriteResult = await writeFileBlocksWithConflictCheck(pp, summaryGeneration, llmConfig, sourceIdentity, sourceSummaryPath, signal, undefined, activityId)
  if (!summaryWriteResult.writtenPaths.includes(sourceSummaryPath)) {
    await logDiag(pp, `SUMMARY VALIDATION FAILED: expected "${sourceSummaryPath}" in writtenPaths, got [${summaryWriteResult.writtenPaths.join(", ")}], hardFailures=[${summaryWriteResult.hardFailures.join(", ")}]`)
    throw new IngestError("llm_output",
      `Source summary page "${sourceSummaryPath}" was not generated — ` +
      `LLM output had ${summaryWriteResult.writtenPaths.length} block(s), expected 1. ` +
      `Check ingest-step2b.log for the raw output.`
    )
  }
  await appendIngestWarningLog(pp, sourceIdentity, summaryWriteResult.warnings)

  const allWrittenPaths = [...accumulatedWrittenPaths, ...summaryWriteResult.writtenPaths]
  const allWarnings = [...accumulatedWarnings, ...summaryWriteResult.warnings]
  const allHardFailures = [...accumulatedHardFailures, ...summaryWriteResult.hardFailures]

  for (const p of summaryWriteResult.writtenPaths) {
    onFileWritten?.(p)
  }
  await logDiag(pp, `Stage summary writeFileBlocks returned ${summaryWriteResult.writtenPaths.length} paths`)

  const summaryRelated: string[] = parseFrontmatterArray(
    await tryReadFile(`${pp}/${sourceSummaryPath}`),
    "related",
  ) ?? []

  return {
    summaryGeneration,
    summaryRelated,
    writtenPaths: allWrittenPaths,
    writeWarnings: allWarnings,
    hardFailures: allHardFailures,
  }
}

// ── Aggregate Page Generation ──

interface AggregatePageParams {
  pp: string
  llmConfig: LlmConfig
  sourceIdentity: string
  sourceContext: string
  analysis: string
  purpose: string
  overview: string
  summaryRelated: string[]
  accumulatedWrittenPaths: string[]
  accumulatedWarnings: string[]
  accumulatedHardFailures: string[]
  signal?: AbortSignal
  onFileWritten?: (relativePath: string) => void
  activityId?: string
}

interface AggregatePageResult {
  aggregateGeneration: string
  writtenPaths: string[]
  writeWarnings: string[]
  hardFailures: string[]
}

async function runAggregatePageGeneration(params: AggregatePageParams): Promise<AggregatePageResult> {
  const { pp, llmConfig, sourceIdentity, analysis, purpose, overview, summaryRelated, accumulatedWrittenPaths, accumulatedWarnings, accumulatedHardFailures, signal, onFileWritten, activityId } = params

  // Resolve entity/concept page contents from slugs
  const resolvedPages = await Promise.all(
    summaryRelated.map(async (rawSlug) => {
      const slug = rawSlug.replace(/\.md$/, "")
      const entityPath = `wiki/entities/${slug}.md`
      const conceptPath = `wiki/concepts/${slug}.md`
      const entityContent = await tryReadFile(`${pp}/${entityPath}`)
      if (entityContent) return { path: entityPath, content: entityContent }
      const conceptContent = await tryReadFile(`${pp}/${conceptPath}`)
      if (conceptContent) return { path: conceptPath, content: conceptContent }
      return null
    }),
  )
  const contentPagePaths = resolvedPages
    .filter((x): x is { path: string; content: string } => x !== null)
    .map((x) => x.path)
  const contentPageContents = resolvedPages
    .filter((x): x is { path: string; content: string } => x !== null)
    .map((x) => x.content)
  const aggregateIndexContext = (await tryReadFile(`${pp}/wiki/index.md`)) ?? ""

  await logDiag(pp, "Stage aggregate: sending aggregate generation request...")

  let aggregateGeneration = ""
  const aggregateMessages: ChatMessage[] = [
    {
      role: "system",
      content: buildAggregatePrompt(
        contentPagePaths, contentPageContents, purpose,
        aggregateIndexContext, overview, sourceIdentity,
        analysis, llmConfig.maxContextSize,
      ),
    },
    { role: "user", content: "Generate the aggregate wiki files now. Start immediately with `---FILE:`." },
  ]
  try { await writeFile(`${pp}/wiki/ingest-step3-prompt.log`, JSON.stringify(aggregateMessages, null, 2)) } catch {}
  let aggregateReasoning = ""
  await streamChat(
    llmConfig,
    aggregateMessages,
    {
      onToken: (token) => { aggregateGeneration += token },
      onDone: () => {},
      onError: (err) => {
        throw new IngestError(classifyLlmError(err), `Aggregate generation failed: ${err.message}`, err)
      },
      onReasoningToken: (token) => { aggregateReasoning += token },
    },
    signal,
    { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: computeIngestGenerationMaxTokens(llmConfig.maxContextSize) },
  )
  await logDiag(pp, `Stage aggregate complete — generation.length=${aggregateGeneration.length}`)
  try { await writeFile(`${pp}/wiki/ingest-step3.log`, aggregateGeneration) } catch {}
  try { await writeFile(`${pp}/wiki/ingest-step3-reasoning.log`, aggregateReasoning) } catch {}

  if (!aggregateGeneration.trim()) {
    throw new IngestError("llm_output", `Aggregate (overview) generation returned empty output for "${sourceIdentity}"`)
  }
  throwIfIngestAborted(signal, activityId)

  const aggWriteResult = await writeAggregateFileBlocks(pp, aggregateGeneration, llmConfig, sourceIdentity, signal, activityId)
  await appendIngestWarningLog(pp, sourceIdentity, aggWriteResult.warnings)
  const allWrittenPaths = [...accumulatedWrittenPaths, ...aggWriteResult.writtenPaths]
  const allWarnings = [...accumulatedWarnings, ...aggWriteResult.warnings]
  const allHardFailures = [...accumulatedHardFailures, ...aggWriteResult.hardFailures]

  for (const p of aggWriteResult.writtenPaths) {
    onFileWritten?.(p)
  }
  await logDiag(pp, `Stage aggregate merge returned ${aggWriteResult.writtenPaths.length} paths`)

  return {
    aggregateGeneration,
    writtenPaths: allWrittenPaths,
    writeWarnings: allWarnings,
    hardFailures: allHardFailures,
  }
}

// ── Review Suggestion ──

interface ReviewSuggestionParams {
  pp: string
  llmConfig: LlmConfig
  sourceIdentity: string
  sourceContext: string
  analysis: string
  relatedPages: string
  purpose: string
  entityGeneration: string
  conceptGeneration: string
  signal?: AbortSignal
  activityId?: string
}

interface ReviewSuggestionResult {
  reviewSuggestionOutput: string
}

async function runReviewSuggestion(params: ReviewSuggestionParams): Promise<ReviewSuggestionResult> {
  const { pp, llmConfig, sourceIdentity, sourceContext, analysis, entityGeneration, conceptGeneration, signal, activityId } = params

  const allGeneration = entityGeneration + conceptGeneration
  let reviewSuggestionOutput = ""
  await logDiag(pp, `reviewSuggestion: shouldRun=${!signal?.aborted && shouldRunDedicatedReviewStage(allGeneration)}, allGeneration.length=${allGeneration.length}`)

  if (!signal?.aborted && shouldRunDedicatedReviewStage(allGeneration)) {
    let reviewStageHadError = false
    try {
      await streamChat(
        llmConfig,
        [
          { role: "system", content: buildReviewSuggestionPrompt(sourceIdentity, analysis, sourceContext, allGeneration, llmConfig.maxContextSize) },
          { role: "user", content: "Emit only high-value REVIEW blocks for follow-up research or unresolved knowledge gaps. Output nothing if there are none." },
        ],
        {
          onToken: (token) => { reviewSuggestionOutput += token },
          onDone: () => {},
          onError: (err) => {
            reviewStageHadError = true
            console.warn(`[ingest] Review suggestion generation failed for "${sourceIdentity}": ${err.message}`)
          },
        },
        signal,
        { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: computeIngestReviewMaxTokens(llmConfig.maxContextSize) },
      )
    } catch (err) {
      throwIfIngestAborted(signal, activityId)
      console.warn(`[ingest] Review suggestion generation failed for "${sourceIdentity}":`, err)
    }
    throwIfIngestAborted(signal, activityId)
    if (reviewStageHadError) reviewSuggestionOutput = ""
  }

  return { reviewSuggestionOutput }
}

// ── Related Links Cleanup ──

async function cleanupRelated(pp: string, writtenPaths: string[], pendingSlugs: Set<string>): Promise<void> {
  for (const wpath of writtenPaths) {
    const fullPath = `${pp}/${wpath}`
    const content = await tryReadFile(fullPath)
    if (!content) continue
    const existing = parseFrontmatterArray(content, "related") ?? []
    const filtered = existing.filter((slug: string) => !pendingSlugs.has(slug))
    if (filtered.length !== existing.length) {
      const updated = writeFrontmatterArray(content, "related", filtered)
      await writeFile(fullPath, updated)
    }
  }
}

// ── Review Block Parsing ──

function parseReviewBlocks(text: string, sourceFileName: string): Omit<ReviewItem, "id" | "resolved" | "createdAt">[] {
  const items: Omit<ReviewItem, "id" | "resolved" | "createdAt">[] = []
  const reviewRe = /---REVIEW:\s*([^|]+?)\s*\|\s*(.+?)\s*---\n([\s\S]*?)---END REVIEW---/g
  for (const match of text.matchAll(reviewRe)) {
    const type = match[1].trim().toLowerCase() as ReviewItem["type"]
    const title = match[2].trim()
    const body = match[3].trim()
    const optionsMatch = body.match(/OPTIONS:\s*(.+)/)
    const pagesMatch = body.match(/PAGES:\s*(.+)/)
    const searchMatch = body.match(/SEARCH:\s*(.+)/)
    const description = body
      .replace(/OPTIONS:\s*.+/, "")
      .replace(/PAGES:\s*.+/, "")
      .replace(/SEARCH:\s*.+/, "")
      .trim()
    items.push({
      type,
      title,
      description: description || title,
      sourcePath: sourceFileName,
      options: optionsMatch
        ? optionsMatch[1].split("|").map((s: string) => ({ label: s.trim(), action: s.trim() }))
        : [{ label: "Create Page", action: "Create Page" }, { label: "Skip", action: "Skip" }],
      affectedPages: pagesMatch
        ? pagesMatch[1].split(",").map((s: string) => s.trim())
        : [],
      searchQueries: searchMatch
        ? searchMatch[1].split("|").map((s: string) => s.trim())
        : [],
    })
  }
  return items
}

function shouldRunDedicatedReviewStage(allGeneration: string): boolean {
  return (
    allGeneration.length >= REVIEW_STAGE_MIN_SIGNAL_CHARS &&
    (allGeneration.match(/---REVIEW:/g) || []).length < REVIEW_STAGE_MIN_FILE_BLOCKS
  )
}

// ── Related Slugs Sanitization ──

async function sanitizeRelatedSlugs(
  content: string,
  relatedPages: string,
  projectPath: string,
): Promise<string> {
  const allowedSlugs = new Set<string>()
  for (const line of relatedPages.split("\n")) {
    const trimmed = line.trim()
    // Primary format: markdown table rows `| slug | title | type |`
    // (matches how mergeRelatedPages/formatRelatedPages emit related pages).
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const parts = trimmed.split("|").map((s) => s.trim()).filter(Boolean)
      if (parts.length >= 3 && parts[0] && parts[0] !== "slug" && !/^-+$/.test(parts[0])) {
        allowedSlugs.add(parts[0].replace(/\.md$/, ""))
      }
      continue
    }
    // Legacy fallback: backtick-wrapped slugs `slug`.
    const slugMatch = line.match(/`([^`]+)`/)
    if (slugMatch) allowedSlugs.add(slugMatch[1].replace(/\.md$/, ""))
  }

  const related = parseFrontmatterArray(content, "related")
  if (!related || related.length === 0) return content

  const validSlugs: string[] = []
  for (const slug of related) {
    if (allowedSlugs.has(slug)) {
      validSlugs.push(slug)
      continue
    }
    // Check if the slug exists on disk as a fallback
    const entityPath = `${projectPath}/wiki/entities/${slug}.md`
    const conceptPath = `${projectPath}/wiki/concepts/${slug}.md`
    try {
      if (await fileExists(entityPath) || await fileExists(conceptPath)) {
        validSlugs.push(slug)
      }
    } catch {
      // ignore
    }
  }

  return writeFrontmatterArray(content, "related", validSlugs)
}

/**
 * Count the data rows in a related-pages markdown table
 * (`| slug | title | type |`), skipping the header and separator rows.
 * Used only for diagnostic logging.
 */
function countRelatedPages(relatedPages: string): number {
  if (!relatedPages) return 0
  let count = 0
  for (const line of relatedPages.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue
    const parts = trimmed.split("|").map((s) => s.trim()).filter(Boolean)
    if (parts.length >= 3 && parts[0] && parts[0] !== "slug" && !/^-+$/.test(parts[0])) {
      count++
    }
  }
  return count
}

// ── Index Management ──

function extractTitleFromContent(content: string): string {
  const parsed = parseFrontmatter(content)
  if (typeof parsed.frontmatter?.title === "string") return parsed.frontmatter.title
  const headingMatch = content.match(/^#\s+(.+)$/m)
  return headingMatch ? headingMatch[1].trim() : ""
}

// ── Page Merger Builder ──

function buildPageMerger(llmConfig: LlmConfig): MergeFn {
  return async (existingContent, incomingContent, sourceFileName, signal) => {
    const systemPrompt = buildPageMergeSystemPrompt()

    const userMessage = [
      `## Existing version on disk`,
      "",
      existingContent,
      "",
      "---",
      "",
      `## Newly generated version (from ${sourceFileName})`,
      "",
      incomingContent,
      "",
      "---",
      "",
      "Now output the merged file. Start with `---` on the first line.",
    ].join("\n")

    let result = ""
    const { error } = await new Promise<{ error?: Error }>((resolve) => {
      streamChat(
        llmConfig,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        {
          onToken: (token) => {
            result += token
          },
          onDone: () => resolve({}),
          onError: (err) => resolve({ error: err }),
        },
        signal,
        { temperature: 0.1 },
      ).catch((err) => {
        resolve({ error: err instanceof Error ? err : new Error(String(err)) })
      })
    })
    if (error) {
      throw new IngestError(
        classifyLlmError(error),
        `Page merge failed: ${error.message}`,
        error,
      )
    }
    return result
  }
}

// ── Page Backup ──

async function backupExistingPage(
  projectPath: string,
  relativePath: string,
  existingContent: string,
): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const sanitized = relativePath.replace(/[/\\]/g, "_")
  const backupPath = `${projectPath}/.llm-wiki/page-history/${sanitized}-${stamp}`
  await writeFile(backupPath, existingContent)
}

// ── Conflict detection ──

async function appendMergeHistoryLog(
  projectPath: string,
  event: "merge" | "delete" | "register",
  slug: string,
  sourceFileName: string,
  beforeContent?: string,
  afterContent?: string,
): Promise<void> {
  try {
    const logPath = `${projectPath}/.llm-wiki/ingest-merge-history.log`
    const timestamp = new Date().toISOString()
    const entry: Record<string, unknown> = {
      timestamp,
      event,
      slug,
      sourceFileName,
      beforeContent,
      afterContent,
    }
    await createDirectory(`${projectPath}/.llm-wiki`)
    const existing = await readFile(logPath).catch(() => "")
    await writeFile(logPath, existing + JSON.stringify(entry) + "\n")
  } catch {
    // non-critical
  }
}

function detectEntityConceptConflicts(relativePath: string, content: string): string[] {
  const isEntity = relativePath.startsWith("wiki/entities/")
  const isConcept = relativePath.startsWith("wiki/concepts/")
  if (!isEntity && !isConcept) return []

  const slug = relativePath.replace(/^wiki\/[^/]+\//, "").replace(/\.md$/, "")
  const found = new Set<string>()

  // Slug conflict: check if a page already exists with this slug
  const bySlug = wikiIndex.findBySlug(slug)
  if (bySlug && bySlug.path !== relativePath) {
    console.log(`[wikiIndex] CONFLICT slug "${slug}" → existing ${bySlug.type} at ${bySlug.path}`)
    found.add(slug)
  }

  // Title conflict: check if any other entity/concept page has the same title
  const title = extractTitleFromContent(content)
  if (title) {
    const byTitle = wikiIndex.findByTitle(title)
    console.log(`[wikiIndex] title check "${title}" → ${byTitle.length} match(es)`)
    for (const record of byTitle) {
      if (record.type !== "source") {
        const recordSlug = record.path.replace(/^wiki\/[^/]+\//, "").replace(/\.md$/, "")
        if (recordSlug !== slug && !found.has(recordSlug)) {
          console.log(`[wikiIndex] CONFLICT title "${title}" → ${record.type} "${recordSlug}" differs from "${slug}"`)
          found.add(recordSlug)
        }
      }
    }
  }

  return [...found]
}

// ── ProcessedBlock: result of the pure preprocessing pipeline ──

interface ProcessedBlock {
  relativePath: string
  content: string
  isEntity: boolean
  isConcept: boolean
  slug: string
  skipReason: string | null
}

// ── Pure preprocessing: sanitize, stamp, route, lang check (no I/O) ──

function prepareBlockContent(
  rawRelativePath: string,
  rawContent: string,
  sourceSummaryPath: string | undefined,
  sourceFileName: string,
  targetLang: string | undefined,
  today: string,
  projectSchemaRouting: Awaited<ReturnType<typeof loadProjectWikiSchemaRouting>>,
): ProcessedBlock {
  let relativePath = rawRelativePath
  if (sourceSummaryPath && relativePath.startsWith("wiki/sources/")) {
    relativePath = sourceSummaryPath
  }

  let content = sanitizeIngestedFileContent(rawContent)
  if (!isListingPath(relativePath)) {
    content = stampGeneratedFrontmatterDates(content, today)
  }
  if (!isListingPath(relativePath)) {
    content = injectSourcesField(content, sourceFileName)
  }
  if (sourceSummaryPath && relativePath === sourceSummaryPath) {
    content = sourceSummaryMediaRefsForExternalMarkdown(content)
  }

  if (projectSchemaRouting && !isListingPath(relativePath)) {
    const routingIssue = validateWikiPageRouting(relativePath, content, projectSchemaRouting)
    if (routingIssue) {
      return {
        relativePath, content, isEntity: false, isConcept: false, slug: "",
        skipReason: `Dropped "${relativePath}" — ${routingIssue.message}`,
      }
    }
  }

  const isEntityOrSource =
    relativePath.startsWith("wiki/entities/") ||
    relativePath.includes("/entities/") ||
    relativePath.startsWith("wiki/sources/") ||
    relativePath.includes("/sources/")
  if (targetLang && targetLang !== "auto" && !isEntityOrSource && !contentMatchesTargetLanguage(content, targetLang)) {
    return {
      relativePath, content, isEntity: false, isConcept: false, slug: "",
      skipReason: `Dropped "${relativePath}" — body language doesn't match target ${targetLang}.`,
    }
  }

  const isEntity = relativePath.startsWith("wiki/entities/")
  const isConcept = relativePath.startsWith("wiki/concepts/")
  const slug = relativePath.replace(/^wiki\/[^/]+\//, "").replace(/\.md$/, "")

  return { relativePath, content, isEntity, isConcept, slug, skipReason: null }
}

// ── Write one block: merge + file I/O + wikiIndex register ──

async function writeSingleBlock(
  projectPath: string,
  block: ProcessedBlock,
  llmConfig: LlmConfig,
  sourceFileName: string,
  conflictSlugsArg: string[] | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const fullPath = `${projectPath}/${block.relativePath}`
  let content = block.content

  if (isListingPath(block.relativePath)) {
    await writeFile(fullPath, content)
    return
  }

// Conflict merge: merge content with each existing conflicting page,
  // deleting each after merge. Repeated title matches across chapters
  // are resolved one-by-one until only the current page remains.
  const conflictSlugs = conflictSlugsArg ?? []
  for (const conflictSlug of conflictSlugs) {
    if (!(block.isEntity || block.isConcept)) continue
    const existingRecord = wikiIndex.findBySlug(conflictSlug)
    const conflictPath = existingRecord?.path ?? `${block.isConcept ? "wiki/entities" : "wiki/concepts"}/${conflictSlug}.md`
    const conflictFullPath = `${projectPath}/${conflictPath}`
    const conflictContent = await tryReadFile(conflictFullPath)
    if (conflictContent) {
      const merged = await mergePageContent(content, conflictContent, buildPageMerger(llmConfig), {
        sourceFileName,
        pagePath: block.relativePath,
        signal,
        backup: (c) => backupExistingPage(projectPath, block.relativePath, c),
      })
      await appendMergeHistoryLog(projectPath, "merge", conflictSlug, sourceFileName,
        `merged "${conflictSlug}" into "${block.slug}"`, `before(${conflictSlug}):\n${conflictContent}\n\nafter(${block.slug}):\n${merged}`)
      content = merged
      await deleteFile(conflictFullPath)
      await appendMergeHistoryLog(projectPath, "delete", conflictSlug, sourceFileName, conflictContent)
      wikiIndex.unregister(conflictSlug)
      console.log(`[wikiIndex] MERGED content from "${conflictSlug}" into "${block.slug}", deleted "${conflictPath}"`)
    }
  }

  // Merge with existing content on disk
  const existingContent = await tryReadFile(fullPath)
  if (existingContent) {
    const merged = await mergePageContent(content, existingContent, buildPageMerger(llmConfig), {
      sourceFileName,
      pagePath: block.relativePath,
      backup: (content) => backupExistingPage(projectPath, block.relativePath, content),
    })
    content = merged
  }

  await writeFile(fullPath, content)

  if (block.isEntity || block.isConcept) {
    const title = extractTitleFromContent(content) || block.slug
    const type = block.isEntity ? "entity" : "concept"
    wikiIndex.register(block.slug, title, type, block.relativePath)
    await appendMergeHistoryLog(projectPath, "register", block.slug, sourceFileName, undefined, `<${type}> ${title}`)
    console.log(`[wikiIndex] REGISTERED "${block.slug}" → title="${title}", type=${type}`)
  }
}

// ── writeFileBlocks ──

async function writeFileBlocks(
  projectPath: string,
  text: string | null,
  llmConfig: LlmConfig,
  sourceFileName: string,
  sourceSummaryPath?: string,
  signal?: AbortSignal,
  relatedPages?: string,
  activityId?: string,
  options?: {
    preParsed?: import("./file-blocks").ParsedFileBlock[]
  },
): Promise<{ writtenPaths: string[]; warnings: string[]; hardFailures: string[] }> {
  const { blocks, warnings: parseWarnings } = options?.preParsed
    ? { blocks: options.preParsed, warnings: [] as string[] }
    : parseFileBlocks(text ?? "")
  const warnings = [...parseWarnings]
  const writtenPaths: string[] = []
  const hardFailures: string[] = []
  const projectSchemaRouting = await loadProjectWikiSchemaRouting(projectPath)
  const targetLang = useWikiStore.getState().outputLanguage
  const today = currentWikiDate()

  for (const block of blocks) {
    throwIfIngestAborted(signal, activityId)

    const processed = prepareBlockContent(
      block.path, block.content,
      sourceSummaryPath, sourceFileName, targetLang, today,
      projectSchemaRouting,
    )

    if (processed.skipReason) {
      console.warn(`[ingest] ${processed.skipReason}`)
      warnings.push(processed.skipReason)
      await logDiag(projectPath, `[trace] SKIP: ${processed.relativePath}`)
      continue
    }

    // Apply related slugs sanitization (needs projectPath I/O)
    if (relatedPages && (block.path.startsWith("wiki/entities/") || block.path.startsWith("wiki/concepts/"))) {
      processed.content = await sanitizeRelatedSlugs(processed.content, relatedPages, projectPath)
    }

    // Per-block conflict detection
    let blockConflictSlugs: string[] | undefined
    if (block.path.startsWith("wiki/entities/") || block.path.startsWith("wiki/concepts/")) {
      const conflicts = detectEntityConceptConflicts(block.path, processed.content)
      if (conflicts.length > 0) blockConflictSlugs = conflicts
    }

    try {
      await writeSingleBlock(projectPath, processed, llmConfig, sourceFileName,
        blockConflictSlugs, signal)
      writtenPaths.push(processed.relativePath)
    } catch (err) {
      const msg = `Failed to write "${processed.relativePath}": ${err instanceof Error ? err.message : String(err)}`
      console.error(`[ingest] ${msg}`)
      await logDiag(projectPath, `[trace] WRITE FAILED: ${processed.relativePath}: ${err instanceof Error ? err.message : String(err)}`)
      hardFailures.push(processed.relativePath)
    }
  }

  return { writtenPaths, warnings, hardFailures }
}

async function writeFileBlocksWithConflictCheck(
  projectPath: string,
  text: string,
  llmConfig: LlmConfig,
  sourceFileName: string,
  sourceSummaryPath?: string,
  signal?: AbortSignal,
  relatedPages?: string,
  activityId?: string,
): Promise<{ writtenPaths: string[]; warnings: string[]; hardFailures: string[] }> {
  const { blocks } = parseFileBlocks(text)
  return writeFileBlocks(projectPath, null, llmConfig, sourceFileName,
    sourceSummaryPath, signal, relatedPages, activityId,
    { preParsed: blocks })
}

/**
 * Replace all wikilinks to oldSlug with newSlug across all wiki files.
 */
async function replaceWikiLinks(
  projectPath: string,
  oldSlug: string,
  newSlug: string,
): Promise<number> {
  const wikiDir = `${projectPath}/wiki`
  const files = await listDirectory(wikiDir)

  let replacementCount = 0

  for (const node of files) {
    if (node.is_dir || !node.name.endsWith(".md")) continue
    const fullPath = `${wikiDir}/${node.path}`
    let content = await readFile(fullPath)
    const originalContent = content

    // Match [[oldSlug]] or [[oldSlug|display]]
    const pattern = new RegExp(`\\[\\[${oldSlug}(\\||\\])`, "g")
    content = content.replace(pattern, `[[${newSlug}$1`)

    if (content !== originalContent) {
      await writeFile(fullPath, content)
      replacementCount++
    }
  }

  return replacementCount
}

/**
 * Perform N-way merge of existing contents with the incoming block content.
 */
async function performNWayMerge(
  existingContents: Array<{ slug: string; content: string }>,
  incomingBlock: import("./file-blocks").ParsedFileBlock,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<string> {
  // Fast path: no existing contents
  if (existingContents.length === 0) {
    return incomingBlock.content
  }

  // Build N-way merge prompt
  const versions = existingContents
    .map((ec, i) => `--- VERSION ${i + 1} (slug: ${ec.slug}) ---\n${ec.content}`)
    .join("\n\n")

  // Extract target slug from path
  const targetSlug = incomingBlock.path.replace(/^wiki\/[^/]+\//, "").replace(/\.md$/, "")

  const nWayPrompt = [
    "You are merging multiple versions of the same wiki page into one coherent document.",
    "All versions describe the same topic but were generated from different source documents.",
    "",
    "Versions:",
    versions,
    "---",
    "--- VERSION TARGET (generated from aggregate step) ---",
    incomingBlock.content,
    "",
    "Produce ONE merged version for the target slug that:",
    "- Preserves every factual claim from ALL versions",
    "- Eliminates redundancy",
    "- Keeps sources/tags/related as a union",
    "- Maintains the target slug and title exactly",
    "",
    "Output requirements:",
    "- First character MUST be `-` (opening of `---`)",
    "- Output the COMPLETE file: YAML frontmatter + body",
    "- No preamble, no explanation",
    "- Target slug MUST be exactly: `" + targetSlug + "`",
  ].join("\n")

  try {
    let mergedContent = ""

    await streamChat(
      llmConfig,
      [
        { role: "system", content: nWayPrompt },
        { role: "user", content: `Generate the merged wiki file for "${targetSlug}" now.` },
      ],
      {
        onToken: (token) => { mergedContent += token },
        onDone: () => {},
        onError: (err) => {
          console.error(`[ingest] N-way merge LLM call failed:`, err)
        },
      },
      signal,
      { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: computeIngestReviewMaxTokens(llmConfig.maxContextSize) },
    )

    // If LLM returned empty, fall back to incoming content
    if (!mergedContent || !mergedContent.trim()) {
      return incomingBlock.content
    }

    // Validate merged content has frontmatter
    const parsed = parseFrontmatter(mergedContent)

    if (!parsed.frontmatter) {
      console.warn(`[ingest] N-way merge output has no frontmatter, falling back`)
      return incomingBlock.content
    }

    return mergedContent
  } catch (err) {
    console.error(`[ingest] N-way merge failed:`, err)
    return incomingBlock.content
  }
}

/**
 * Stage aggregate only: batch merge overview.md if it conflicts with existing pages.
 * Only handles overview.md conflicts (slug or title).
 * Other entity/concept pages use per-block conflict detection.
 */
async function writeAggregateFileBlocks(
  projectPath: string,
  text: string,
  llmConfig: LlmConfig,
  sourceIdentity: string,
  signal?: AbortSignal,
  activityId?: string,
): Promise<{ writtenPaths: string[]; warnings: string[]; hardFailures: string[] }> {
  const { blocks } = parseFileBlocks(text)

  requireBlocks(blocks, "Aggregate", { requiredPaths: ["wiki/overview.md"] })

  const overviewBlock = blocks.find((b) => b.path === "wiki/overview.md")!

  // Per-block conflict detection (Phase 1)
  let blockConflictSlugs: string[] | undefined
  if (overviewBlock.path.startsWith("wiki/entities/") || overviewBlock.path.startsWith("wiki/concepts/")) {
    const conflicts = detectEntityConceptConflicts(overviewBlock.path, overviewBlock.content)
    if (conflicts.length > 0) blockConflictSlugs = conflicts
  }

  if (!blockConflictSlugs || blockConflictSlugs.length === 0) {
    // No conflicts, use regular writeFileBlocks
    return writeFileBlocks(projectPath, null, llmConfig, "", undefined, signal, undefined, activityId, { preParsed: blocks })
  }

  // Conflicts detected, perform batch merge
  try {
    const writtenPaths: string[] = []
    const warnings: string[] = []
    const hardFailures: string[] = []
    const projectSchemaRouting = await loadProjectWikiSchemaRouting(projectPath)
    const targetLang = useWikiStore.getState().outputLanguage
    const today = currentWikiDate()
    const sourceFileName = "aggregate-step3"

    for (const conflictSlug of blockConflictSlugs) {
      const existingRecord = wikiIndex.findBySlug(conflictSlug)
      if (!existingRecord) continue

      const conflictPath = existingRecord.path ?? `wiki/overview.md`
      const conflictFullPath = `${projectPath}/${conflictPath}`
      const conflictContent = await tryReadFile(conflictFullPath)

      if (conflictContent) {
        // Backup existing content
        await backupExistingPage(projectPath, conflictSlug, conflictContent)

        // Read existing content into memory
        const existingContents = [{ slug: conflictSlug, content: conflictContent }]

        // Delete existing file
        await deleteFile(conflictFullPath)

        // WikiIndex unregistration
        wikiIndex.unregister(conflictSlug)

        // Perform N-way merge
        const mergedContent = await performNWayMerge(
          existingContents,
          overviewBlock,
          llmConfig,
          signal,
        )

        // Write merged content
        const overviewSlug = overviewBlock.path.replace(/^wiki\/[^/]+\//, "").replace(/\.md$/, "")

        const processed = prepareBlockContent(
          overviewBlock.path,
          mergedContent,
          undefined,
          sourceFileName,
          targetLang,
          today,
          projectSchemaRouting,
        )

        if (processed.skipReason) {
          warnings.push(processed.skipReason)
          await logDiag(projectPath, `[trace] SKIP: ${processed.relativePath}`)
          continue
        }

        await writeFile(`${projectPath}/${processed.relativePath}`, mergedContent)

        // WikiIndex registration
        const title = extractTitleFromContent(mergedContent) || overviewSlug
        const type = overviewBlock.path.startsWith("wiki/entities/") ? "entity" : "concept"
        wikiIndex.register(overviewSlug, title, type, overviewBlock.path)

        writtenPaths.push(processed.relativePath)
      }
    }

     // Slug fixup (replace old slugs with new slugs)
        const overviewSlug = overviewBlock.path.replace(/^wiki\/[^/]+\//, "").replace(/\.md$/, "")

        for (const conflictSlug of blockConflictSlugs) {
          const existingRecord = wikiIndex.findBySlug(conflictSlug)
          if (existingRecord && existingRecord.path !== `wiki/overview.md`) {
            await replaceWikiLinks(projectPath, conflictSlug, overviewSlug)
          }
        }

    return { writtenPaths, warnings, hardFailures }
  } catch (err) {
    console.error(`[ingest] Batch merge failed for "${sourceIdentity}":`, err)
    if (signal?.aborted) throw err
    return { writtenPaths: [], warnings: [], hardFailures: [] }
  }
}

// ── File Reader Types & Helpers ──

interface ReaderResult {
  sourceContent: string
  savedImages: SavedImage[]
}

type FileType = "txt" | "pdf"

function detectFileType(fileName: string): FileType {
  const ext = fileName.split(".").pop()?.toLowerCase()
  return ext === "pdf" ? "pdf" : "txt"
}

async function txtReader(
  slug: string,
  fileBase64: { base64: string },
  pp: string,
  sourcePath: string,
): Promise<ReaderResult> {
  const binary = atob(fileBase64.base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const sourceContent = new TextDecoder().decode(bytes)
  const savedImages = await extractAndSaveMarkdownImages(pp, sourcePath, sourceContent, slug)
  return { sourceContent, savedImages }
}

async function pdfReader(
  slug: string,
  fileBase64: { base64: string },
  pp: string,
  sourcePath: string,
  signal?: AbortSignal,
  activityId?: string,
): Promise<ReaderResult> {
  const mineruCfg = useWikiStore.getState().mineruConfig
  let sourceContent = ""
  let savedImages: SavedImage[] = []
  const mineruConfigured = mineruCfg.backend === "local" || Boolean(mineruCfg.token)
  if (mineruCfg.enabled && mineruConfigured) {
    try {
      console.log(`[ingest:pdfReader] submitting PDF to MinerU API`)
      const mineruResult = await parseWithMineruResult(
        mineruCfg, sourcePath, undefined,
        undefined,
        signal,
        { projectPath: pp, sourceSummarySlug: slug },
        fileBase64,
      )
      sourceContent = mineruResult.markdown
      savedImages = mineruResult.savedImages
    } catch (err) {
      throwIfIngestAborted(signal)
      const msg = trimInlineStatus(err instanceof Error ? err.message : String(err))
      console.warn(`[ingest:pdfReader] MinerU parsing failed, falling back to built-in PDF extraction: ${msg}`)
      if (activityId) {
        useActivityStore.getState().updateItem(activityId, {
          detail: `MinerU failed, falling back to built-in PDF extraction: ${msg}`,
        })
      }
      sourceContent = await tryReadSourceTextFile(sourcePath)
    }
  } else {
    sourceContent = await tryReadSourceTextFile(sourcePath)
  }
  return { sourceContent, savedImages }
}

async function captionEmbeddedImages(
  pp: string,
  sourceContent: string,
  savedImages: SavedImage[],
  sourceSummarySlug: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<string> {
  let enrichedSourceContent = stripWikiMediaAbsPaths(
    pp,
    appendSavedImageRefsForCaption(sourceContent, savedImages),
  )
  const mmCfg = useWikiStore.getState().multimodalConfig
  const captionLlm = resolveCaptionConfig(mmCfg, llmConfig)
  if (!mmCfg.enabled && savedImages.length > 0) {
    enrichedSourceContent = sourceContent.replace(
      /!\[[^\]]*\]\([^)\s]+\)/g,
      " ",
    )
    console.log(
      `[ingest:caption] disabled — stripped image refs from sourceContent (${savedImages.length} image(s) won't appear in wiki pages)`,
    )
  } else if (
    captionLlm &&
    savedImages.length > 0 &&
    /!\[\]\(/.test(enrichedSourceContent)
  ) {
    try {
      const result = await captionMarkdownImages(pp, enrichedSourceContent, captionLlm, {
        signal,
        shouldCaption: (url) => url.startsWith(`media/${sourceSummarySlug}/`),
        urlToAbsPath: (url) => promptImageUrlToAbs(pp, url),
        concurrency: mmCfg.concurrency,
      })
      enrichedSourceContent = result.enrichedMarkdown
      console.log(
        `[ingest:caption] images=${savedImages.length} fresh=${result.freshCaptions} cached=${result.cachedCaptions} failed=${result.failed}`,
      )
    } catch (err) {
      console.warn(
        `[ingest:caption] pipeline failed for "${sourceSummarySlug}":`,
        err instanceof Error ? err.message : err,
      )
    }
  }
  return enrichedSourceContent
}

// ── tryCacheHit ──

async function tryCacheHit(
  pp: string,
  sourceIdentity: string,
  sourceHash: string,
): Promise<{ fullyIngested: boolean; startStage: number; filesWritten: string[] }> {
  const entries = (await loadCache(pp)).entries
  const entry = entries[sourceIdentity]
  if (!entry) {
    console.log(`[ingest:diag] tryCacheHit: NO cache entry for "${sourceIdentity}" — fresh ingest`)
    return { fullyIngested: false, startStage: 0, filesWritten: [] }
  }

  if (entry.hash !== sourceHash) return { fullyIngested: false, startStage: 0, filesWritten: [] }

  // Verify all previously-written files still exist on disk
  for (const filePath of entry.filesWritten) {
    const fullPath = isAbsolutePath(filePath) ? normalizePath(filePath) : `${normalizePath(pp)}/${filePath}`
    if (!(await fileExists(fullPath))) {
      console.log(`[ingest-cache] cache miss for ${sourceIdentity}: ${filePath} no longer on disk`)
      return { fullyIngested: false, startStage: 0, filesWritten: [] }
    }
  }

  if (entry.fullyIngested) {
    return { fullyIngested: true, startStage: 0, filesWritten: entry.filesWritten }
  }

  const startStage = entry.lastStage ?? 0
  console.log(`[ingest:diag] cache check for "${sourceIdentity}": PARTIAL HIT (lastStage=${entry.lastStage}, resuming at stage ${startStage})`)
  await logDiag(pp, `resume — lastStage=${entry.lastStage}, startStage=${startStage}`)
  return { fullyIngested: false, startStage, filesWritten: [] }
}

// ── autoIngestImpl ──

async function autoIngestImpl(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
  folderContext?: string,
  onFileWritten?: (relativePath: string) => void,
): Promise<string[]> {
  const activity = useActivityStore.getState()
  const fileName = getFileName(normalizePath(sourcePath))
  const activityId = activity.addItem({
    type: "ingest",
    title: fileName,
    status: "running",
    detail: "Reading source...",
    filesWritten: [],
  })
  try {
    return await runIngestPipeline(
      activityId, projectPath, sourcePath, llmConfig, signal,
      folderContext, onFileWritten,
    )
  } catch (err) {
    // Mark the activity item as failed so the UI doesn't stay stuck on the
    // last in-progress detail (e.g. "Stage summary: Generating source summary
    // page..."). User cancellations are handled elsewhere and must stay silent.
    if (!signal?.aborted) {
      activity.updateItem(activityId, {
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      })
    }
    throw err
  }
}

async function runIngestPipeline(
  activityId: string,
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
  folderContext?: string,
  onFileWritten?: (relativePath: string) => void,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const activity = useActivityStore.getState()
  const fileName = getFileName(sp)
  const sourceIdentity = sourceIdentityForPath(pp, sp)
  const sourceSummarySlug = sourceSummarySlugFromIdentity(sourceIdentity)
  const sourceSummaryPath = `wiki/sources/${sourceSummarySlug}.md`
  console.log(`[ingest:diag] autoIngestImpl ENTRY for "${fileName}" (project="${pp}", source="${sp}")`)
  const llmModelName = llmConfig?.provider || llmConfig?.model || "unknown"
  await logDiag(pp, `entry info — llmModel=${llmModelName}, llmConfigPresent=${!!llmConfig?.apiKey}`)

  const [ fileBase64, schema, purpose, overview] = await Promise.all([
    readFileAsBase64(sp),
    tryReadFile(`${pp}/schema.md`),
    tryReadFile(`${pp}/purpose.md`),
    tryReadFile(`${pp}/wiki/overview.md`),
  ])
    
  await logDiag(pp, `project files — purpose.md length=${purpose?.length ?? 0}, schema.md length=${schema?.length ?? 0}, overview.md length=${overview?.length ?? 0}`)

  // ── Cache check ──
  const sourceHash = await sha256(fileBase64.base64)
  const cacheCheck = await tryCacheHit(pp, sourceIdentity, sourceHash)
  if (cacheCheck.fullyIngested) {
    useActivityStore.getState().updateItem(activityId, {
      status: "done",
      detail: `Skipped (unchanged) — ${cacheCheck.filesWritten.length} files from previous ingest`,
      filesWritten: cacheCheck.filesWritten,
    })
    return cacheCheck.filesWritten
  }
  let startStage = cacheCheck.startStage

  // ── Resume flag ──
  let resumeFlag: symbol = startStage === 0 ? NO_NEED_RESTORE : NEED_RESTORE

  // ── Initialize all stage variables (plain types, no sentinel) ──
  let sourceContent = ""
  let savedImages: SavedImage[] = []
  let enrichedSourceContent = ""
  let relatedPages = ""
  let sourceContext = ""
  let analysis = ""
  let entityGeneration = ""
  let conceptGeneration = ""
  let summaryGeneration = ""
  let summaryRelated: string[] = []
  let aggregateGeneration = ""
  let writtenPaths: string[] = []
  let writeWarnings: string[] = []
  let hardFailures: string[] = []

  const mmCfg = useWikiStore.getState().multimodalConfig
  const sourceBudget = computeIngestSourceBudget(llmConfig.maxContextSize)

  // ── Stage 1: Read source file (txt / pdf) ──
  if (startStage == 0) {
    // Stage 1 reads from the original source file, not from previous stage
    // cache — there is nothing to restore on resume.
    activity.updateItem(activityId, { detail: "[Stage 1/10] Reading source file..." })
    const fileType = detectFileType(fileName)
    const readers: Record<string, () => Promise<ReaderResult>> = {
      pdf: () => pdfReader(sourceSummarySlug, fileBase64, pp, sp, signal, activityId),
      txt: () => txtReader(sourceSummarySlug, fileBase64, pp, sp),
    }
    const reader = readers[fileType]
    if (!reader) {
      throw new IngestError("system", `Unsupported file format "${fileType}" for "${fileName}"`)
    }
    const result = await reader()
    sourceContent = result.sourceContent
    savedImages = result.savedImages
    if (!sourceContent.trim() && savedImages.length === 0) {
      throw new IngestError("system",
        `Failed to read content from "${fileName}" — file is empty or unreadable`,
      )
    }
    if (sourceContent.length > sourceBudget * 2) {
      throw new IngestError("system",
        `File "${fileName}" exceeds size limit (${sourceContent.length} chars, max ${sourceBudget * 2})`,
      )
    }
    await writeStageCache(pp, sourceIdentity, "reader", { sourceContent, savedImages })
    startStage = 1
    await saveIngestStageProgress(pp, sourceIdentity, startStage, sourceHash)
  }

  // ── Stage 2: Compress long source ──
  if (startStage == 1) {
    if (resumeFlag === NEED_RESTORE) {
      const readerCache = await readStageCache<StepReaderCache>(pp, sourceIdentity, "reader")
      sourceContent = readerCache?.sourceContent ?? ""
      savedImages = readerCache?.savedImages ?? []
      resumeFlag = NO_NEED_RESTORE
    }
    activity.updateItem(activityId, { detail: "[Stage 2/10] Compressing long source..." })
    sourceContext = sourceContent
    if (sourceContent.length > sourceBudget) {
      sourceContext = await compressLongSource(
        llmConfig, sourceIdentity, folderContext,
        sourceContent, sourceBudget, signal,
      )
    }
    startStage = 2
    await saveIngestStageProgress(pp, sourceIdentity, startStage)
    await writeStageCache(pp, sourceIdentity, "compress", { sourceContext })
  }

  // ── Stage 3: Caption embedded images ──
  if (startStage == 2) {
    if (resumeFlag === NEED_RESTORE) {
      const compressCache = await readStageCache<StepCompressCache>(pp, sourceIdentity, "compress")
      sourceContext = compressCache?.sourceContext ?? ""
      const readerCache = await readStageCache<StepReaderCache>(pp, sourceIdentity, "reader")
      savedImages = readerCache?.savedImages ?? []
      resumeFlag = NO_NEED_RESTORE
    }
    activity.updateItem(activityId, { detail: "[Stage 3/10] Captioning images..." })
    enrichedSourceContent = await captionEmbeddedImages(
      pp, sourceContext, savedImages, sourceSummarySlug,
      llmConfig, signal,
    )
    startStage = 3
    await saveIngestStageProgress(pp, sourceIdentity, startStage)
    await writeStageCache(pp, sourceIdentity, "caption", { enrichedSourceContent })
  }

  // ── Stage 4: RAG retrieve related wiki pages ──
  if (startStage == 3) {
    if (resumeFlag === NEED_RESTORE) {
      const captionCache = await readStageCache<StepCaptionCache>(pp, sourceIdentity, "caption")
      enrichedSourceContent = captionCache?.enrichedSourceContent ?? ""
      resumeFlag = NO_NEED_RESTORE
    }
    activity.updateItem(activityId, { detail: "[Stage 4/10] Retrieving related wiki pages..." })
    relatedPages = await searchRelatedWikiPages(pp, sourceIdentity, enrichedSourceContent)
    startStage = 4
    await saveIngestStageProgress(pp, sourceIdentity, startStage)
    await writeStageCache(pp, sourceIdentity, "rag", { relatedPages })
  }

  // ── Stage 5: Analysis ──
  if (startStage == 4) {
    if (resumeFlag === NEED_RESTORE) {
      const compressCache = await readStageCache<StepCompressCache>(pp, sourceIdentity, "compress")
      sourceContext = compressCache?.sourceContext ?? ""
      const ragCache = await readStageCache<StepRagCache>(pp, sourceIdentity, "rag")
      relatedPages = ragCache?.relatedPages ?? ""
      resumeFlag = NO_NEED_RESTORE
    }
    activity.updateItem(activityId, { detail: "[Stage 5/10] Analyzing source..." })
    const analysisResult = await runAnalysis({
      pp, llmConfig, sourceIdentity, folderContext, sourceContext,
      purpose, relatedPages, schema, signal, activityId,
    })
    analysis = analysisResult.analysis
    await writeStageCache(pp, sourceIdentity, "analysis", { analysis })
    startStage = 5
    await saveIngestStageProgress(pp, sourceIdentity, startStage)
  }

  // ── Stage 6: Entity pages ──
  if (startStage == 5) {
    if (resumeFlag === NEED_RESTORE) {
      const analysisCache = await readStageCache<StepAnalysisCache>(pp, sourceIdentity, "analysis")
      analysis = analysisCache?.analysis ?? ""
      const ragCache = await readStageCache<StepRagCache>(pp, sourceIdentity, "rag")
      relatedPages = ragCache?.relatedPages ?? ""
      const compressCache = await readStageCache<StepCompressCache>(pp, sourceIdentity, "compress")
      sourceContext = compressCache?.sourceContext ?? ""
      resumeFlag = NO_NEED_RESTORE
    }
    activity.updateItem(activityId, { detail: "[Stage 6/10] Generating entity pages..." })
    const entityResult = await runEntityPageGeneration({
      pp, llmConfig, sourceIdentity, sourceSummaryPath, sourceContext,
      analysis, relatedPages, schema, purpose, overview, signal,
      onFileWritten, activityId,
    })
    entityGeneration = entityResult.entityGeneration
    writtenPaths = entityResult.writtenPaths
    writeWarnings = entityResult.writeWarnings
    hardFailures = entityResult.hardFailures
    startStage = 6
    await writeStageCache(pp, sourceIdentity, "entity", { entityGeneration, writtenPaths })
    await saveIngestStageProgress(pp, sourceIdentity, startStage)
  }

  // ── Stage 7: Concept pages ──
  if (startStage == 6) {
    if (resumeFlag === NEED_RESTORE) {
      const analysisCache = await readStageCache<StepAnalysisCache>(pp, sourceIdentity, "analysis")
      analysis = analysisCache?.analysis ?? ""
      const ragCache = await readStageCache<StepRagCache>(pp, sourceIdentity, "rag")
      relatedPages = ragCache?.relatedPages ?? ""
      const compressCache = await readStageCache<StepCompressCache>(pp, sourceIdentity, "compress")
      sourceContext = compressCache?.sourceContext ?? ""
      resumeFlag = NO_NEED_RESTORE
    }
    activity.updateItem(activityId, { detail: "[Stage 7/10] Generating concept pages..." })
    const conceptResult = await runConceptPageGeneration({
      pp, llmConfig, sourceIdentity, sourceSummaryPath, sourceContext,
      analysis, relatedPages, schema, purpose, overview, signal,
      accumulatedWrittenPaths: writtenPaths,
      accumulatedWarnings: writeWarnings,
      accumulatedHardFailures: hardFailures,
      onFileWritten, activityId,
    })
    conceptGeneration = conceptResult.conceptGeneration
    writtenPaths = conceptResult.writtenPaths
    writeWarnings = conceptResult.writeWarnings
    hardFailures = conceptResult.hardFailures
    startStage = 7
    await writeStageCache(pp, sourceIdentity, "concept", { conceptGeneration, writtenPaths })
    await saveIngestStageProgress(pp, sourceIdentity, startStage)
  }

  // ── Stage 8: Source summary page ──
  if (startStage == 7) {
    if (resumeFlag === NEED_RESTORE) {
      const analysisCache = await readStageCache<StepAnalysisCache>(pp, sourceIdentity, "analysis")
      analysis = analysisCache?.analysis ?? ""
      const compressCache = await readStageCache<StepCompressCache>(pp, sourceIdentity, "compress")
      sourceContext = compressCache?.sourceContext ?? ""
      const entityCache = await readStageCache<StepEntityCache>(pp, sourceIdentity, "entity")
      writtenPaths = entityCache?.writtenPaths?.length ? [...entityCache.writtenPaths] : []
      const conceptCache = await readStageCache<StepConceptCache>(pp, sourceIdentity, "concept")
      if (writtenPaths.length === 0 && conceptCache?.writtenPaths?.length) {
        writtenPaths = [...conceptCache.writtenPaths]
      }
      const readerCache = await readStageCache<StepReaderCache>(pp, sourceIdentity, "reader")
      savedImages = readerCache?.savedImages ?? []
      entityGeneration = entityCache?.entityGeneration ?? ""
      conceptGeneration = conceptCache?.conceptGeneration ?? ""
      resumeFlag = NO_NEED_RESTORE
    }
    activity.updateItem(activityId, { detail: "[Stage 8/10] Generating source summary page..." })
    const summaryResult = await runSourceSummaryPageGeneration({
      pp, llmConfig, sourceIdentity, sourceSummaryPath, sourceContext,
      analysis, schema, signal,
      accumulatedWrittenPaths: writtenPaths,
      accumulatedWarnings: writeWarnings,
      accumulatedHardFailures: hardFailures,
      onFileWritten, activityId,
    })
    summaryGeneration = summaryResult.summaryGeneration
    summaryRelated = summaryResult.summaryRelated
    writtenPaths = summaryResult.writtenPaths
    writeWarnings = summaryResult.writeWarnings
    hardFailures = summaryResult.hardFailures
    startStage = 8
    await writeStageCache(pp, sourceIdentity, "summary", { summaryGeneration, summaryRelated, writtenPaths })
    await saveIngestStageProgress(pp, sourceIdentity, startStage)
  }

  // ── Stage 9: Aggregate pages ──
  if (startStage == 8) {
    if (resumeFlag === NEED_RESTORE) {
      const summaryCache = await readStageCache<StepSummaryCache>(pp, sourceIdentity, "summary")
      summaryRelated = summaryCache?.summaryRelated ?? []
      const analysisCache = await readStageCache<StepAnalysisCache>(pp, sourceIdentity, "analysis")
      analysis = analysisCache?.analysis ?? ""
      const readerCache = await readStageCache<StepReaderCache>(pp, sourceIdentity, "reader")
      savedImages = readerCache?.savedImages ?? []
      resumeFlag = NO_NEED_RESTORE
    }
    activity.updateItem(activityId, { detail: "[Stage 9/10] Generating aggregate wiki pages..." })
    const aggResult = await runAggregatePageGeneration({
      pp, llmConfig, sourceIdentity, sourceContext, analysis, purpose, overview,
      summaryRelated, signal,
      accumulatedWrittenPaths: writtenPaths,
      accumulatedWarnings: writeWarnings,
      accumulatedHardFailures: hardFailures,
      onFileWritten, activityId,
    })
    aggregateGeneration = aggResult.aggregateGeneration
    writtenPaths = aggResult.writtenPaths
    writeWarnings = aggResult.writeWarnings
    hardFailures = aggResult.hardFailures
    startStage = 9
    await writeStageCache(pp, sourceIdentity, "aggregate", { aggregateGeneration })
    await saveIngestStageProgress(pp, sourceIdentity, startStage)
  }

  let reviewSuggestionOutput = ""
  let reviewItems: ReturnType<typeof parseReviewBlocks> = []

  // ── Stage 10: Review suggestion ──
  if (startStage == 9) {
    if (resumeFlag === NEED_RESTORE) {
      const entityCache = await readStageCache<StepEntityCache>(pp, sourceIdentity, "entity")
      entityGeneration = entityCache?.entityGeneration ?? ""
      const conceptCache = await readStageCache<StepConceptCache>(pp, sourceIdentity, "concept")
      conceptGeneration = conceptCache?.conceptGeneration ?? ""
      resumeFlag = NO_NEED_RESTORE
    }
    activity.updateItem(activityId, { detail: "[Stage 10/10] Generating review suggestions..." })
    const reviewResult = await runReviewSuggestion({
      pp, llmConfig, sourceIdentity, sourceContext, analysis,
      relatedPages, purpose, entityGeneration, conceptGeneration, signal, activityId,
    })
    reviewSuggestionOutput = reviewResult.reviewSuggestionOutput
    startStage = 10
    await writeStageCache(pp, sourceIdentity, "review", { reviewSuggestionOutput })
    await saveIngestStageProgress(pp, sourceIdentity, startStage)
  }

  // ── Stage 11: Parse review items ──
  if (startStage == 10) {
    if (resumeFlag === NEED_RESTORE) {
      const entityCache = await readStageCache<StepEntityCache>(pp, sourceIdentity, "entity")
      entityGeneration = entityCache?.entityGeneration ?? ""
      const conceptCache = await readStageCache<StepConceptCache>(pp, sourceIdentity, "concept")
      conceptGeneration = conceptCache?.conceptGeneration ?? ""
      const reviewCache = await readStageCache<StepReviewCache>(pp, sourceIdentity, "review")
      reviewSuggestionOutput = reviewCache?.reviewSuggestionOutput ?? ""
      resumeFlag = NO_NEED_RESTORE
    }
    const entityConceptGeneration = entityGeneration + conceptGeneration
    reviewItems = [
      ...parseReviewBlocks(entityConceptGeneration, sp),
      ...parseReviewBlocks(reviewSuggestionOutput, sp),
    ]
    if (reviewItems.length > 0) {
      useReviewStore.getState().addItems(reviewItems)
    }
    startStage = 11
    await saveIngestStageProgress(pp, sourceIdentity, startStage)
  }

  // ── Post-processing ──
  if (writeWarnings.length > 0) {
    const warningSummary = writeWarnings.length === 1
      ? writeWarnings[0]
      : `${writeWarnings.length} ingest warnings: ${writeWarnings.slice(0, 2).join(" · ")}${writeWarnings.length > 2 ? ` … (+${writeWarnings.length - 2} more in .llm-wiki/ingest-warnings.log)` : ""}`
    activity.updateItem(activityId, { detail: `${warningSummary} — saved to .llm-wiki/ingest-warnings.log` })
  }
  await logDiag(pp, `writeFileBlocks cumulated ${writtenPaths.length} paths: [${writtenPaths.join(", ")}]`)
  for (const w of writeWarnings) {
    await logDiag(pp, `WARNING: ${w}`)
  }

  // ── Append extracted images to source-summary page ──
  if (mmCfg.enabled && savedImages.length > 0 && !signal?.aborted) {
    await injectImagesIntoSourceSummary(pp, sourceIdentity, sourceSummarySlug, savedImages)
  }

  if (writtenPaths.length > 0) {
    try {
      await refreshProjectFileTree(pp, { bumpDataVersion: true })
    } catch {
      // ignore
    }
  }

  // ── Save to cache ──
  if (writtenPaths.length > 0 && hardFailures.length === 0) {
    await saveIngestCache(pp, sourceIdentity, sourceContent, writtenPaths, false)
  } else if (hardFailures.length > 0) {
    console.warn(
      `[ingest] Skipping cache save for "${sourceIdentity}" — ${hardFailures.length} block(s) failed to write: ${hardFailures.join(", ")}`,
    )
  }

  // ── Generate embeddings ──
  const embCfg = useWikiStore.getState().embeddingConfig
  if (embCfg.enabled && embCfg.model && writtenPaths.length > 0) {
    try {
      const { embedPage } = await import("@/lib/embedding")
      for (const wpath of writtenPaths) {
        const pageId = wpath.split("/").pop()?.replace(/\.md$/, "") ?? ""
        if (!pageId || ["index", "log", "overview"].includes(pageId)) continue
        try {
          const content = await readFile(`${pp}/${wpath}`)
          const titleMatch = content.match(/^\s*---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
          const title = titleMatch ? titleMatch[1].trim() : pageId
          await embedPage(pp, pageId, title, content, embCfg)
        } catch {
          // non-critical
        }
      }
    } catch {
      // embedding module not available
    }
  }

  if (writtenPaths.length > 0 && hardFailures.length === 0) {
    await markIngestCacheComplete(pp, sourceIdentity)
    await clearStageCaches(pp, sourceIdentity)
  }

  const detail = writtenPaths.length > 0
    ? `${writtenPaths.length} files written${reviewItems.length > 0 ? `, ${reviewItems.length} review item(s)` : ""}`
    : "No files generated"
  await logDiag(pp, `autoIngestImpl EXIT for "${fileName}" — status=${writtenPaths.length > 0 ? "done" : "error"}, files=${writtenPaths.length}`)

  activity.updateItem(activityId, {
    status: writtenPaths.length > 0 ? "done" : "error",
    detail,
    filesWritten: writtenPaths,
  })

  return writtenPaths
}

// ── Public API ──

export async function autoIngest(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
  folderContext?: string,
  onFileWritten?: (relativePath: string) => void,
): Promise<string[]> {
  return withProjectLock(normalizePath(projectPath), () =>
    autoIngestImpl(projectPath, sourcePath, llmConfig, signal, folderContext, onFileWritten),
  )
}

export async function startIngest(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<void> {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const sourceIdentity = sourceIdentityForPath(pp, sp)
  const sourceSummarySlug = sourceSummarySlugFromIdentity(sourceIdentity)
  const store = getStore()
  store.setMode("ingest")
  store.setIngestSource(sp)
  store.clearMessages()
  store.setStreaming(false)

  void extractSourceImagesOnce(pp, sp, sourceSummarySlug).catch((err) => {
    console.warn(
      `[startIngest:images] eager extraction failed for "${getFileName(sp)}":`,
      err instanceof Error ? err.message : err,
    )
  })

  const [sourceContent, schema, purpose] = await Promise.all([
    tryReadSourceTextFile(sp),
    tryReadFile(`${pp}/schema.md`),
    tryReadFile(`${pp}/purpose.md`),
  ])
  const relatedPages = await searchRelatedWikiPages(pp, sourceIdentity, sourceContent)

  const systemPrompt = [
    "You are a knowledgeable assistant helping to build a wiki from source documents.",
    "",
    languageRule(sourceContent),
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    schema ? `## Wiki Schema\n${schema}` : "",
    relatedPages,
  ]
    .filter(Boolean)
    .join("\n\n")

  const userMessage = [
    `I'm ingesting the following source file into my wiki: **${sourceIdentity}**`,
    "",
    "Please read it carefully and present the key takeaways, important concepts, and information that would be valuable to capture in the wiki. Highlight anything that relates to the wiki's purpose and schema.",
    "",
    "---",
    `**File: ${sourceIdentity}**`,
    "```",
    sourceContent || "(empty file)",
    "```",
  ].join("\n")

  store.addMessage("user", userMessage)
  store.setStreaming(true)

  let accumulated = ""

  await streamChat(
    llmConfig,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    {
      onToken: (token) => {
        accumulated += token
        getStore().appendStreamToken(token)
      },
      onDone: () => {
        getStore().finalizeStream(accumulated)
      },
      onError: (err) => {
        getStore().finalizeStream(`Error during ingest: ${err.message}`)
      },
    },
    signal,
  )
}

export async function executeIngestWrites(
  projectPath: string,
  llmConfig: LlmConfig,
  userGuidance?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const store = getStore()
  const ingestSource = store.ingestSource
  const activeSourceIdentity = ingestSource
    ? sourceIdentityForPath(pp, ingestSource)
    : null
  const activeSourceSummarySlug = activeSourceIdentity
    ? sourceSummarySlugFromIdentity(activeSourceIdentity)
    : null
  const activeSourceSummaryPath = activeSourceSummarySlug
    ? `wiki/sources/${activeSourceSummarySlug}.md`
    : null

  const [schema] = await Promise.all([
    tryReadFile(`${pp}/schema.md`),
  ])

  const conversationHistory = store.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))

  const lastUserMessage = [...conversationHistory].reverse().find((m) => m.role === "user")
  const relatedPages = lastUserMessage?.content
    ? await searchRelatedWikiPages(pp, activeSourceIdentity ?? "", lastUserMessage.content)
    : ""

  const writePrompt = [
    "Based on our discussion, please generate the wiki files that should be created or updated.",
    "",
    userGuidance ? `Additional guidance: ${userGuidance}` : "",
    "",
    schema ? `## Wiki Schema\n${schema}` : "",
    relatedPages,
    activeSourceIdentity && activeSourceSummaryPath
      ? [
          `## Source File`,
          `The original source file is: **${activeSourceIdentity}**`,
          `If you generate a source summary page, it MUST use this exact path: **${activeSourceSummaryPath}**.`,
          // sources field is injected programmatically — no need for LLM to emit it
        ].join("\n")
      : "",
    "",
    "Output ONLY the file contents in this exact format for each file:",
    "```",
    "---FILE: wiki/path/to/file.md---",
    "(file content here)",
    "---END FILE---",
    "```",
    "",
    "For wiki/log.md, include a log entry to append. For all other files, output the complete file content.",
    "Use relative paths from the project root (e.g., wiki/sources/topic.md).",
    "Do not include any other text outside the FILE blocks.",
  ]
    .filter((line) => line !== undefined)
    .join("\n")

  conversationHistory.push({ role: "user", content: writePrompt })

  store.addMessage("user", writePrompt)
  store.setStreaming(true)

  let accumulated = ""

  const historyText = conversationHistory
    .map((m) => m.content)
    .join("\n")
    .slice(0, 2000)

  const systemPrompt = [
    "You are a wiki generation assistant. Your task is to produce structured wiki file contents.",
    "",
    languageRule(historyText),
    schema ? `## Wiki Schema\n${schema}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  await streamChat(
    llmConfig,
    [{ role: "system", content: systemPrompt }, ...conversationHistory],
    {
      onToken: (token) => {
        accumulated += token
        getStore().appendStreamToken(token)
      },
      onDone: () => {
        getStore().finalizeStream(accumulated)
      },
      onError: (err) => {
        getStore().finalizeStream(`Error generating wiki files: ${err.message}`)
      },
    },
    signal,
  )

  const writtenPaths: string[] = []
  const matches = accumulated.matchAll(FILE_BLOCK_REGEX)

  for (const match of matches) {
    let relativePath = match[1].trim()
    let content = match[2]

    if (!relativePath) continue
    if (
      activeSourceSummaryPath &&
      relativePath.startsWith("wiki/sources/")
    ) {
      relativePath = activeSourceSummaryPath
    }

    if (!isSafeIngestPath(relativePath) || isAppManagedAggregatePath(relativePath)) {
      console.warn(`[executeIngestWrites] rejected unsafe or app-managed path: ${relativePath}`)
      continue
    }

    if (
      activeSourceIdentity &&
      !isListingPath(relativePath)
    ) {
      content = injectSourcesField(content, activeSourceIdentity)
    }

    const fullPath = `${pp}/${relativePath}`

    try {
      await writeFile(fullPath, content)
      writtenPaths.push(fullPath)
    } catch (err) {
      console.error(`Failed to write ${fullPath}:`, err)
    }
  }

  if (writtenPaths.length > 0) {
    const fileList = writtenPaths.map((p) => `- ${p}`).join("\n")
    getStore().addMessage("system", `Files written to wiki:\n${fileList}`)
  } else {
    getStore().addMessage("system", "No files were written. The LLM response did not contain valid FILE blocks.")
  }

  // Image cascade for executeIngestWrites
  const mmCfgWrites = useWikiStore.getState().multimodalConfig
  if (ingestSource && mmCfgWrites.enabled) {
    let extractionKey: string | null = null
    try {
      const sourceIdentity = sourceIdentityForPath(pp, ingestSource)
      const sourceSummarySlug = sourceSummarySlugFromIdentity(sourceIdentity)
      extractionKey = await imageExtractionKey(pp, ingestSource, sourceSummarySlug)
      const savedImages = await extractSourceImagesOnceByKey(
        extractionKey, pp, ingestSource, sourceSummarySlug,
      )
      if (savedImages.length > 0) {
        await injectImagesIntoSourceSummary(pp, sourceIdentity, sourceSummarySlug, savedImages)
      }
    } catch (err) {
      console.warn(
        `[executeIngestWrites:images] post-write injection failed:`,
        err instanceof Error ? err.message : err,
      )
    } finally {
      if (extractionKey) ingestImageExtractionPromises.delete(extractionKey)
    }
  }

  return writtenPaths
}