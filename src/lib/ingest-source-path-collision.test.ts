import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"
import { sourceSummarySlugFromIdentity } from "./source-identity"
import { migrateSourcePath } from "./source-lifecycle"

vi.mock("@/commands/fs", () => realFs)

vi.mock("@/lib/search", () => ({
  searchWiki: vi.fn(async () => []),
}))

let sourceMarkers: string[] = []
let failCompressOnce = false
let extraReviewResponse = ""
let generationSuffix = ""
let abortDuringReview: AbortController | null = null
let interactiveGenerationOverride = ""
let mergeRequestCount = 0

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, messages, cb) => {
    const systemPrompt = String(messages?.[0]?.content ?? "")
    const userPrompt = String(messages?.[1]?.content ?? "")

    if (systemPrompt.startsWith("You are merging two versions")) {
      mergeRequestCount++
      const incoming = userPrompt.split("## Newly generated version")[1]?.split("---")[0]
      cb.onToken(incoming?.trim() || "---\ntitle: merged\n---\n\n# merged")
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are a wiki generation assistant")) {
      if (interactiveGenerationOverride) {
        cb.onToken(interactiveGenerationOverride)
        cb.onDone()
        return
      }
      cb.onToken([
        "---FILE: wiki/sources/config.md---",
        "---",
        'type: "source"',
        'title: "Source: config.yaml"',
        'sources: ["config.yaml"]',
        "tags: []",
        "related: []",
        "---",
        "",
        "# Source: config.yaml",
        "",
        "Configuration source generated from the chat handoff.",
        "---END FILE---",
      ].join("\n"))
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are a compression engine for a personal wiki.")) {
      if (failCompressOnce) {
        failCompressOnce = false
        cb.onError(new Error("compression failed once"))
        return
      }
      cb.onToken("compressed long source content")
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are an expert research analyst")) {
      cb.onToken([
        "---FILE: wiki/.manifest---",
        "**entity**: `config` - Config",
        "**concept**: `config-topic` - Config Topic",
        "---END FILE---",
      ].join("\n"))
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are a wiki maintainer. Based on the analysis provided, generate wiki files.")) {
      const isEntity = userPrompt.includes("entity pages derived")
      const filler = "X".repeat(10_500)
      if (isEntity) {
        cb.onToken([
          "---FILE: wiki/entities/config.md---",
          "---",
          'title: "Config"',
          "---",
          "",
          "# Config",
          "",
          filler,
          "---END FILE---",
        ].join("\n"))
      } else {
        cb.onToken([
          "---FILE: wiki/concepts/config-topic.md---",
          "---",
          'title: "Config Topic"',
          "---",
          "",
          "# Config Topic",
          "",
          filler,
          "---END FILE---",
          generationSuffix,
        ].join("\n"))
      }
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are a wiki maintainer. Generate a single source summary page.")) {
      const marker = sourceMarkers.shift() ?? "unknown project"
      const targetPath =
        systemPrompt.match(/A single source summary page at \*\*(wiki\/sources\/[^*]+)\*\*/)?.[1] ??
        "wiki/sources/config.md"
      const sourceIdentity =
        systemPrompt.match(/original source file is:\s*\*\*([^*]+)\*\*/i)?.[1] ?? "config.yaml"
      cb.onToken([
        `---FILE: ${targetPath}---`,
        "---",
        `title: "Source: ${sourceIdentity}"`,
        `sources: ["${sourceIdentity}"]`,
        "---",
        "",
        `# ${marker}`,
        "",
        `Configuration details for ${marker}.`,
        "---END FILE---",
      ].join("\n"))
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are a wiki maintainer. Generate aggregate wiki pages")) {
      cb.onToken([
        "---FILE: wiki/overview.md---",
        "---",
        'title: "Overview"',
        "---",
        "",
        "# Overview",
        "",
        "Updated overview reflecting the new source.",
        "---END FILE---",
      ].join("\n"))
      cb.onDone()
      return
    }

    if (systemPrompt.startsWith("You are identifying high-value follow-up research items")) {
      if (abortDuringReview) {
        abortDuringReview.abort()
        throw new Error("AbortError")
      }
      cb.onToken(extraReviewResponse)
      cb.onDone()
      return
    }

    cb.onToken("## Analysis\nFallback response.")
    cb.onDone()
  }),
}))

