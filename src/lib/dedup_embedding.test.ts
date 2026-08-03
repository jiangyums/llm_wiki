import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./embedding", () => ({
  fetchEmbedding: vi.fn(),
}))

import { embedPages } from "./dedup_embedding"
import { fetchEmbedding } from "./embedding"

const mockCfg = {
  enabled: true,
  endpoint: "http://localhost:1234/v1/embeddings",
  apiKey: "",
  model: "mock",
}

describe("embedPages", () => {
  beforeEach(() => {
    vi.mocked(fetchEmbedding).mockReset()
  })

  it("calls onProgress after each page with correct (index, total)", async () => {
    vi.mocked(fetchEmbedding).mockResolvedValue([0.1, 0.2, 0.3])

    const pages = [
      { id: "a", title: "A", body: "body a" },
      { id: "b", title: "B", body: "body b" },
      { id: "c", title: "C", body: "body c" },
    ]

    const calls: Array<{ index: number; total: number }> = []
    const onProgress = (i: number, t: number) => calls.push({ index: i, total: t })

    const result = await embedPages(pages, mockCfg, { onProgress })

    expect(calls).toEqual([
      { index: 1, total: 3 },
      { index: 2, total: 3 },
      { index: 3, total: 3 },
    ])
    expect(result.size).toBe(3)
    expect(result.get("a")).toEqual([0.1, 0.2, 0.3])
  })

  it("does not call onProgress when not provided", async () => {
    vi.mocked(fetchEmbedding).mockResolvedValue([0.1, 0.2, 0.3])

    const pages = [
      { id: "a", title: "A", body: "body a" },
    ]

    await expect(embedPages(pages, mockCfg)).resolves.toBeDefined()
  })

  it("stops calling onProgress when a page fails to embed", async () => {
    vi.mocked(fetchEmbedding)
      .mockResolvedValueOnce([0.1, 0.2])
      .mockRejectedValueOnce(new Error("embedding failed"))

    const pages = [
      { id: "a", title: "A", body: "body a" },
      { id: "b", title: "B", body: "body b" },
    ]

    const calls: Array<{ index: number; total: number }> = []
    const onProgress = (i: number, t: number) => calls.push({ index: i, total: t })

    await expect(embedPages(pages, mockCfg, { onProgress })).rejects.toThrow("embedding failed")
    // The first page succeeded → onProgress called; the second threw before
    // onProgress was reached.
    expect(calls).toEqual([{ index: 1, total: 2 }])
  })
})