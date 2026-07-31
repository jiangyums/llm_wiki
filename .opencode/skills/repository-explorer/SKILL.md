---
name: repository-explorer
description: Analyze how features work by tracing code flow through evidence-based exploration
---
# repository-explorer

## Metadata
- Name: repository-explorer
- Type: analysis skill
- Mode: local-llm optimized (Qwen / DeepSeek / Gemma)
- Requires: codebase-index (optional but recommended)

---

## Purpose

Understand how a feature or subsystem works inside a codebase by building a structured, evidence-based map of:

- Entry points
- Core logic flow
- Key modules
- Data flow
- External dependencies

This Skill does NOT summarize the entire repository.
It focuses on ONE user intent at a time.

---

## When to Use

Use this Skill when the user asks:

- “How does X work?”
- “Explain login / auth / payment / sync flow”
- “Where is X implemented?”
- “Trace this feature”
- “How does this module interact with others?”

---

## When NOT to Use

Do NOT use this Skill when:

- The request is about code quality (use `code-review`)
- The request is about security (use `security-review`)
- The request is about refactoring
- The request is generic without a target (ask clarification first)

---

## Input Format

User intent must be reduced to:

- Feature name OR
- Behavior OR
- Module

Example:
- login flow
- payment process
- user authentication
- file upload pipeline

---

## Workflow (IMPORTANT)

Follow strictly in order:

### 1. Intent Extraction
Convert user request into a single goal.

Example:
"How does login work?"
→ Goal: Understand Authentication Flow

---

### 2. Search Phase (DO NOT READ CODE YET)

Use index/search first:

Search for:
- controllers
- services
- routes
- handlers
- entry files

Return candidates only.

---

### 3. Prioritization

Select top relevant components:

Priority order:
1. Entry points (routes / controllers)
2. Core service logic
3. Data access layer
4. External integrations

---

### 4. Evidence Collection

For each component, collect:

- file path
- function name
- symbol (if available)
- call relationship

DO NOT infer without evidence.

---

### 5. Code Reading (Targeted Only)

Only read selected files.

Avoid reading entire folders.

---

### 6. Flow Construction

Build a step-by-step execution path:

Example:

Request → Controller → Service → Repository → DB

---

### 7. Verification Phase

Check:

- Are there alternative entry points?
- Are background jobs involved?
- Are async/event systems involved?
- Are external APIs involved?

If uncertain → mark as UNKNOWN.

---

### 8. Output Generation

Produce structured report.

---

## Output Format

### Summary
Short explanation of feature.

---

### Entry Points
- file path + function

---

### Execution Flow
Step-by-step flow

---

### Key Components
- Controller
- Service
- Repository
- External systems

---

### Evidence Graph
Show relationships:

A → B → C → D

---

### Unknowns
List missing or uncertain parts explicitly.

---

### Confidence
0–100%

---

## Rules

- NEVER guess without evidence
- ALWAYS prefer index search first
- NEVER load whole repository
- ALWAYS output unknowns
- ALWAYS include file paths when possible

---

## Optimization for Local LLM

- Keep steps short
- Avoid long reasoning chains in one pass
- Prefer incremental discovery
- Use structured outputs instead of explanations