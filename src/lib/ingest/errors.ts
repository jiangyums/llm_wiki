export type IngestErrorCategory =
  | "network"      // 网络连接失败（DNS/TLS/超时/HTTP 4xx+5xx/429）
  | "llm_output"   // LLM 返回空或无效输出
  | "input"        // 用户输入的源文本有误
  | "system"       // 系统级错误（磁盘IO/配置/项目状态）
  | "unknown"      // 无法归类的意外异常
  | "cancelled"    // 用户取消任务

export class IngestError extends Error {
  readonly category: IngestErrorCategory
  constructor(category: IngestErrorCategory, message: string, cause?: unknown) {
    super(message)
    this.category = category
    this.name = "IngestError"
    if (cause instanceof Error) this.cause = cause
  }
}