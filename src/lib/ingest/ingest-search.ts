import { searchWiki } from "@/lib/search"
import { normalizePath, getRelativePath } from "@/lib/path-utils"
import { sourceSummarySlugCandidatesFromIdentity } from "@/lib/source-identity"

export interface ManifestPage {
  type: "entity" | "concept"
  slug: string
  title: string
}

function typeFromPath(relativePath: string): string {
  const normalized = normalizePath(relativePath)
  if (/(^|\/)wiki\/entities\//.test(normalized)) return "entity"
  if (/(^|\/)wiki\/concepts\//.test(normalized)) return "concept"
  if (/(^|\/)wiki\/sources\//.test(normalized)) return "source"
  return "other"
}

export async function searchRelatedWikiPages(
  projectPath: string,
  sourceIdentity: string,
  sourceContext: string,
): Promise<string> {
  if (!sourceContext.trim()) return ""

  const results = await searchWiki(projectPath, sourceContext)
  if (results.length === 0) return ""

  const selfExclusionSlugs = new Set(sourceSummarySlugCandidatesFromIdentity(sourceIdentity))
  const pp = normalizePath(projectPath)
  const rows: string[] = []

  for (const result of results) {
    const relativePath = getRelativePath(result.path, pp)

    if (relativePath.startsWith("wiki/sources/")) continue

    const slug = relativePath.replace(/^wiki\/[^/]+\//, "").replace(/\.md$/, "")
    if (!slug || selfExclusionSlugs.has(slug)) continue

    const title = result.title?.trim() || slug
    const type = typeFromPath(relativePath)
    rows.push(`| ${slug} | ${title} | ${type} |`)
  }

  if (rows.length === 0) return ""
  return ["| slug | title | type |", "| --- | --- | --- |", ...rows].join("\n")
}

export function mergeRelatedPages(
  relatedPages: string,
  manifestPages: ManifestPage[],
): string {
  const header = "| slug | title | type |"
  const separator = "| --- | --- | --- |"
  const seen = new Set<string>()
  const rows: string[] = []

  for (const line of (relatedPages ?? "").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("|")) continue
    if (trimmed === header || trimmed === separator) continue
    const parts = trimmed.split("|").map((s) => s.trim()).filter(Boolean)
    if (parts.length < 3) continue
    const slug = parts[0].replace(/\.md$/, "")
    if (!slug || slug === "slug" || seen.has(slug)) continue
    seen.add(slug)
    rows.push(trimmed)
  }

  for (const page of manifestPages) {
    if (seen.has(page.slug)) continue
    seen.add(page.slug)
    rows.push(`| ${page.slug} | ${page.title} | ${page.type} |`)
  }

  if (rows.length === 0) return ""
  return [header, separator, ...rows].join("\n")
}
