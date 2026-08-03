/**
 * Duplicate-entity / -concept detection and merge for wiki maintenance.
 *
 * Problem: across re-ingests, the LLM names the same underlying
 * topic differently — `paos` vs `聚磷菌`, `dpao` vs `dpaos` (plural)
 * vs `反硝化除磷菌`, `vfa` vs `volatile-fatty-acids`. Each becomes a
 * separate page even though they're the same entity. The page-merge
 * layer only catches *exact* slug collisions; this module catches
 * the soft-collision case via an LLM-driven self-check.
 *
 * Three stages, each independently testable:
 *
 *   1. extractEntitySummaries: walk wiki/entities and wiki/concepts,
 *      pull (slug, title, description, tags) per page. Pure-data;
 *      no LLM.
 *   2. detectDuplicateGroups: hand the summary list to an LLM, ask
 *      it to identify groups of slugs likely to refer to the same
 *      thing. Returns parsed JSON groups with reason + confidence.
 *      The LLM call is injected so unit tests don't hit a model.
 *      Detection works in slugs (what the LLM sees) but the results
 *      are immediately resolved to *wiki-relative page paths* via
 *      resolveDuplicateGroups, so a duplicate basename (e.g. both
 *      wiki/entities/amanda.md and wiki/concepts/amanda.md share the
 *      slug "amanda") expands to two distinct pages instead of
 *      collapsing into one.
 *   3. mergeDuplicateGroup: given a confirmed group + chosen
 *      canonical page path, merge bodies (LLM call), union frontmatter
 *      array fields (deterministic), rewrite every wikilink /
 *      `related:` reference / index.md entry across the wiki, and
 *      package up a result the caller writes to disk + backs up.
 *
 * The caller (UI) is responsible for filesystem reads/writes and
 * for showing the user the candidate groups. This module only
 * transforms data.
 */

import { parseFrontmatter } from "./frontmatter"
import {
  parseFrontmatterArray,
  mergeArrayFieldsIntoContent,
  writeFrontmatterArray,
} from "./sources-merge"

// ──────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────

export interface EntitySummary {
  /** kebab-case slug (basename without `.md`). */
  slug: string
  /** Path relative to project root, e.g. `wiki/entities/foo.md`. */
  path: string
  /** entity | concept | source | ... — frontmatter `type` field. */
  type: string
  title: string
  /** Optional one-line description from frontmatter `description`,
   *  or the first non-empty body paragraph as a fallback. Truncated
   *  to ~200 chars to keep the detector prompt small. */
  description?: string
  tags: string[]
}

export interface DuplicateGroup {
  /** Two or more wiki-relative page paths, e.g. `wiki/entities/foo.md`.
   *  Paths (not slugs) so two pages that share a basename stay
   *  distinct. */
  pages: string[]
  /** Why the model believes these are duplicates. Short prose. */
  reason: string
  confidence: "high" | "medium" | "low"
}

/**
 * Raw detector output (pre path-resolution). Slugs are what the LLM
 * sees and emits; a single slug may map to several pages when two
 * directories contain the same basename. Only used transiently inside
 * detection — callers always get resolved `DuplicateGroup`s.
 */
export interface DetectorGroup {
  /** Two or more slugs from the input list. */
  slugs: string[]
  reason: string
  confidence: "high" | "medium" | "low"
}

export interface MergeRequest {
  /** Pages in the duplicate group, with their full content loaded. */
  group: { path: string; content: string }[]
  /** Path of the page to keep. Must be one of group[].path. The other
   *  pages are deleted; their wikilinks/related entries get rewritten
   *  to point here. */
  canonicalPath: string
  /** Every other .md under the project's wiki/ tree. Used to
   *  rewrite cross-references when the merge replaces multiple
   *  pages with one. */
  otherWikiPages: { path: string; content: string }[]
}

