export { autoIngest, startIngest, executeIngestWrites } from "./pipeline"
export { IngestError, type IngestErrorCategory } from "./errors"
export {
  parseFileBlocks,
  isSafeIngestPath,
  FILE_BLOCK_REGEX,
  aggregatePathsNeedingRepair,
  filterAggregateRepairOutput,
  requireBlocks,
} from "./file-blocks"
export type { ParsedFileBlock, ParseFileBlocksResult } from "./file-blocks"
export {
  buildAnalysisPrompt,
  buildGenerationPrompt,
  buildAggregatePrompt,
  buildPageMergeSystemPrompt,
  languageRule,
} from "./prompts"
export {
  currentWikiDate,
  stampGeneratedFrontmatterDates,
  computeIngestSourceBudget,
  computeIngestGenerationMaxTokens,
  computeIngestReviewMaxTokens,
  splitSourceIntoSemanticChunks,
  formatIngestWarningLogEntry,
  rewriteIngestPathFromTitleForTargetLanguage,
} from "./utils"
export {
  sourceSummaryMediaRefsForExternalMarkdown,
  hasMineruImageRefs,
} from "./images"