vi.mock("./mineru", () => ({
  parseWithMineru: vi.fn(),
  parseWithMineruResult: vi.fn(),
}))

import {
  autoIngest,
  executeIngestWrites,
  hasMineruImageRefs,
} from "./ingest/index"
import { streamChat } from "./llm-client"
import { parseWithMineruResult } from "./mineru"

const mockStreamChat = vi.mocked(streamChat)
const mockParseWithMineru = vi.mocked(parseWithMineruResult)

describe("autoIngest source summary paths", () => {
  let tmp: { path: string; cleanup: () => Promise<void> } | undefined

  beforeEach(async () => {
    sourceMarkers = []
    failCompressOnce = false
    extraReviewResponse = ""
    generationSuffix = ""
    abortDuringReview = null
    interactiveGenerationOverride = ""
    mergeRequestCount = 0
    mockStreamChat.mockClear()
    mockParseWithMineru.mockReset()
    tmp = await createTempProject("same-basename-sources")

    await writeFileRaw(`${tmp.path}/purpose.md`, "# Purpose\n\nTrack project config files.\n")
    await writeFileRaw(
      `${tmp.path}/schema.md`,
      "# Schema\n\nEach source needs its own source summary page.\n\n## Page Types\n| goal | wiki/goals/ | Outcomes |\n| habit | wiki/habits/ | Behaviours |",
    )
    await writeFileRaw(`${tmp.path}/wiki/index.md`, "# Index\n")
    await writeFileRaw(`${tmp.path}/wiki/overview.md`, "# Overview\n")
    await writeFileRaw(`${tmp.path}/raw/sources/project-a/config.yaml`, "name: alpha\n")
    await writeFileRaw(`${tmp.path}/raw/sources/project-b/config.yaml`, "name: beta\n")

    useReviewStore.setState({ items: [] })
    useActivityStore.setState({ items: [] })
    useChatStore.setState({
      conversations: [],
      messages: [],
      activeConversationId: null,
      mode: "chat",
      ingestSource: null,
      isStreaming: false,
      streamingContent: "",
    })
    useWikiStore.setState({
      project: {
        id: "same-basename-sources",
        name: "same-basename-sources",
        path: tmp.path,
      },
      fileTree: [],
      outputLanguage: "auto",
      multimodalConfig: {
        enabled: false,
        useMainLlm: true,
        provider: "openai",
        apiKey: "",
        model: "",
        ollamaUrl: "",
        customEndpoint: "",
        concurrency: 1,
      },
      embeddingConfig: {
        enabled: false,
        endpoint: "",
        apiKey: "",
        model: "",
      },
      mineruConfig: {
        enabled: false,
        backend: "cloud",
        token: "",
        modelVersion: "vlm",
      },
    })
  })

  afterEach(async () => {
    await tmp?.cleanup()
    tmp = undefined
  })

  it("detects MinerU image refs with URL-encoded source summary slugs", () => {
    expect(hasMineruImageRefs(
      "![chart](media/%E6%B1%A1%E6%B0%B4%20paper/mineru/images/chart%281%29.png)",
      "污水 paper",
    )).toBe(true)
    expect(hasMineruImageRefs(
      "![chart](media/污水 paper/mineru/images/chart.png)",
      "污水 paper",
    )).toBe(true)
    expect(hasMineruImageRefs(
      "![chart](media/other/mineru/images/chart.png)",
      "污水 paper",
    )).toBe(false)
  })

  it("keeps distinct source summaries for same-basename files in different source subdirectories", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config", "project-b config"]

    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )
    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-b/config.yaml`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-b",
    )

    const sourcesDir = path.join(tmp.path, "wiki", "sources")
    const summaryFiles = (await fs.readdir(sourcesDir))
      .filter((name) => name.endsWith(".md"))
      .sort()
    const summaryContents = await Promise.all(
      summaryFiles.map((name) => fs.readFile(path.join(sourcesDir, name), "utf8")),
    )
    const allSummaries = summaryContents.join("\n\n--- summary boundary ---\n\n")

    expect(summaryFiles).toHaveLength(2)
    expect(allSummaries).toContain("project-a/config.yaml")
    expect(allSummaries).toContain("project-b/config.yaml")
  })

  it("replaces stale content when a corrected source solely owns the page", async () => {
    if (!tmp) throw new Error("missing temp project")
    const sourcePath = `${tmp.path}/raw/sources/project-a/config.yaml`
    sourceMarkers = ["obsolete wording"]
    await autoIngest(tmp.path, sourcePath, useWikiStore.getState().llmConfig)

    await writeFileRaw(sourcePath, "name: corrected\n")
    sourceMarkers = ["corrected wording"]
    await autoIngest(tmp.path, sourcePath, useWikiStore.getState().llmConfig)

    const summaryPath = `${tmp.path}/wiki/sources/${sourceSummarySlugFromIdentity("project-a/config.yaml")}.md`
    const content = await fs.readFile(summaryPath, "utf8")
    expect(content).toContain("corrected wording")
    expect(content).not.toContain("obsolete wording")
    expect(mergeRequestCount).toBeGreaterThan(0)
  })

  it("moves the canonical source summary and its source reference", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["movable summary"]
    const oldSource = `${tmp.path}/raw/sources/project-a/config.yaml`
    await autoIngest(tmp.path, oldSource, useWikiStore.getState().llmConfig)

    const oldIdentity = "project-a/config.yaml"
    const newIdentity = "archive/config.yaml"
    const oldSummary = `${tmp.path}/wiki/sources/${sourceSummarySlugFromIdentity(oldIdentity)}.md`
    const newSummary = `${tmp.path}/wiki/sources/${sourceSummarySlugFromIdentity(newIdentity)}.md`
    await migrateSourcePath(
      tmp.path,
      "raw/sources/project-a/config.yaml",
      "raw/sources/archive/config.yaml",
    )

    await expect(fs.access(oldSummary)).rejects.toThrow()
    const content = await fs.readFile(newSummary, "utf8")
    expect(content).toContain('sources: ["archive/config.yaml"]')
  })

  it("migrates source references for a case-only rename", async () => {
    if (!tmp) throw new Error("missing temp project")
    const pagePath = `${tmp.path}/wiki/entities/case.md`
    await writeFileRaw(pagePath, [
      "---",
      'sources: ["project-a/config.yaml"]',
      "---",
      "# Case",
    ].join("\n"))

    await migrateSourcePath(
      tmp.path,
      "raw/sources/project-a/config.yaml",
      "raw/sources/Project-A/config.yaml",
    )

    expect(await fs.readFile(pagePath, "utf8")).toContain(
      'sources: ["Project-A/config.yaml"]',
    )
  })

  it("migrates a unique legacy basename source reference", async () => {
    if (!tmp) throw new Error("missing temp project")
    // Remove the second same-basename source so the legacy shorthand is
    // unambiguous after the move.
    await fs.rm(`${tmp.path}/raw/sources/project-b/config.yaml`)
    const pagePath = `${tmp.path}/wiki/entities/legacy.md`
    await writeFileRaw(pagePath, [
      "---",
      'sources: ["config.yaml"]',
      "---",
      "# Legacy",
    ].join("\n"))

    await migrateSourcePath(
      tmp.path,
      "raw/sources/project-a/config.yaml",
      "raw/sources/archive/config.yaml",
    )

    expect(await fs.readFile(pagePath, "utf8")).toContain(
      'sources: ["archive/config.yaml"]',
    )
  })

  it("does not rewrite an ambiguous legacy basename source reference", async () => {
    if (!tmp) throw new Error("missing temp project")
    const pagePath = `${tmp.path}/wiki/entities/ambiguous.md`
    await writeFileRaw(pagePath, [
      "---",
      'sources: ["config.yaml"]',
      "---",
      "# Ambiguous",
    ].join("\n"))

    await migrateSourcePath(
      tmp.path,
      "raw/sources/project-a/config.yaml",
      "raw/sources/archive/config.yaml",
    )

    expect(await fs.readFile(pagePath, "utf8")).toContain(
      'sources: ["config.yaml"]',
    )
  })

  it("migrates a safe legacy basename source summary to the canonical nested source path", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]
    await fs.rm(path.join(tmp.path, "raw", "sources", "project-b", "config.yaml"))

    const legacySummaryPath = path.join(tmp.path, "wiki", "sources", "config.md")
    await writeFileRaw(
      legacySummaryPath,
      [
        "---",
        'title: "Source: config.yaml"',
        'sources: ["config.yaml"]',
        "---",
        "",
        "# Legacy config",
        "",
        "Legacy source summary body.",
      ].join("\n"),
    )

    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )

    const canonicalSummary = `wiki/sources/${sourceSummarySlugFromIdentity("project-a/config.yaml")}.md`
    const canonicalSummaryPath = path.join(tmp.path, canonicalSummary)
    const content = await fs.readFile(canonicalSummaryPath, "utf8")

    expect(content).toContain('sources: ["project-a/config.yaml"]')
    expect(content).toContain("project-a config")
    expect(await fs.readFile(legacySummaryPath, "utf8")).toContain("Legacy source summary body.")
  })

  it("does not migrate a legacy basename source summary when the basename is ambiguous", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]

    const legacySummaryPath = path.join(tmp.path, "wiki", "sources", "config.md")
    const legacyContent = [
      "---",
      'title: "Source: config.yaml"',
      'sources: ["config.yaml"]',
      "---",
      "",
      "# Legacy config",
      "",
      "Ambiguous legacy source summary body.",
    ].join("\n")
    await writeFileRaw(legacySummaryPath, legacyContent)

    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )

    const canonicalSummary = `wiki/sources/${sourceSummarySlugFromIdentity("project-a/config.yaml")}.md`
    const canonicalSummaryPath = path.join(tmp.path, canonicalSummary)

    expect(await fs.readFile(legacySummaryPath, "utf8")).toBe(legacyContent)
    expect(await fs.readFile(canonicalSummaryPath, "utf8")).toContain("project-a config")
  })

  it("compresses oversized sources before final wiki generation", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["long source"]
    const longSourcePath = `${tmp.path}/raw/sources/project-a/long-report.md`
    await writeFileRaw(
      longSourcePath,
      [
        "# Chapter One",
        "",
        "A".repeat(6000),
        "",
        "## Chapter Two",
        "",
        "B".repeat(6000),
      ].join("\n"),
    )

    await autoIngest(
      tmp.path,
      longSourcePath,
      { ...useWikiStore.getState().llmConfig, maxContextSize: 20_000 },
      undefined,
      "project-a",
    )

    const compressCalls = mockStreamChat.mock.calls.filter(([, messages]) =>
      String(messages?.[0]?.content ?? "").startsWith(
        "You are a compression engine for a personal wiki.",
      ),
    )
    expect(compressCalls.length).toBe(1)
    expect(String(compressCalls[0][1]?.[1]?.content ?? "")).toContain("## SOURCE TO COMPRESS")

    const analysisCall = mockStreamChat.mock.calls.find(([, messages]) =>
      String(messages?.[0]?.content ?? "").startsWith("You are an expert research analyst"),
    )
    expect(String(analysisCall?.[1]?.[1]?.content ?? "")).toContain(
      "compressed long source content",
    )

    const summaryFiles = (await fs.readdir(`${tmp.path}/wiki/sources`)).filter((name) =>
      name.endsWith(".md"),
    )
    expect(summaryFiles.length).toBeGreaterThan(0)
  })

  it("resumes an interrupted oversized ingest from the persisted stage checkpoint", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["long source"]
    failCompressOnce = true
    const longSourcePath = `${tmp.path}/raw/sources/project-a/resume-report.md`
    const llmConfig = { ...useWikiStore.getState().llmConfig, maxContextSize: 20_000 }
    await writeFileRaw(
      longSourcePath,
      [
        "# Chapter One",
        "",
        "A".repeat(6000),
        "",
        "## Chapter Two",
        "",
        "B".repeat(6000),
      ].join("\n"),
    )

    await expect(
      autoIngest(tmp.path, longSourcePath, llmConfig, undefined, "project-a"),
    ).rejects.toThrow("Source compression failed")

    const cacheJson = JSON.parse(
      await fs.readFile(`${tmp.path}/.llm-wiki/ingest-cache.json`, "utf8"),
    )
    expect(cacheJson.entries["project-a/resume-report.md"].lastStage).toBe(1)

    mockStreamChat.mockClear()
    await autoIngest(tmp.path, longSourcePath, llmConfig, undefined, "project-a")

    const resumedCompressCalls = mockStreamChat.mock.calls.filter(([, messages]) =>
      String(messages?.[0]?.content ?? "").startsWith(
        "You are a compression engine for a personal wiki.",
      ),
    )
    expect(resumedCompressCalls.length).toBeGreaterThan(0)
    expect(String(resumedCompressCalls[0][1]?.[1]?.content ?? "")).toContain(
      "## SOURCE TO COMPRESS",
    )

    const stageCacheRoot = path.join(tmp.path, ".llm-wiki", "ingest-stage-cache")
    const stageDirs = await fs.readdir(stageCacheRoot)
    for (const dir of stageDirs) {
      expect(await fs.readdir(path.join(stageCacheRoot, dir))).toEqual([])
    }
    expect(
      (await fs.readdir(`${tmp.path}/wiki/sources`)).filter((name) => name.endsWith(".md")).length,
    ).toBeGreaterThan(0)
  })

  it("adds follow-up research reviews from the dedicated review stage", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]
    generationSuffix = [
      "",
      "---FILE: wiki/concepts/nitrification-inhibition.md---",
      "---",
      'title: "Nitrification inhibition"',
      "---",
      "",
      "# Nitrification inhibition",
      "",
      "X".repeat(10_500),
      "---END FILE---",
    ].join("\n")
    extraReviewResponse = [
      "---REVIEW: suggestion | Research nitrification inhibition signals---",
      "Add follow-up research on early-warning indicators for nitrification inhibition.",
      "OPTIONS: Create Page | Skip",
      "SEARCH: nitrification inhibition early warning wastewater | ammonia oxidation inhibition signals | wastewater nitrification process upset indicators",
      "---END REVIEW---",
    ].join("\n")

    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )

    const reviews = useReviewStore.getState().items
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({
      type: "suggestion",
      title: "Research nitrification inhibition signals",
    })
    expect(reviews[0].searchQueries).toEqual([
      "nitrification inhibition early warning wastewater",
      "ammonia oxidation inhibition signals",
      "wastewater nitrification process upset indicators",
    ])
  })

  it("parses generation and dedicated review-stage blocks separately", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]
    generationSuffix = [
      "",
      "---REVIEW: missing-page | Truncated Orphan---",
      "Partial description that got cut off",
    ].join("\n")
    extraReviewResponse = [
      "---REVIEW: suggestion | Real Follow-up---",
      "Real description that should not be swallowed by the generation orphan.",
      "OPTIONS: Create Page | Skip",
      "SEARCH: real follow up query | second query",
      "---END REVIEW---",
    ].join("\n")

    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/config.yaml`,
      { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 },
      undefined,
      "project-a",
    )

    const reviews = useReviewStore.getState().items
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({
      type: "suggestion",
      title: "Real Follow-up",
    })
    expect(reviews[0].description).not.toContain("Truncated Orphan")
  })

  it("propagates cancellation that happens during the dedicated review stage", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["project-a config"]
    generationSuffix = `${"\n"}${"X".repeat(10_500)}`
    const controller = new AbortController()
    abortDuringReview = controller

    await expect(
      autoIngest(
        tmp.path,
        `${tmp.path}/raw/sources/project-a/config.yaml`,
        { ...useWikiStore.getState().llmConfig, maxContextSize: 128_000 },
        controller.signal,
        "project-a",
      ),
    ).rejects.toThrow("Ingest cancelled")
  })

  it("falls back to built-in PDF extraction when MinerU fails for a non-cancelled ingest", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["mineru fallback source"]
    await writeFileRaw(`${tmp.path}/raw/sources/project-a/report.pdf`, "pdf fallback text\n")
    useWikiStore.setState({
      mineruConfig: {
        enabled: true,
        token: "mineru-token",
        modelVersion: "vlm",
      },
    })
    mockParseWithMineru.mockRejectedValueOnce(new Error("network failure from MinerU"))
    const updateSpy = vi.spyOn(useActivityStore.getState(), "updateItem")

    const written = await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/report.pdf`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )

    expect(written.length).toBeGreaterThan(0)
    expect(mockParseWithMineru).toHaveBeenCalled()
    expect(
      updateSpy.mock.calls.some(([, updates]) =>
        updates.detail?.includes("falling back to built-in PDF extraction"),
      ),
    ).toBe(true)
    updateSpy.mockRestore()
  })

  it("uses a configured local MinerU backend without a cloud token", async () => {
    if (!tmp) throw new Error("missing temp project")
    sourceMarkers = ["local mineru source"]
    await writeFileRaw(`${tmp.path}/raw/sources/project-a/local.pdf`, "pdf fallback text\n")
    useWikiStore.setState({
      mineruConfig: {
        enabled: true,
        backend: "local",
        token: "",
        modelVersion: "vlm",
      },
    })
    mockParseWithMineru.mockResolvedValueOnce({
      markdown: "local MinerU markdown",
      savedImages: [],
    })

    await autoIngest(
      tmp.path,
      `${tmp.path}/raw/sources/project-a/local.pdf`,
      useWikiStore.getState().llmConfig,
      undefined,
      "project-a",
    )

    expect(mockParseWithMineru).toHaveBeenCalled()
  })

  it("does not fall back to built-in PDF extraction when MinerU is cancelled", async () => {
    if (!tmp) throw new Error("missing temp project")
    await writeFileRaw(`${tmp.path}/raw/sources/project-a/cancelled.pdf`, "pdf fallback text\n")
    useWikiStore.setState({
      mineruConfig: {
        enabled: true,
        token: "mineru-token",
        modelVersion: "vlm",
      },
    })
    const controller = new AbortController()
    controller.abort()
    mockParseWithMineru.mockRejectedValueOnce(new Error("MinerU parsing cancelled"))

    await expect(
      autoIngest(
        tmp.path,
        `${tmp.path}/raw/sources/project-a/cancelled.pdf`,
        useWikiStore.getState().llmConfig,
        controller.signal,
        "project-a",
      ),
    ).rejects.toThrow("Ingest cancelled")

    expect(
      useActivityStore.getState().items.some((item) =>
        item.detail?.includes("falling back to built-in PDF extraction"),
      ),
    ).toBe(false)
  })

  it("canonicalizes interactive source summary paths and sources frontmatter", async () => {
    if (!tmp) throw new Error("missing temp project")

    const conversationId = "conv-interactive-source"
    useChatStore.setState({
      activeConversationId: conversationId,
      conversations: [
        {
          id: conversationId,
          title: "Interactive source summary",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      ingestSource: `${tmp.path}/raw/sources/project-a/config.yaml`,
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Please save the source summary.",
          timestamp: Date.now(),
          conversationId,
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "Ready to create the source summary.",
          timestamp: Date.now(),
          conversationId,
        },
      ],
    })

    const writtenPaths = await executeIngestWrites(
      tmp.path,
      useWikiStore.getState().llmConfig,
    )

    const canonicalSummary = `wiki/sources/${sourceSummarySlugFromIdentity("project-a/config.yaml")}.md`
    const canonicalSummaryPath = path.join(tmp.path, canonicalSummary).replace(/\\/g, "/")
    const staleSummaryPath = path.join(tmp.path, "wiki", "sources", "config.md")
    const content = await fs.readFile(canonicalSummaryPath, "utf8")

    expect(writtenPaths.map((p) => p.replace(/\\/g, "/"))).toEqual([canonicalSummaryPath])
    await expect(fs.access(staleSummaryPath)).rejects.toThrow()
    expect(content).toContain('sources: ["project-a/config.yaml"]')
  })

  it("rejects unsafe and application-managed paths from interactive writes", async () => {
    if (!tmp) throw new Error("missing temp project")
    interactiveGenerationOverride = [
      "---FILE: wiki/INDEX.md---\n# hostile index\n---END FILE---",
      "---FILE: wiki\\overview.MD---\n# hostile overview\n---END FILE---",
      "---FILE: ../escape.md---\n# escape\n---END FILE---",
    ].join("\n")
    useChatStore.setState({ ingestSource: `${tmp.path}/raw/sources/project-a/config.yaml` })

    const written = await executeIngestWrites(tmp.path, useWikiStore.getState().llmConfig)

    expect(written).toEqual([])
    await expect(fs.access(path.join(tmp.path, "escape.md"))).rejects.toThrow()
  })
})