export interface MergeResult {
  /** Final content of the canonical page (frontmatter + body),
   *  after LLM body merge + deterministic frontmatter unification. */
  canonicalContent: string
  /** Path of the canonical page on disk (one of the group's). */
  canonicalPath: string
  /** Cross-reference rewrites in other wiki pages. Caller writes
   *  each (path → newContent) back to disk. */
  rewrites: { path: string; newContent: string }[]
  /** Paths to delete after canonical + rewrites are written.
   *  Excludes the canonical path. */
  pagesToDelete: string[]
  /** Snapshot of every file the merge touches BEFORE the merge
   *  was computed. Caller persists this to .llm-wiki/page-history/
   *  before writing changes so a bad merge can be rolled back. */
  backup: { path: string; content: string }[]
}

/**
 * Generic two-prompt LLM call. Both detector and merger use it.
 * Production wraps `streamChat`; tests use mocks.
 */
export type DedupLlmCall = (
  systemPrompt: string,
  userMessage: string,
  signal?: AbortSignal,
) => Promise<string>

// ──────────────────────────────────────────────────────────────────
// Stage 1: extract summaries (no LLM)
// ──────────────────────────────────────────────────────────────────

/**
 * Build an EntitySummary from a single page's path + content.
 * `pathRelativeToProject` should be the canonical wiki-relative
 * form (`wiki/entities/foo.md`) so callers downstream can derive
 * slugs consistently.
 */
export function extractEntitySummary(
  pathRelativeToProject: string,
  content: string,
): EntitySummary | null {
  const { frontmatter, body } = parseFrontmatter(content)
  if (!frontmatter) return null
  const type = stringField(frontmatter.type) ?? "unknown"
  const title = stringField(frontmatter.title) ?? slugFromPath(pathRelativeToProject)
  const description = stringField(frontmatter.description) ?? firstBodyParagraph(body)
  const tags = arrayField(frontmatter.tags)
  return {
    slug: slugFromPath(pathRelativeToProject),
    path: pathRelativeToProject,
    type,
    title,
    description: description ? truncate(description, 200) : undefined,
    tags,
  }
}

function slugFromPath(path: string): string {
  const base = path.split("/").pop() ?? path
  return base.replace(/\.md$/, "")
}

function stringField(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim() !== "") return v.trim()
  return undefined
}

function arrayField(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "")
}

function firstBodyParagraph(body: string): string | undefined {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean)
  // Skip leading h1/h2 lines so the description isn't just the title again.
  for (const line of lines) {
    if (line.startsWith("#")) continue
    if (line.startsWith("|")) continue // table — too noisy
    return line
  }
  return undefined
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + "…"
}

// ──────────────────────────────────────────────────────────────────
// Stage 2: LLM-driven duplicate detection
// ──────────────────────────────────────────────────────────────────

const DETECTOR_SYSTEM_PROMPT = `You are a wiki maintenance assistant. You will receive a list of entity / concept pages from a wiki. Identify groups of slugs that likely refer to the same underlying topic under different names — for example:

- Same name in two languages (English vs Chinese, etc.)
- Plural vs singular form (e.g. "dpao" vs "dpaos")
- Abbreviation vs full form (e.g. "vfa" vs "volatile-fatty-acids")
- Synonyms in the same language
- The same proper noun spelled differently

Output ONLY valid JSON. No prose, no markdown fences, no explanation outside the JSON. The schema is:

{
  "groups": [
    {
      "slugs": ["slug-a", "slug-b"],
      "reason": "Both refer to X; first is English, second is Chinese.",
      "confidence": "high"
    }
  ]
}

Rules:
- Only include groups of 2 or more slugs from the input list.
- "high" = clearly the same entity, only naming differs.
- "medium" = likely the same but context-dependent.
- "low" = uncertain; user should review carefully.
- Never invent slugs that aren't in the input.
- The same slug can appear multiple times when separate pages share a basename (e.g. "amanda" exists at both wiki/entities/amanda.md and wiki/concepts/amanda.md). List each slug occurrence you believe is duplicated — each will resolve to its own page.
- If no duplicates exist, output {"groups": []}.
- Pages of different \`type\` (e.g. an entity and a concept) usually should NOT be grouped — only group across types when they're unambiguously the same thing.`

