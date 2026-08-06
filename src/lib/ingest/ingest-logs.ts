import { createDirectory, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

/**
 * Per-stage ingest log files.
 *
 * Each LLM-backed ingest stage writes its input prompt, final output, and
 * reasoning transcript to `.llm-wiki/ingest-logs/ingest-stage<N>-{kind}.log`
 * so a failed run can be inspected without the logs polluting the wiki
 * content directory. All writes are best-effort (mirroring stage-cache):
 * a logging failure must never fail the ingest run.
 */

export type IngestLogKind = "prompt" | "output" | "reasoning"

export function stageLogPath(pp: string, stage: number, kind: IngestLogKind): string {
  return `${normalizePath(pp)}/.llm-wiki/ingest-logs/ingest-stage${stage}-${kind}.log`
}

export async function writeStageLog(
  pp: string,
  stage: number,
  kind: IngestLogKind,
  content: string,
): Promise<void> {
  try {
    await createDirectory(`${normalizePath(pp)}/.llm-wiki/ingest-logs`)
    await writeFile(stageLogPath(pp, stage, kind), content)
  } catch {
    // non-critical: per-stage logs are a debugging aid
  }
}
