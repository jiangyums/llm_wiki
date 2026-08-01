import type { IngestScenario } from "./types"

/**
 * Ingest scenarios drive autoIngest end-to-end through the new multi-stage
 * pipeline. Each scenario provides one raw LLM response per stage, consumed
 * in pipeline order: analysis → entity → concept → summary → aggregate →
 * optional review.
 *
 * FILE block format (what each generation stage emits to write a wiki file):
 *   ---FILE: wiki/path/to/page.md---
 *   (file content, usually with YAML frontmatter)
 *   ---END FILE---
 *
 * REVIEW block format (carried in entity/concept output, or from the
 * dedicated review stage):
 *   ---REVIEW: missing-page | Short title---
 *   Description.
 *   OPTIONS: Approve | Skip
 *   PAGES: page1.md, page2.md
 *   ---END REVIEW---
 *
 * The analysis stage MUST wrap its manifest in a FILE block at
 * `wiki/.manifest` listing entity/concept slugs. The aggregate stage MUST
 * emit `---FILE: wiki/overview.md---`. Both are hard requirements.
 */

const BASIC_PURPOSE = `# Purpose

This wiki tracks deep-learning research concepts.
`

const BASIC_INDEX = `# Index

## Concepts
- [[attention]]
`

const BASIC_SCHEMA = `# Schema

## wiki/sources/
Each ingested source has a summary page here.

## wiki/concepts/
Each concept gets its own page.
`