/**
 * Run the LLM duplicate-detector. The caller hands in summaries
 * (typically every entity + concept page in the wiki) and a
 * function that wraps an LLM call. Returns parsed, validated
 * groups resolved to wiki-relative page paths — invalid entries
 * (slugs not in the input, single-element groups) are filtered
 * out so the caller never sees garbage, and colliding basenames
 * expand to one entry per page.
 *
 * Already-confirmed-not-duplicate groups passed in `notDuplicates`
 * (path-based) are filtered out before returning so the same false
 * positive doesn't keep appearing on every run.
 */
export async function detectDuplicateGroups(
  summaries: EntitySummary[],
  llmCall: DedupLlmCall,
  options: { signal?: AbortSignal; notDuplicates?: string[][] } = {},
): Promise<DuplicateGroup[]> {
  if (summaries.length < 2) return []

  const userMessage = buildDetectorUserMessage(summaries)
  const response = await llmCall(DETECTOR_SYSTEM_PROMPT, userMessage, options.signal)
  const parsed = parseDetectorResponse(response)

  const validSlugs = new Set(summaries.map((s) => s.slug))
  const raw = parsed
    .map((g) => ({ ...g, slugs: g.slugs.filter((s) => validSlugs.has(s)) }))
    .filter((g) => g.slugs.length >= 2)

  const notDupKeys = new Set(
    (options.notDuplicates ?? []).map((g) => normalizeGroupKey(g)),
  )

  return resolveDuplicateGroups(summaries, raw, { notDuplicateKeys: notDupKeys })
}

/**
 * Turn raw slug-groups from the LLM into page-path groups, expanding
 * every slug to all of its pages. A slug collision (the same basename
 * under two directories) therefore yields one entry per page instead
 * of silently collapsing to a single file — which is exactly the bug
 * that made merges "succeed" without deleting anything.
 */
export function resolveDuplicateGroups(
  summaries: EntitySummary[],
  rawGroups: DetectorGroup[],
  options: { notDuplicateKeys?: Set<string> } = {},
): DuplicateGroup[] {
  const slugToPaths = new Map<string, string[]>()
  for (const s of summaries) {
    const list = slugToPaths.get(s.slug)
    if (list) list.push(s.path)
    else slugToPaths.set(s.slug, [s.path])
  }

  const out: DuplicateGroup[] = []
  for (const g of rawGroups) {
    const seen = new Set<string>()
    for (const slug of g.slugs) {
      for (const path of slugToPaths.get(slug) ?? []) seen.add(path)
    }
    const pages = [...seen]
    if (pages.length < 2) continue
    if (options.notDuplicateKeys?.has(normalizeGroupKey(pages))) continue
    out.push({ pages, reason: g.reason, confidence: g.confidence })
  }
  return out
}

function buildDetectorUserMessage(summaries: EntitySummary[]): string {
  const lines = summaries.map((s) => {
    const tagPart = s.tags.length > 0 ? ` [${s.tags.join(", ")}]` : ""
    const descPart = s.description ? ` — ${s.description}` : ""
    return `- type=${s.type}, slug=${s.slug}, path=${s.path}, title=${JSON.stringify(s.title)}${tagPart}${descPart}`
  })
  return `## Wiki pages to scan (${summaries.length} entries)\n\n${lines.join("\n")}\n\nReturn duplicate groups as JSON only.`
}

/**
 * Tolerant JSON extraction. The LLM might wrap output in code
 * fences (\`\`\`json), prepend "Sure, here you go:", or trail
 * with a polite "Let me know if...". Pull the first {…} block
 * with balanced braces and parse it. Returns [] for any failure
 * — the caller treats "no duplicates found" identically to "LLM
 * output garbled".
 */
