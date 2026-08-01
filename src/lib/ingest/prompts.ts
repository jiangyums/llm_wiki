import { buildLanguageDirective } from "@/lib/output-language"
import { computeContextBudget } from "@/lib/context-budget"
import { GENERATION_WIKI_TYPES } from "@/lib/wiki-page-types"
import { currentWikiDate, trimLongText, aggregateRepairSectionCap } from "./utils"

/**
 * Build the language rule for ingest prompts.
 * Uses the user's configured output language, falling back to source content detection.
 */
export function languageRule(sourceContent: string = ""): string {
  return buildLanguageDirective(sourceContent)
}

/**
 * Step 1 prompt: AI reads the source and produces a structured analysis.
 * This is the "discussion" step — the AI reasons about the source before writing wiki pages.
 */
export function buildAnalysisPrompt(purpose: string, relatedPages: string, sourceContent: string = "", schema: string = ""): string {
  return [
    "You are an expert research analyst. Read the source document and produce a structured analysis.",
    "Do not output chain-of-thought, hidden reasoning, or a thinking transcript. Reason internally and write only the concise final analysis.",
    "",
    languageRule(sourceContent),
    "",
    `The analysis structure is defined by the project's purpose.md. Follow the sections and priorities specified in the Wiki Purpose section below.`,
    "",
    "CRITICAL: Do NOT split a single concept into multiple sub-concepts based on different",
    "aspects or attributes. For example, if the source discusses 'memory fragments' causes,",
    "features, and significance — that is ONE concept ('memory fragments'), not separate",
    "concepts for each aspect. Only create distinct concepts when they refer to fundamentally",
    "different things.",
    "",
    "## Page Manifest",
    "Include a `## 建议创建的Wiki页面` section listing all entity and concept pages needed.",
    "Wrap this section in a FILE block marker:",
    "",
    "```",
    "---FILE: wiki/.manifest---",
    "**entity**: `slug.md` - Title",
    "**concept**: `slug.md` - Title",
    "---END FILE---",
    "```",
    "",
    "The `---FILE: wiki/.manifest---` / `---END FILE---` wrapper is REQUIRED — the pipeline reads it to build the page generation plan.",
    "",
    "CRITICAL — Slug naming rules (follow exactly):",
    "- Person names → kebab-case pinyin (e.g. `kleine-moretti`, `zhou-ming-rui`)",
    "- Non-person names (places, objects, concepts, etc.) → kebab-case English (e.g. `revolver`, `crimson-moon`, `transmigration`, `hermit-script`)",
    "- NEVER use Chinese characters in slugs",
    "- NEVER use pinyin for non-person names",
    "",
    schema
      ? `## Project Schema (page types available — map source content to schema-defined types when it fits)\n${schema}`
      : "",
    purpose ? `## Wiki Purpose (for context)\n${purpose}` : "",
    relatedPages,
  ].filter(Boolean).join("\n")
}

/**
 * Step 2 prompt: AI takes its own analysis and generates wiki files + review items.
 */
