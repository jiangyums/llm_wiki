import { beforeEach, describe, expect, it, vi } from "vitest"

const mockSearchWiki = vi.fn()

vi.mock("@/lib/search", () => ({
  searchWiki: (...args: unknown[]) => mockSearchWiki(...args),
}))

import { searchRelatedWikiPages, mergeRelatedPages } from "./ingest-search"

beforeEach(() => {
  mockSearchWiki.mockReset()
})

describe("searchRelatedWikiPages", () => {
  it("returns empty string for empty source context", async () => {
    expect(await searchRelatedWikiPages("/p", "src.txt", "")).toBe("")
  })

  it("returns empty string for whitespace-only source context", async () => {
    expect(await searchRelatedWikiPages("/p", "src.txt", "   ")).toBe("")
  })

  it("returns empty string when search returns nothing", async () => {
    mockSearchWiki.mockResolvedValueOnce([])
    expect(await searchRelatedWikiPages("/p", "src.txt", "some text")).toBe("")
  })

  it("emits slug/title/type rows with correct type inferred from path", async () => {
    mockSearchWiki.mockResolvedValueOnce([
      { path: "/p/wiki/entities/kleine-moretti.md", title: "克莱恩莫雷蒂", snippet: "", titleMatch: false, score: 0.9, images: [] },
      { path: "/p/wiki/concepts/beyonder-system.md", title: "非凡者体系", snippet: "", titleMatch: false, score: 0.8, images: [] },
      { path: "/p/wiki/sources/some.md", title: "A Source", snippet: "", titleMatch: false, score: 0.7, images: [] },
    ])

    const out = await searchRelatedWikiPages("/p", "src.txt", "some text")

    expect(out).toContain("| kleine-moretti | 克莱恩莫雷蒂 | entity |")
    expect(out).toContain("| beyonder-system | 非凡者体系 | concept |")
    expect(out).not.toContain("A Source")
  })

  it("excludes the current source's own slug", async () => {
    mockSearchWiki.mockResolvedValueOnce([
      { path: "/p/wiki/entities/src.md", title: "Src", snippet: "", titleMatch: false, score: 1, images: [] },
    ])

    const out = await searchRelatedWikiPages("/p", "src.txt", "text")

    expect(out).toBe("")
  })

  it("returns empty string when every result is filtered out", async () => {
    mockSearchWiki.mockResolvedValueOnce([
      { path: "/p/wiki/sources/a.md", title: "A", snippet: "", titleMatch: false, score: 1, images: [] },
    ])

    const out = await searchRelatedWikiPages("/p", "src.txt", "text")

    expect(out).toBe("")
  })
})

describe("mergeRelatedPages", () => {
  const header = "| slug | title | type |"
  const sep = "| --- | --- | --- |"

  it("keeps existing rows and appends manifest pages not already present", () => {
    const existing = [header, sep, "| zhou-ming-rui | 周明瑞 | other |"].join("\n")
    const manifest = [
      { type: "entity" as const, slug: "kleine-moretti", title: "克莱恩莫雷蒂" },
      { type: "entity" as const, slug: "zhou-ming-rui", title: "周明瑞" },
    ]

    const out = mergeRelatedPages(existing, manifest)

    expect(out).toContain("| zhou-ming-rui | 周明瑞 | other |")
    expect(out).not.toContain("| zhou-ming-rui | 周明瑞 | entity |")
    expect(out).toContain("| kleine-moretti | 克莱恩莫雷蒂 | entity |")
  })

  it("returns empty string when both inputs are empty", () => {
    expect(mergeRelatedPages("", [])).toBe("")
  })

  it("handles empty relatedPages and only emits manifest rows", () => {
    const manifest = [
      { type: "concept" as const, slug: "iron-age", title: "黑铁时代" },
    ]
    const out = mergeRelatedPages("", manifest)
    expect(out).toContain("| iron-age | 黑铁时代 | concept |")
  })
})