export function parseDetectorResponse(raw: string): DetectorGroup[] {
  const jsonText = extractFirstJsonObject(raw)
  if (!jsonText) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object") return []
  const groupsRaw = (parsed as { groups?: unknown }).groups
  if (!Array.isArray(groupsRaw)) return []

  const out: DetectorGroup[] = []
  for (const g of groupsRaw) {
    if (!g || typeof g !== "object") continue
    const obj = g as Record<string, unknown>
    const slugs = Array.isArray(obj.slugs)
      ? obj.slugs.filter((s): s is string => typeof s === "string")
      : []
    if (slugs.length < 2) continue
    const reason = typeof obj.reason === "string" ? obj.reason : ""
    const confidence: DetectorGroup["confidence"] =
      obj.confidence === "high" || obj.confidence === "medium"
        ? obj.confidence
        : "low"
    out.push({ slugs, reason, confidence })
  }
  return out
}

/** Extract the first balanced `{...}` substring from arbitrary text. */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{")
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === "\\") {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** Canonical key for a group — lowercased, sorted, comma-joined. */
function normalizeGroupKey(slugs: string[]): string {
  return [...slugs].map((s) => s.toLowerCase()).sort().join(",")
}

// ──────────────────────────────────────────────────────────────────
// Stage 3: merge a confirmed duplicate group
// ──────────────────────────────────────────────────────────────────

const MERGER_SYSTEM_PROMPT = `You are a wiki maintenance assistant. You will be given several wiki pages that all describe the same entity or concept under different names. Merge them into a single coherent wiki page.

Output the COMPLETE merged file (frontmatter + body). The first character of your response MUST be "-" (the opening of "---"). No preamble, no explanation outside the file.

Rules:
- Preserve every distinct factual claim from every input page.
- Eliminate redundancy (don't say the same thing twice across sections).
- Reorganize sections so the structure is logical for the unified topic, not a concatenation of inputs.
- Use [[wikilink]] syntax in the body where the inputs did.
- Frontmatter: keep the standard fields (type, title, created, updated, tags, related, sources). The caller will overwrite sources / tags / related / updated with deterministic unions afterward — your job is to produce a sensible body and reasonable frontmatter shape.
- Pick the most descriptive title. If the inputs use different languages, prefer the language that matches the majority of the body content.`

const FIELDS_TO_UNION = ["sources", "tags", "related"] as const

/**
 * Compute everything needed to merge a confirmed duplicate group:
 *   - LLM call to produce the merged canonical body
 *   - Deterministic frontmatter union (sources, tags, related)
 *   - Canonical slug enforcement on title path
 *   - Cross-reference rewrites across every other wiki page
 *   - Backup snapshot of all touched files
 *
 * Returns a MergeResult; the CALLER is responsible for actually
 * writing canonicalContent + each rewrite + deleting the merged-
 * away files + storing the backup. Splitting compute from I/O
 * keeps this testable.
 */
export async function mergeDuplicateGroup(
  req: MergeRequest,
  llmCall: DedupLlmCall,
  options: { signal?: AbortSignal; today?: () => string } = {},
): Promise<MergeResult> {
  const canonical = req.group.find((p) => p.path === req.canonicalPath)
  if (!canonical) {
    throw new Error(
      `canonicalPath "${req.canonicalPath}" is not in the group: ${req.group.map((p) => p.path).join(", ")}`,
    )
  }
  if (req.group.length < 2) {
    throw new Error("mergeDuplicateGroup requires at least 2 pages in the group")
  }
  const canonicalSlug = slugFromPath(req.canonicalPath)

  // 1. LLM body merge
  const userMessage = buildMergerUserMessage(req.group)
  const llmOutput = await llmCall(MERGER_SYSTEM_PROMPT, userMessage, options.signal)

  // 2. Frontmatter union (deterministic post-processing of LLM output).
  //    For each unioned field, fold every input page's values into
  //    the LLM output via mergeArrayFieldsIntoContent.
  let merged = llmOutput
  for (const page of req.group) {
    merged = mergeArrayFieldsIntoContent(merged, page.content, [...FIELDS_TO_UNION])
  }

  // 3. Stamp updated to today and force a sensible title.
  const today = (options.today ?? defaultToday)()
  merged = setFrontmatterScalar(merged, "updated", today)
  // If LLM output's frontmatter parses cleanly we leave its title;
  // if not, the application layer doesn't try to manufacture one.

  // 4. Cross-reference rewrites: every other wiki page that mentions
  //    a non-canonical slug needs its wikilinks / related entries
  //    rewritten to the canonical. Redirects are only established when
  //    the two slugs actually differ — when a collision means the
  //    non-canonical page shares the canonical's basename (e.g.
  //    wiki/concepts/amanda.md vs wiki/entities/amanda.md), `[[amanda]]`
  //    already targets the canonical slug and must NOT be rewritten.
  const slugRedirects = new Map<string, string>()
  for (const page of req.group) {
    const slug = slugFromPath(page.path)
    if (page.path !== req.canonicalPath && slug !== canonicalSlug) {
      slugRedirects.set(slug, canonicalSlug)
    }
  }
  const rewrites: MergeResult["rewrites"] = []
  for (const page of req.otherWikiPages) {
    const rewritten = rewriteCrossReferences(page.content, slugRedirects)
    if (rewritten !== page.content) {
      rewrites.push({ path: page.path, newContent: rewritten })
    }
  }

  // 5. Backup: every touched file's PRE-merge content.
  const backup: MergeResult["backup"] = []
  for (const page of req.group) {
    backup.push({ path: page.path, content: page.content })
  }
  for (const r of rewrites) {
    const orig = req.otherWikiPages.find((p) => p.path === r.path)
    if (orig) backup.push({ path: orig.path, content: orig.content })
  }

  // 6. Pages to delete: every group member except the canonical.
  const pagesToDelete = req.group
    .filter((p) => p.path !== req.canonicalPath)
    .map((p) => p.path)

  return {
    canonicalContent: merged,
    canonicalPath: canonical.path,
    rewrites,
    pagesToDelete,
    backup,
  }
}

function buildMergerUserMessage(
  group: { path: string; content: string }[],
): string {
  const sections = group.map((p, i) => {
    return [
      `## Page ${i + 1} (path: ${p.path})`,
      "",
      p.content,
      "",
    ].join("\n")
  })
  return [
    `These ${group.length} wiki pages have been confirmed by the user to describe the same topic.`,
    `Merge them into a single coherent page (the canonical path will be "${group[0].path}" or whichever the caller chose).`,
    "",
    sections.join("\n---\n\n"),
    "",
    "Now output the merged file. First character must be `-`.",
  ].join("\n")
}

/**
 * Rewrite cross-references to merged-away slugs throughout one
 * page's content. Three forms get rewritten:
 *
 *   1. `[[old-slug]]` and `[[old-slug|alias]]` in the body
 *      — replace just the target portion, keep alias if present.
 *   2. `related: [..., old-slug, ...]` (inline form) — substitute
 *      old-slug with canonical inside the array, then dedup.
 *   3. `related:\n  - old-slug` (block form) — same substitution.
 *
 * `wiki/index.md`-style listings of files are out of scope here —
 * the caller handles index regeneration separately.
 */
export function rewriteCrossReferences(
  content: string,
  slugRedirects: Map<string, string>,
): string {
  let out = content

  // 1. Wikilinks in the body — both [[slug]] and [[slug|alias]].
  for (const [oldSlug, newSlug] of slugRedirects) {
    const escaped = escapeRegex(oldSlug)
    const re = new RegExp(`\\[\\[${escaped}(\\|[^\\]]+)?\\]\\]`, "g")
    out = out.replace(re, (_match, alias) => `[[${newSlug}${alias ?? ""}]]`)
  }

  // 2. & 3. `related` field — re-parse and rewrite.
  const existing = parseFrontmatterArray(out, "related")
  if (existing.length > 0) {
    const rewritten = existing.map((s) => slugRedirects.get(s) ?? s)
    // Deduplicate (case-insensitive, first-seen casing wins)
    const seen = new Set<string>()
    const unique: string[] = []
    for (const s of rewritten) {
      const k = s.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      unique.push(s)
    }
    if (
      unique.length !== existing.length ||
      unique.some((s, i) => s !== existing[i])
    ) {
      out = writeFrontmatterArray(out, "related", unique)
    }
  }

  return out
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function setFrontmatterScalar(
  content: string,
  field: string,
  value: string,
): string {
  const m = content.match(/^(---\n)([\s\S]*?)(\n---)/)
  if (!m) return content
  const [, open, body, close] = m
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const newLine = `${field}: ${value}`
  const lineRe = new RegExp(`^${escaped}:\\s*(?!\\[)([^\\n]*)`, "m")
  if (lineRe.test(body)) {
    const rewritten = body.replace(lineRe, newLine)
    return `${open}${rewritten}${close}${content.slice(m[0].length)}`
  }
  return `${open}${body}\n${newLine}${close}${content.slice(m[0].length)}`
}

function defaultToday(): string {
  return new Date().toISOString().slice(0, 10)
}

// ──────────────────────────────────────────────────────────────────
// Index rewriter — wiki/index.md-specific
// ──────────────────────────────────────────────────────────────────

/**
 * Remove entries for merged-away pages from `wiki/index.md`.
 * Index files are typically formatted as bullet / link lists
 * grouped by section. This is a CONSERVATIVE rewriter:
 *   - Removes any whole line that references a merged-away page by
 *     path (`[X](concepts/amanda.md)`, `concepts/amanda.md`, …).
 *   - Also removes lines that reference a merged-away page by bare
 *     slug (`[[dpaos]]`, `dpaos.md`) — UNLESS `survivingSlug`
 *     collides with that slug. When a duplicate basename survives
 *     (wiki/entities/amanda.md kept, wiki/concepts/amanda.md merged
 *     away), `[[amanda]]` is ambiguous and is left untouched.
 *   - Preserves all other content verbatim (other sections, intros,
 *     the canonical entry).
 * The caller (UI) shows the user a diff before writing so any
 * over-removal is visible.
 */
export function rewriteIndexMd(
  content: string,
  removedPaths: Set<string>,
  survivingSlug?: string,
): string {
  if (removedPaths.size === 0) return content
  const lines = content.split("\n")
  const out: string[] = []
  for (const line of lines) {
    if (lineRefersToRemoved(line, removedPaths, survivingSlug)) continue
    out.push(line)
  }
  return out.join("\n")
}

function lineRefersToRemoved(
  line: string,
  removedPaths: Set<string>,
  survivingSlug: string | undefined,
): boolean {
  // 1. Path references — match the page regardless of slug collisions.
  //    Strip a leading `wiki/` so both `concepts/amanda.md` and the
  //    full `wiki/concepts/amanda.md` are caught.
  for (const path of removedPaths) {
    const matchable = path.replace(/^wiki\//, "")
    const escaped = escapeRegex(matchable)
    if (new RegExp(`\\([^)]*${escaped}\\)`).test(line)) return true
    if (new RegExp(`\\b${escaped}\\b`).test(line)) return true
  }
  // 2. Slug references — only when the slug uniquely names the removed
  //    page. If a surviving page shares the slug, skip (ambiguous).
  for (const path of removedPaths) {
    const slug = (path.split("/").pop() ?? "").replace(/\.md$/, "")
    if (!slug || slug === survivingSlug) continue
    const escaped = escapeRegex(slug)
    // Wikilink form: [[slug]] or [[slug|alias]]
    if (new RegExp(`\\[\\[${escaped}(\\|[^\\]]*)?\\]\\]`).test(line)) return true
    // Markdown link form: [...](slug.md) or [...](path/slug.md)
    if (new RegExp(`\\(([^)]*\\/)?${escaped}\\.md\\)`).test(line)) return true
    // Bare slug.md mention (rare but seen in raw lists)
    if (new RegExp(`\\b${escaped}\\.md\\b`).test(line)) return true
  }
  return false
}