export function buildGenerationPrompt(
  schema: string,
  purpose: string,
  relatedPages: string,
  sourceFileName: string,
  overview?: string,
  sourceContent: string = "",
  mode: "entities" | "concepts" = "entities",
): string {
  // Use original filename (without extension) as the source summary page name
  const today = currentWikiDate()

  const whatToGenerate = mode === "entities"
    ? [
        "## What to generate",
        "",
        "Entity pages for key named things (people, places, organizations, objects) identified in the analysis.",
        "Write to wiki/entities/ unless the schema specifies a different directory.",
        "",
        "Each entity page body MUST NOT exceed 1000 Chinese characters.",
        "",
        "CRITICAL: Do NOT split a single entity into multiple sub-entities based on different",
        "aspects or attributes. For example, if the source discusses a character's background,",
        "personality, and actions — that is ONE entity, not separate entities for each aspect.",
        "Only create distinct entities when they refer to fundamentally different things.",
      ].join("\n")
    : [
        "## What to generate",
        "",
        "Concept pages for key ideas, methods, techniques, and abstractions identified in the analysis.",
        "Write to wiki/concepts/ unless the schema specifies a different directory.",
        "",
        "Each concept page body MUST NOT exceed 1000 Chinese characters.",
        "",
        "CRITICAL: Do NOT split a single concept into multiple sub-concepts based on different",
        "aspects or attributes. For example, if the source discusses 'memory fragments' causes,",
        "features, and significance — that is ONE concept ('memory fragments'), not separate",
        "concepts for each aspect. Only create distinct concepts when they refer to fundamentally",
        "different things.",
      ].join("\n")

  const exampleType = mode === "entities" ? "entity" : "concept"

  return [
    "You are a wiki maintainer. Based on the analysis provided, generate wiki files.",
    "Do not output chain-of-thought, hidden reasoning, or explanatory preamble. Reason internally and output only the requested FILE/REVIEW blocks.",
    "",
    languageRule(sourceContent),
    "",
    `## IMPORTANT: Source File`,
    `The original source file is: **${sourceFileName}**`,
    `Today's date is **${today}**. Use this exact date for all new \`created\`, \`updated\`, and wiki/log.md ingest dates.`,
    "",
    schema
      ? [
          "## Project Schema and Routing (AUTHORITATIVE)",
          schema,
          "",
          "Use this schema as the primary routing rule for page types and directories.",
          "If it defines custom folders or distinctions (for example people, technologies, organizations, methods, or cases), write pages into those schema-defined folders instead of forcing them into wiki/entities/ or wiki/concepts/.",
          "Use wiki/entities/ and wiki/concepts/ only when the schema does not provide a more specific destination.",
          "Every generated page's frontmatter type must match the schema directory used in its FILE path.",
        ].join("\n")
      : "",
    "",
    whatToGenerate,
    "",
    "## Frontmatter Rules (CRITICAL — parser is strict)",
    "",
    "Every page begins with a YAML frontmatter block. Format rules, in order of importance:",
    "",
    "1. The VERY FIRST line of the file MUST be exactly `---` (three hyphens, nothing else).",
    "   Do NOT wrap the file in a ```yaml ... ``` code fence.",
    "   Do NOT prefix it with a `frontmatter:` key or any other line.",
    "2. Each frontmatter line is a `key: value` pair on its own line.",
    "3. The frontmatter ends with another `---` line on its own.",
    "4. The next line after the closing `---` is the start of the page body.",
    "5. Arrays use the standard YAML inline form `[a, b, c]` (no outer brackets around each item).",
    "",
    "Required fields and types:",
    `  • type     — one of the known types (${GENERATION_WIKI_TYPES.join(" | ")}), or a custom type explicitly defined by the project schema`,
    "  • title    — string without any punctuation marks (colons, quotes, commas, etc.)",
    `  • created  — ${today} for new pages (YYYY-MM-DD, no quotes)`,
    `  • updated  — ${today} for new pages (same as created)`,
    "  • tags     — array of bare strings: `tags: [microbiology, ai]`",
    "  • related  — array of bare wiki page slugs: `related: [foo, bar-baz]`. Do NOT include",
    "               `wiki/`, `.md`, or `[[…]]` here — slugs only.",
    "               Person names: kebab-case pinyin (e.g. `kleine-moretti`, `zhou-ming-rui`).",
    "               Non-person names (places, objects, concepts, etc.): kebab-case English (e.g. `revolver`, `crimson-moon`, `transmigration`, `hermit-script`).",
    "               NEVER use Chinese characters in slugs.",
    "",
    "Concrete example of a complete, parseable page (everything between the two `---` lines",
    "is the frontmatter; the heading and prose below are the body):",
    "",
    "    ---",
    "    type: " + exampleType,
    "    title: Example " + (mode === "entities" ? "Entity" : "Concept"),
    `    created: ${today}`,
    `    updated: ${today}`,
    "    tags: [example, demo]",
    "  related: [related-slug-1, related-slug-2]",
    "    ---",
    "",
    "    # Example ",
    "",
    "    周明瑞通过转运仪式进入了灰雾世界，与奥黛丽·霍尔和阿杰尔·威尔逊在灰雾中相遇。",
    "",
    "Other rules:",
    "- If you include images, use wiki-root-relative paths such as `media/source-slug/image.png`; never output absolute filesystem paths.",
    "- Preserve subject boundaries: when a source discusses multiple entities/models/products/methods, keep claims, evaluations, limitations, benchmark results, and recommendations attached to the exact subject they describe.",
    "- Do not merge or generalize a claim about one subject into another subject's page solely because they share terms (for example context window size, benchmark name, dataset, architecture, or feature name).",
    "- If a page needs to mention another subject for comparison, write it explicitly as a comparison and cite which source supports that statement.",
    "- Use kebab-case filenames",
    "- Derive filenames from the page title in the mandatory output language, but short proper nouns and technical identifiers take precedence: preserve names such as OpenAI, GPT-5, Transformer, CLIP, ImageNet, PyTorch, CUDA, GitHub, arXiv, React, LanceDB, AnyTXT, MinerU, model names, dataset names, tool names, and code identifiers in their standard original form. Do not put raw URLs, citation strings, or full paper titles directly into file paths; convert surrounding descriptive prose to a safe readable title.",
    "- Follow the analysis recommendations on what to emphasize",
    "- If the analysis found connections to existing pages, add cross-references",
    "",
    "## Review block types",
    "",
    "After all FILE blocks, optionally emit REVIEW blocks for anything that needs human judgment:",
    "",
    "- contradiction: the analysis found conflicts with existing wiki content",
    "- duplicate: an entity/concept might already exist under a different name in the index",
    "- missing-page: an important concept is referenced but has no dedicated page",
    "- suggestion: ideas for further research, related sources to look for, or connections worth exploring",
    "",
    "Only create reviews for things that genuinely need human input. Don't create trivial reviews.",
    "",
    "## OPTIONS allowed values (only these predefined labels):",
    "",
    "- contradiction: OPTIONS: Create Page | Skip",
    "- duplicate: OPTIONS: Create Page | Skip",
    "- missing-page: OPTIONS: Create Page | Skip",
    "- suggestion: OPTIONS: Create Page | Skip",
    "",
    "The user also has a 'Deep Research' button (auto-added by the system) that triggers web search.",
    "Do NOT invent custom option labels. Only use 'Create Page' and 'Skip'.",
    "",
    "For suggestion and missing-page reviews, the SEARCH field must contain 2-3 web search queries",
    "(keyword-rich, specific, suitable for a search engine — NOT titles or sentences). Example:",
    "  SEARCH: automated technical debt detection AI generated code | software quality metrics LLM code generation | static analysis tools agentic software development",
    "",
    purpose ? `## Wiki Purpose (for context)\n${purpose}` : "",
    relatedPages
      ? `${relatedPages}\nCRITICAL: The \`related:\` frontmatter field in every generated page MUST only reference slugs from the ## Related Wiki Pages table above. Do NOT invent or reference slugs that are not listed in that table.\n`
      : "",
    overview ? `## Current Overview (update this to reflect the new source)\n${overview}` : "",
    "",
    // ── OUTPUT FORMAT MUST BE THE LAST SECTION — models weight recent instructions highest ──
    "## Output Format (MUST FOLLOW EXACTLY — this is how the parser reads your response)",
    "",
    "Your ENTIRE response consists of FILE blocks followed by optional REVIEW blocks. Nothing else.",
    "",
    "FILE block template:",
    "```",
    "---FILE: wiki/path/to/page.md---",
    "(complete file content with YAML frontmatter)",
    "---END FILE---",
    "```",
    "",
    "REVIEW block template (optional, after all FILE blocks):",
    "```",
    "---REVIEW: type | Title---",
    "Description of what needs the user's attention.",
    "OPTIONS: Create Page | Skip",
    "PAGES: wiki/page1.md, wiki/page2.md",
    "SEARCH: query 1 | query 2 | query 3",
    "---END REVIEW---",
    "```",
    "",
    "## Output Requirements (STRICT — deviations will cause parse failure)",
    "",
    "1. The FIRST character of your response MUST be `-` (the opening of `---FILE:`).",
    "2. DO NOT output any preamble such as \"Here are the files:\", \"Based on the analysis...\", or any introductory prose.",
    "3. DO NOT echo or restate the analysis — that was stage 1's job. Your job is to emit FILE blocks.",
    "4. DO NOT output markdown tables, bullet lists, or headings outside of FILE/REVIEW blocks.",
    "5. DO NOT output any trailing commentary after the last `---END FILE---` or `---END REVIEW---`.",
    "6. Between blocks, use only blank lines — no prose.",
    "7. FILE block prose (body, explanations, descriptions, section text) must use the mandatory output language specified below. Preserve proper nouns, acronyms, model names, dataset names, tool/library names, code identifiers, URLs, file names, citation strings, paper titles, and technical terms with no widely-used localized equivalent in their standard original form, including in page names and section headings.",
    "",
    "If you start with anything other than `---FILE:`, the entire response will be discarded.",
    "",
    // Repeat the language directive at the very end so it wins the "most
    // recent instruction" tie-breaker. Small-to-medium models otherwise
    // drift back to their training-data language for individual pages.
    "---",
    "",
    languageRule(sourceContent),
  ].filter(Boolean).join("\n")
}

