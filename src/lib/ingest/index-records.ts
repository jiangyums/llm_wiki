export interface IndexRecord {
  slug: string
  title: string
  type: string
  path: string
}

class WikiIndex {
  private bySlug = new Map<string, IndexRecord>()

  findBySlug(slug: string): IndexRecord | undefined {
    return this.bySlug.get(slug)
  }

  findByTitle(title: string): IndexRecord[] {
    const normalized = title.trim().toLowerCase()
    if (!normalized) return []
    const matches: IndexRecord[] = []
    for (const record of this.bySlug.values()) {
      if (record.title.trim().toLowerCase() === normalized) {
        matches.push(record)
      }
    }
    return matches
  }

  register(slug: string, title: string, type: string, path: string): void {
    this.bySlug.set(slug, { slug, title, type, path })
  }

  unregister(slug: string): void {
    this.bySlug.delete(slug)
  }
}

export const wikiIndex = new WikiIndex()
