import type { LlmConfig } from "@/stores/wiki-store"
import { streamChat } from "@/lib/llm-client"
import { IngestError } from "./errors"
import { languageRule } from "./prompts"
import { trimLongText } from "./utils"

// ── Compression Prompt Builder ──

function buildCompressSystemPrompt(sourceContent: string): string {
  return [
    "You are a compression engine for a personal wiki.",
    "Compress the provided source into a denser version of the SAME language.",
    "Do not output chain-of-thought, hidden reasoning, or a thinking transcript.",
    "PRESERVE ALL factual content: person/organization/entity names, place names, dates,",
    "numbers, events, claims, evidence, relationships, and key quotations.",
    "Remove redundancy, verbose narration, filler, and repetition, but keep the essential",
    "facts and structure. If the source uses a table or list to convey facts, keep it.",
    "Output ONLY the compressed text. No preamble, no headings such as \"Summary\",",
    "and no commentary.",
    "",
    languageRule(sourceContent),
  ].filter(Boolean).join("\n")
}

// ── Single-Pass Compression ──

export async function compressLongSource(
  llmConfig: LlmConfig,
  sourceIdentity: string,
  folderContext: string | undefined,
  sourceContent: string,
  targetChars: number,
  signal?: AbortSignal,
): Promise<string> {
  if (sourceContent.length <= targetChars) {
    return sourceContent
  }

  let compressed = ""
  let hadError = false
  let compressErr: Error | undefined
  await streamChat(
    llmConfig,
    [
      { role: "system", content: buildCompressSystemPrompt(sourceContent) },
      {
        role: "user",
        content: [
          `Source file: ${sourceIdentity}`,
          folderContext ? `Folder context: ${folderContext}` : "",
          "",
          "## SOURCE TO COMPRESS",
          sourceContent,
          "",
          `Compress the SOURCE above to at most ${targetChars} characters while preserving every named entity and fact. Output only the compressed text.`,
        ].filter(Boolean).join("\n"),
      },
    ],
    {
      onToken: (token) => { compressed += token },
      onDone: () => {},
      onError: (err) => { hadError = true; compressErr = err },
    },
    signal,
    { temperature: 0.1, max_tokens: 8192 },
  )

  if (hadError) {
    throw new IngestError("system", `Source compression failed: ${compressErr?.message ?? "unknown error"}`)
  }
  if (!compressed.trim()) {
    throw new IngestError("llm_output", "Compression returned empty output")
  }

  return trimLongText(compressed.trim(), targetChars)
}