export function buildReviewSuggestionPrompt(
  sourceIdentity: string,
  analysis: string,
  sourceContext: string,
  generation: string,
  maxContextSize: number | undefined,
): string {
  const { maxCtx } = computeContextBudget(maxContextSize)
  const sectionCap = Math.max(4_000, Math.floor(maxCtx * 0.15))
  return [
    "You are identifying high-value follow-up research items for a personal wiki.",
    "Do not output chain-of-thought, hidden reasoning, or explanatory preamble.",
    "",
    languageRule(sourceContext),
    "",
    "Output a list of 2-5 high-value SUGGESTION review items for the user's review queue.",
    "Each review should represent a distinct avenue of research or a specific question the wiki should answer.",
    "",
    "## Context",
    `## Source\n${sourceIdentity}`,
    "",
    "## Stage 1 Analysis",
    trimLongText(analysis, sectionCap),
    "",
    "## Source Context",
    trimLongText(sourceContext, sectionCap),
    "",
    "## Generated Wiki Output",
    trimLongText(generation, sectionCap),
  ].filter(Boolean).join("\n")
}

export function buildAggregateRepairPrompt(
  paths: string[],
  purpose: string,
  index: string,
  overview: string,
  sourceIdentity: string,
  analysis: string,
  sourceContext: string,
  generation: string,
  maxContextSize: number | undefined,
): string {
  const sectionCap = aggregateRepairSectionCap(maxContextSize)
  const today = currentWikiDate()
  return [
    "You are repairing aggregate wiki files after an ingest generation.",
    "Do not output chain-of-thought, hidden reasoning, or explanatory preamble.",
    "",
    languageRule(sourceContext),
    "",
    "Generate ONLY the requested aggregate FILE blocks listed below.",
    "Do not generate entity, concept, source summary, query, comparison, or synthesis pages.",
    "",
    "Requested paths:",
    ...paths.map((path) => `- ${path}`),
    "",
    "Rules:",
    `- Use today's date ${today} for frontmatter dates.`,
    "- For wiki/overview.md: output the complete updated overview, reflecting the full wiki plus this new source.",
    "- Output only FILE blocks. Nothing else.",
    "",
    "FILE block template:",
    "```",
    "---FILE: wiki/path.md---",
    "(for overview.md: complete content)",
    "---END FILE---",
    "```",
    "",
    purpose ? `## Wiki Purpose\n${trimLongText(purpose, Math.floor(sectionCap * 0.5))}` : "",
    index ? `## Current Wiki Index\n${trimLongText(index, sectionCap)}` : "",
    overview ? `## Current Overview\n${trimLongText(overview, sectionCap)}` : "",
    "",
    `## Source\n${sourceIdentity}`,
    "",
    "## Stage 1 Analysis",
    trimLongText(analysis, sectionCap),
    "",
    "## Source Context",
    trimLongText(sourceContext, sectionCap),
    "",
    "## First Generation Output",
    trimLongText(generation, sectionCap),
  ].filter(Boolean).join("\n")
}

