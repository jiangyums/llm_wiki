/**
 * Persistence for the dedup tool's "not duplicates" whitelist.
 *
 * When the user reviews a candidate group and says "these are NOT
 * the same thing", we record the group so the next detector run
 * doesn't re-suggest it. Stored as a JSON array-of-arrays where
 * each inner array is one whitelisted group of wiki-relative page
 * paths (lowercased, sorted — see the canonical key logic in
 * `dedup.ts`). Paths (not slugs) are the identity, so colliding
 * basenames stay distinct.
 *
 * Lives next to ingest-cache.json / image-caption-cache.json /
 * lexical-graph.json (when added) — same `.llm-wiki/` directory,
 * same JSON-on-disk pattern.
 */
import { readFile, writeFile, fileExists } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

const FILE_NAME = ".llm-wiki/dedup-not-duplicates.json"

export async function loadNotDuplicates(projectPath: string): Promise<string[][]> {
  const pp = normalizePath(projectPath)
  const filePath = `${pp}/${FILE_NAME}`
  try {
    if (!(await fileExists(filePath))) return []
  } catch {
    return []
  }
  try {
    const content = await readFile(filePath)
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (g): g is string[] =>
        Array.isArray(g)
        && g.every((s) => typeof s === "string")
        // Legacy entries were bare slugs ("foo"); only path-based
        // entries ("wiki/entities/foo.md") can participate now.
        && g.every((s) => s.endsWith(".md")),
    )
  } catch {
    return []
  }
}

export async function saveNotDuplicates(
  projectPath: string,
  list: string[][],
): Promise<void> {
  const pp = normalizePath(projectPath)
  await writeFile(`${pp}/${FILE_NAME}`, JSON.stringify(list, null, 2))
}

/**
 * Add a group of page paths to the whitelist. Idempotent — if the
 * same group (in any order, any casing) is already present, this is
 * a no-op.
 */
export async function addNotDuplicate(
  projectPath: string,
  paths: string[],
): Promise<void> {
  if (paths.length < 2) return
  const list = await loadNotDuplicates(projectPath)
  const normNew = canonicalKey(paths)
  for (const existing of list) {
    if (canonicalKey(existing) === normNew) return // already there
  }
  list.push([...paths].sort())
  await saveNotDuplicates(projectPath, list)
}

function canonicalKey(paths: string[]): string {
  return [...paths].map((s) => s.toLowerCase()).sort().join(",")
}