export const ingestScenarios: IngestScenario[] = [
  // 1. basic-new-source — new concept wiki page + source summary, no reviews
  {
    name: "basic-new-source",
    description:
      "Pipeline generates a concept page + a source summary page. No " +
      "REVIEW blocks. The runner must see both files on disk and zero " +
      "reviews in the store.",
    initialWiki: {
      "purpose.md": BASIC_PURPOSE,
      "schema.md": BASIC_SCHEMA,
      "wiki/index.md": BASIC_INDEX,
    },
    source: {
      path: "raw/sources/rope-paper.md",
      content: [
        "# Rotary Position Embedding",
        "",
        "Rotary Position Embedding (RoPE) encodes positional information by",
        "rotating pairs of dimensions in query and key vectors. It naturally",
        "supports variable-length contexts and is now standard in LLMs.",
      ].join("\n"),
    },
    analysisResponse: [
      "## Key Concepts",
      "- Rotary Position Embedding (RoPE): rotates pairs of dimensions",
      "",
      "## Main Arguments",
      "- RoPE naturally supports variable-length contexts",
      "",
      "---FILE: wiki/.manifest---",
      "**concept**: `rope` - Rotary Position Embedding",
      "---END FILE---",
    ].join("\n"),
    entityResponse: [
      "---FILE: wiki/entities/rope-method.md---",
      "---",
      "title: RoPE Method",
      "---",
      "",
      "# RoPE Method",
      "",
      "Positional-encoding technique introduced in the rope-paper source.",
      "---END FILE---",
    ].join("\n"),
    conceptResponse: [
      "---FILE: wiki/concepts/rope.md---",
      "---",
      "title: Rotary Position Embedding",
      "tags: [positional-encoding]",
      "sources: [rope-paper.md]",
      "---",
      "",
      "# Rotary Position Embedding",
      "",
      "RoPE rotates pairs of dimensions in [[attention]] queries and keys",
      "to encode absolute position while preserving relative-position invariance.",
      "---END FILE---",
    ].join("\n"),
    summaryResponse: [
      "---FILE: wiki/sources/rope-paper.md---",
      "---",
      'title: "Source: rope-paper.md"',
      "sources: [rope-paper.md]",
      "---",
      "",
      "# Source: rope-paper.md",
      "",
      "Paper introducing [[Rotary Position Embedding]].",
      "---END FILE---",
    ].join("\n"),
    aggregateResponse: [
      "---FILE: wiki/overview.md---",
      "---",
      'title: "Overview"',
      "---",
      "",
      "# Overview",
      "",
      "RoPE is the positional-encoding approach covered by this project.",
      "---END FILE---",
    ].join("\n"),
    expected: {
      writtenPaths: [
        "wiki/concepts/rope.md",
        "wiki/sources/rope-paper.md",
      ],
      fileContains: {
        "wiki/concepts/rope.md": [
          "title: Rotary Position Embedding",
          "[[attention]]",
        ],
        "wiki/sources/rope-paper.md": ["rope-paper.md"],
      },
      reviewsCreated: [],
    },
  },

  // 2. generates-review-items — REVIEW blocks in generation become store items
  {
    name: "generates-review-items",
    description:
      "Entity output carries one FILE and two REVIEW blocks (missing-page + " +
      "suggestion). Both reviews must appear in the store after ingest.",
    initialWiki: {
      "purpose.md": BASIC_PURPOSE,
      "schema.md": BASIC_SCHEMA,
      "wiki/index.md": BASIC_INDEX,
    },
    source: {
      path: "raw/sources/flash-attention.md",
      content:
        "# FlashAttention\n\nFlashAttention is an IO-aware exact attention algorithm.\n",
    },
    analysisResponse: [
      "## Key Concepts",
      "- FlashAttention",
      "",
      "---FILE: wiki/.manifest---",
      "**concept**: `flash-attention` - FlashAttention",
      "---END FILE---",
    ].join("\n"),
    entityResponse: [
      "---FILE: wiki/entities/flash-attention-method.md---",
      "---",
      "title: FlashAttention Method",
      "---",
      "",
      "# FlashAttention Method",
      "",
      "IO-aware attention implementation from the flash-attention source.",
      "---END FILE---",
      "",
      "---REVIEW: missing-page | FlashAttention---",
      "The source introduces FlashAttention but no dedicated page exists.",
      "OPTIONS: Create page | Skip",
      "PAGES: wiki/sources/flash-attention.md",
      "---END REVIEW---",
      "",
      "---REVIEW: suggestion | Add IO-aware algorithms survey---",
      "Consider a survey page grouping IO-aware attention variants.",
      "---END REVIEW---",
    ].join("\n"),
    conceptResponse: [
      "---FILE: wiki/concepts/flash-attention.md---",
      "---",
      "title: FlashAttention",
      "---",
      "",
      "# FlashAttention",
      "",
      "An IO-aware exact attention algorithm.",
      "---END FILE---",
    ].join("\n"),
    summaryResponse: [
      "---FILE: wiki/sources/flash-attention.md---",
      "---",
      'title: "Source: flash-attention.md"',
      "sources: [flash-attention.md]",
      "---",
      "",
      "# Source: flash-attention.md",
      "",
      "FlashAttention is mentioned here.",
      "---END FILE---",
    ].join("\n"),
    aggregateResponse: [
      "---FILE: wiki/overview.md---",
      "---",
      'title: "Overview"',
      "---",
      "",
      "# Overview",
      "",
      "FlashAttention improves attention efficiency.",
      "---END FILE---",
    ].join("\n"),
    expected: {
      writtenPaths: ["wiki/sources/flash-attention.md"],
      reviewsCreated: [
        { type: "missing-page", titleContains: "FlashAttention" },
        { type: "suggestion", titleContains: "IO-aware" },
      ],
    },
  },

  // 3. references-existing-wikilinks — generated pages link to existing pages
  {
    name: "references-existing-wikilinks",
    description:
      "The generated wiki page must include [[attention]] — linking back " +
      "to a page that already exists in the wiki. Runner asserts substring.",
    initialWiki: {
      "purpose.md": BASIC_PURPOSE,
      "schema.md": BASIC_SCHEMA,
      "wiki/index.md": BASIC_INDEX,
      "wiki/attention.md":
        "---\ntitle: Attention\n---\n\n# Attention\n\nThe attention mechanism.\n",
    },
    source: {
      path: "raw/sources/multi-head.md",
      content: "# Multi-Head Attention\n\nParallel attention heads.\n",
    },
    analysisResponse: [
      "## Connections to Existing Wiki",
      "- Multi-head attention is a variant of attention — the existing",
      "  [[attention]] page should be linked.",
      "",
      "---FILE: wiki/.manifest---",
      "**concept**: `multi-head-attention` - Multi-Head Attention",
      "---END FILE---",
    ].join("\n"),
    entityResponse: [
      "---FILE: wiki/entities/attention-head.md---",
      "---",
      "title: Attention Head",
      "---",
      "",
      "# Attention Head",
      "",
      "A single parallel attention mechanism.",
      "---END FILE---",
    ].join("\n"),
    conceptResponse: [
      "---FILE: wiki/concepts/multi-head-attention.md---",
      "---",
      "title: Multi-Head Attention",
      "---",
      "",
      "# Multi-Head Attention",
      "",
      "Multi-head [[attention]] runs several attention layers in parallel.",
      "---END FILE---",
    ].join("\n"),
    summaryResponse: [
      "---FILE: wiki/sources/multi-head.md---",
      "---",
      'title: "Source: multi-head.md"',
      "sources: [multi-head.md]",
      "---",
      "",
      "# Source: multi-head.md",
      "",
      "Source for multi-head [[attention]].",
      "---END FILE---",
    ].join("\n"),
    aggregateResponse: [
      "---FILE: wiki/overview.md---",
      "---",
      'title: "Overview"',
      "---",
      "",
      "# Overview",
      "",
      "Multi-head attention extends the attention mechanism.",
      "---END FILE---",
    ].join("\n"),
    expected: {
      writtenPaths: [
        "wiki/concepts/multi-head-attention.md",
        "wiki/sources/multi-head.md",
      ],
      fileContains: {
        "wiki/concepts/multi-head-attention.md": ["[[attention]]"],
      },
    },
  },

  // 4. chinese-source — Chinese content flows through to Chinese wiki pages
  {
    name: "chinese-source",
    description:
      "Chinese-language source document; LLM responses in Chinese. " +
      "UTF-8 round-trip through file write must be clean.",
    initialWiki: {
      "purpose.md": "# 用途\n\n深度学习研究笔记。\n",
      "schema.md": BASIC_SCHEMA,
      "wiki/index.md": "# 索引\n\n- [[注意力机制]]\n",
    },
    source: {
      path: "raw/sources/transformer-survey.md",
      content: "# Transformer 综述\n\nTransformer 是一种基于注意力机制的神经网络架构。\n",
    },
    analysisResponse: [
      "## 核心概念",
      "- Transformer：基于注意力机制的架构",
      "",
      "---FILE: wiki/.manifest---",
      "**concept**: `transformer` - Transformer",
      "---END FILE---",
    ].join("\n"),
    entityResponse: [
      "---FILE: wiki/entities/transformer-architecture.md---",
      "---",
      "title: Transformer Architecture",
      "---",
      "",
      "# Transformer Architecture",
      "",
      "Architecture family introduced in the transformer-survey source.",
      "---END FILE---",
    ].join("\n"),
    conceptResponse: [
      "---FILE: wiki/concepts/transformer.md---",
      "---",
      "title: Transformer",
      "---",
      "",
      "# Transformer",
      "",
      "Transformer 是一种基于 [[注意力机制]] 的神经网络架构。",
      "---END FILE---",
    ].join("\n"),
    summaryResponse: [
      "---FILE: wiki/sources/transformer-survey.md---",
      "---",
      'title: "Source: transformer-survey.md"',
      "sources: [transformer-survey.md]",
      "---",
      "",
      "# Source: transformer-survey.md",
      "",
      "关于 [[Transformer]] 的综述。",
      "---END FILE---",
    ].join("\n"),
    aggregateResponse: [
      "---FILE: wiki/overview.md---",
      "---",
      'title: "Overview"',
      "---",
      "",
      "# Overview",
      "",
      "Transformer 是当前深度学习的基础架构。",
      "---END FILE---",
    ].join("\n"),
    expected: {
      writtenPaths: [
        "wiki/concepts/transformer.md",
        "wiki/sources/transformer-survey.md",
      ],
      fileContains: {
        "wiki/concepts/transformer.md": [
          "title: Transformer",
          "[[注意力机制]]",
        ],
      },
    },
  },
]