/**
 * Step 3 prompt: AI generates aggregate wiki pages (index, overview, log)
 * from all pages that were just written to disk.
 */
export function buildAggregatePrompt(
  writtenPaths: string[],
  pageContents: string[],
  purpose: string,
  index: string,
  overview: string,
  sourceIdentity: string,
  analysis: string,
  maxContextSize: number | undefined,
): string {
  const sectionCap = aggregateRepairSectionCap(maxContextSize)

  const pageSummaries = pageContents.map((content, i) => {
    const path = writtenPaths[i]
    const titleMatch = content.match(/^title:\s*(.+)$/m)
    const tagsMatch = content.match(/^tags:\s*\[(.*)\]$/m)
    const body = content.replace(/^---[\s\S]*?---\n*/, "").slice(0, 300)
    return `- ${path}\n  title: ${titleMatch?.[1] ?? path}\n  tags: [${tagsMatch?.[1] ?? ""}]\n  excerpt: ${body.replace(/\n/g, " ").slice(0, 200)}`
  }).join("\n\n")

  return [
    "You are a wiki maintainer. Generate aggregate wiki pages for a personal wiki.",
    "Do not output chain-of-thought, hidden reasoning, or explanatory preamble.",
    "",
    languageRule(analysis),
    "",
    `## Source File\n${sourceIdentity}`,
    "",
    "## Stage 1 Analysis",
    trimLongText(analysis, sectionCap),
    "",
    "## Pages Generated From This Source",
    pageSummaries,
    "",
    "## What to generate",
    "",
    "1. **wiki/overview.md** — the complete updated overview. A 2-5 paragraph high-level",
    "   summary of ALL topics in the wiki, updated to reflect the new source.",
    "",
    "Generate ONLY overview.md. Do not generate entity, concept, source summary, or index pages.",
    "",
    "FILE block template:",
    "```",
    "---FILE: wiki/overview.md---",
    "(complete content)",
    "---END FILE---",
    "```",
    "",
    purpose ? `## Wiki Purpose\n${trimLongText(purpose, Math.floor(sectionCap * 0.5))}` : "",
    index ? `## Current Wiki Index\n${trimLongText(index, sectionCap)}` : "",
    overview ? `## Current Overview\n${trimLongText(overview, sectionCap)}` : "",
    "",
    "Output ONLY FILE blocks. Start with `---FILE:`.",
    "No preamble. No analysis prose. Start immediately.",
  ].filter(Boolean).join("\n")
}

