export type IngestErrorCategory =
  | "network"      // 网络连接失败（DNS/TLS/超时/HTTP 4xx+5xx/429）
  | "llm_output"   // LLM 返回空或无效输出
  | "format_error" // LLM 输出格式不符合要求（FILE block 缺失或数量不足）
  | "input"        // 用户输入的源文本有误
  | "system"       // 系统级错误（磁盘IO/配置/项目状态）
  | "unknown"      // 无法归类的意外异常
  | "cancelled"    // 用户取消任务

export class IngestError extends Error {
  readonly category: IngestErrorCategory
  readonly cause?: Error
  constructor(category: IngestErrorCategory, message: string, cause?: unknown) {
    super(message)
    this.category = category
    this.name = "IngestError"
    if (cause instanceof Error) this.cause = cause
  }
}

/**
 * LLM API error with an optional HTTP status.
 * Thrown by the LLM client when an API request fails with a status code,
 * allowing ingest to classify the failure (e.g. rate-limit/network) without
 * inspecting raw error messages.
 */
export class LlmApiError extends Error {
  readonly httpStatus?: number

  constructor(message: string, httpStatus?: number) {
    super(message)
    this.name = "LlmApiError"
    this.httpStatus = httpStatus
  }
}