export function buildPageMergeSystemPrompt(): string {
  return [
    "You are merging two versions of the same wiki page into one coherent document.",
    "Both versions target the same wiki page; one is already on disk,",
    "the other was just generated from a different source document.",
    "Either version may mention additional subjects for comparison or context.",
    "",
    "Output ONE merged version that:",
    "- Preserves every factual claim from both versions (do not drop content)",
    "- Eliminates redundancy when both versions state the same fact",
    "- Preserves subject/source boundaries: if either version mentions other entities/models/products/methods for comparison, keep those comparisons attribution-exact and do not fold them into claims about the main page subject",
    "- When claims conflict or apply to different subjects, keep them separated and say which source version supports each one instead of synthesizing a single generalized conclusion",
    "- When in doubt whether two similar-looking claims describe the same fact, prefer keeping them separate",
    "- Reorganizes sections so the structure is logical for the merged topic,",
    "  not just a concatenation of the two inputs",
    "- Uses consistent markdown structure (headings, tables, lists, callouts)",
    "- Keeps `related:` references intact",
    "",
    "Output requirements:",
    "- The FIRST character of your response MUST be `-` (the opening of `---`)",
    "- Output the COMPLETE file: YAML frontmatter + body",
    "- No preamble (no \"Here is the merged version:\"), no analysis prose",
    "- The caller will overwrite `sources`/`tags`/`related`/`updated` with",
    "  deterministic values — your job is the body and any other fields",
  ].join("\n")
}