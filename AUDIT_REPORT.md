# LLM Wiki 全系统审计报告

**版本:** v0.5.4  
**日期:** 2026-07-02  
**分析方式:** system-analyzer + repository-explorer + 安全审计

---

## 系统概览

LLM Wiki 是一个桌面个人知识库应用，使用 LLM 实现文档的摄入、分析、关联、审查和搜索。

**技术栈:** Tauri v2 (Rust + WebView) / React 19 / TypeScript / Zustand / LanceDB / sigma.js

---

## 目录

1. [结构分析](#1-结构分析)
2. [功能流程](#2-功能流程)
3. [安全分析](#3-安全分析)
4. [代码质量](#4-代码质量)
5. [性能分析](#5-性能分析)
6. [跨域洞察](#6-跨域洞察)
7. [风险评估](#7-风险评估)
8. [未知项](#8-未知项)

---

## 1. 结构分析

### 1.1 目录布局

```
llm_wiki/
├── src/               # React/TypeScript 前端
│   ├── components/    # UI 组件（chat/editor/graph/layout/lint/settings/sources...）
│   ├── lib/           # 核心业务逻辑（~130 模块）
│   ├── stores/        # Zustand 状态管理（9 个 store）
│   ├── commands/      # Tauri IPC 桥接
│   └── types/         # TypeScript 类型定义
├── src-tauri/         # Rust 后端
│   ├── src/commands/  # 20 个 Tauri 命令（fs/search/vectorstore/project/...）
│   ├── src/api_server.rs    # REST API（:19828）
│   ├── src/clip_server.rs   # 剪藏服务（:19827）
│   └── src/proxy.rs         # 全局代理配置
├── mcp-server/        # MCP 服务器（Node.js stdio）
├── extension/         # Chrome 扩展（Web Clipper）
├── assets/            # 截图/架构图
├── docs/              # 文档
├── tests/             # 端到端测试夹具
└── .github/           # CI/CD
```

### 1.2 三层架构

```
[Chrome 扩展]                  [MCP 客户端]
      │                              │
      │ HTTP POST /clip              │ stdio MCP
      ▼                              ▼
┌─────────────────┐    ┌──────────────────────┐
│ Clip 服务器      │    │ MCP 服务器           │
│ (Rust, :19827)   │    │ (Node.js, stdio)     │
│ - 接收剪藏        │    │ - 8 个工具           │
│ - 写入 .md       │    │ - HTTP 客户端到 API  │
└────────┬─────────┘    └─────────┬────────────┘
         │                        │ HTTP /api/v1
         ▼                        ▼
┌──────────────────────────────────────┐
│ API 服务器 (Rust, :19828)             │
│ /health, /projects/*, /search, /graph│
│ Bearer Token / X-LLM-Wiki-Token 鉴权 │
└────────┬─────────────────────────────┘
         │ 读取项目目录/文件
         ▼
┌──────────────────────────────────────┐
│ Rust 命令层 (Tauri IPC)              │
│ fs.rs  /  search.rs  /  vectorstore  │
│ project.rs  /  extract_images.rs     │
│ claude_cli.rs  /  codex_cli.rs       │
│ file_sync.rs                         │
└────────────────┬─────────────────────┘
         │ invoke()
         ▼
┌──────────────────────────────────────┐
│ WebView (React/TypeScript)           │
│ App.tsx → AppLayout → 3 面板布局     │
│ lib/ ~130 模块（LLM/ingest/chat/...）│
│ Stores: wiki/chat/review/lint/...   │
└──────────────────────────────────────┘
```

### 1.3 通信模式

| 方式 | 用途 |
|------|------|
| **Tauri IPC** (`invoke()`) | 前端 → Rust 命令（FS、搜索、向量存储） |
| **本地 HTTP** | Clip 服务器（:19827）、API 服务器（:19828） |
| **MCP stdio** | Node.js 进程 → HTTP → Rust API |
| **子进程 stdin/stdout** | Claude Code / Codex CLI |
| **Tauri 事件** | 文件变更推送 |

### 1.4 关键配置类型

| 配置 | 存储位置 | 内容 |
|------|----------|------|
| `llmConfig` | `app-state.json` | LLM 提供商、API Key、模型 |
| `apiConfig` | `app-state.json` | API 服务器 Token、LAN 访问 |
| `embeddingConfig` | `app-state.json` | Embedding 端点 |
| Review/Lint/Chat | `.llm-wiki/*.json` | 项目级持久化 |
| 向量存储 | `.llm-wiki/lancedb/` | LanceDB 表 |

---

## 2. 功能流程

### 2.1 认证/登录流程

```
外部 HTTP 请求
      │
process_request() 解析 headers + body    [api_server.rs:154]
      │
handle_request() 开始鉴权                 [api_server.rs:199]
      │
├── /health → 直接返回（免鉴权）             [api_server.rs:222]
│     返回 authRequired / authConfigured 等状态
│
├── 非 API 路径 → 404                    [api_server.rs:235]
├── api_enabled? → 否 → 503              [api_server.rs:238]
│
└── is_authorized() 鉴权                  [api_server.rs:246]
      │
      ├── api_auth_required = !api_allow_unauthenticated
      ├── api_token → env var || app-state.json
      ├── query param `?token=xxx`
      ├── header `X-LLM-Wiki-Token`
      └── header `Authorization: Bearer xxx`
```

Token 来源优先级: `LLM_WIKI_API_TOKEN` 环境变量 > `apiConfig.token`（持久化配置）

### 2.2 文件摄入流程

```
用户导入文件（Sources 视图）
      │
importSourceFiles() 复制到 raw/sources/  [source-lifecycle.ts:159]
      │
enqueueSourceIngest()                     [source-lifecycle.ts:136]
      │ 检查 LLM 是否可用
      │
enqueueBatch() → upsertQueuedIngestTask() [ingest-queue.ts:229]
      │ 添加到内存队列 + 持久化到磁盘
      │
processNext()                             [ingest-queue.ts:634]
      │ 串行处理（processing 锁）
      │
autoIngest()                              [ingest.ts]
      │ 1. Step1: 分析
      │ 2. Step2a: 生成实体/概念页
      │ 3. Step2b: 源摘要
      │ 4. Step3: 聚合生成
      │
writeFileBlocks() 写入 wiki/ 目录
      │
embedPage() 写入向量存储
```

---

## 3. 安全分析

### 3.1 高风险项

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| H1 | **Clip 服务器无认证** | `clip_server.rs:95-275` | :19827 端口完全开放，LAN 上任何人可注入内容 |
| H2 | **LLM API Key 明文存储** | `project-store.ts:48-100` | OpenAI/Anthropic 等 Key 明文存 `app-state.json` |
| H3 | **delete_file 无目录限制** | `fs.rs:1244-1263` | Tauri 调用可删除任意文件 |
| H4 | **write_file 无目录限制** | `fs.rs:971-1016` | Tauri 调用可写入任意文件 |
| H5 | **CSP 过于宽松** | `tauri.conf.json:25` | `connect-src https: http:` 允许外联任意服务器 |

### 3.2 中风险项

| # | 问题 | 位置 |
|---|------|------|
| M1 | API Token 可用 query string 传递 | `api_server.rs:396-403` |
| M2 | Prompt injection 通过源文件内容 | `ingest.ts:984`, `chat-agent.ts:639-641` |
| M3 | Chat 路由 Prompt injection | `chat-agent.ts:613-641` |
| M4 | Web 搜索结果未转义进入 system prompt | `chat-agent.ts:1432-1471` |
| M5 | Asset 协议范围 `["**"]` 无限制 | `tauri.conf.json:26-29` |
| M6 | 代理密码明文存储 | `proxy.rs:23-31` |
| M7 | Mermaid SVG 通过 dangerouslySetInnerHTML 渲染 | `mermaid-diagram.tsx:127,178` |

### 3.3 已良好防护

| 防护 | 位置 | 说明 |
|------|------|------|
| ✅ `safe_join` 路径穿越防护 | `api_server.rs:784-824` | canonicalize + starts_with 双重校验 |
| ✅ `isSafeIngestPath` LLM 输出校验 | `ingest.ts:391-426` | 禁止 `..` / 绝对路径 / 控制字符 |
| ✅ CORS 严格限定 | `cors.rs:11-23` | 仅 chrome-extension / localhost / tauri |
| ✅ 恒时 Token 比较 | `api_server.rs:511-520` | XOR + 全长度比较 |
| ✅ 请求体 1MB 限制 | `api_server.rs:313-323` | 防 OOM |
| ✅ 速率限制 120 req/s | `api_server.rs:296-311` | 基础 DoS 防护 |
| ✅ Bind 主机名净化 | `server_bind.rs:41-54` | 仅允许字母数字 + `.-_:[]` |
| ✅ 代理密码日志脱敏 | `proxy.rs:126-147` | `***` 替换凭证 |
| ✅ CLI 子进程命令硬编码 | `claude_cli.rs` / `codex_cli.rs` | 无用户参数注入 |

---

## 4. 代码质量

### 4.1 优点

- 全 TypeScript + 严格类型
- 单元测试覆盖率高（1572 测试 / 105 文件）
- Zustand store 职责分离清晰（9 个独立 store）
- Rust 错误处理规范（`Result<T, E>` + `catch_unwind`）
- 路径处理统一经 `normalizePath()` 标准化

### 4.2 问题

| 文件 | 行数 | 问题 |
|------|------|------|
| `ingest.ts` | ~3800 | 职责过重（解析/校验/LLM调用/文件写入混合） |
| `chat-agent.ts` | ~1500 | 逻辑与提示词模板混合，测试维护成本高 |
| `fs.rs` (Rust) | ~2260 | 巨量函数职责分散 |
| `api_server.rs` | ~2520 | 路由/鉴权/文件服务/搜索混合 |

### 4.3 测试覆盖

- 105 个测试文件，1572 个测试用例
- 使用 vitest + fast-check（属性测试）
- 包含真实 LLM 集成测试（`*.real-llm.test.ts`）
- 主要缺口: UI 组件测试（仅 `app-layout-visibility`、`file-tree-utils` 有测试）

---

## 5. 性能分析

### 5.1 潜在瓶颈

| 区域 | 问题 |
|------|------|
| **ForceAtlas2 布局** | 主线程阻塞风险（已通过 Web Worker 缓解） |
| **批量摄入串行处理** | `processing` 锁导致 ML 调用期间队列阻塞 |
| **LanceDB 操作** | 每次独立打开/关闭表，无连接池 |
| **ActivityPanel 轮询** | 每 1 秒 `getQueue()` 轮询，简单但浪费 |
| **MinerU PDF 解析** | 外部 HTTP 调用无超时配置 |

### 5.2 已优化

- ✅ ForceAtlas2 在 Web Worker 中运行
- ✅ 文件变更批处理 250ms 防抖
- ✅ LLM 流式输出（SSE / line streaming）
- ✅ 摄入缓存 `ingest-cache.ts` 避免重复处理
- ✅ React.lazy + Suspense 代码分割

---

## 6. 跨域洞察

| 关联 | 发现 |
|------|------|
| **安全 × 结构** | Clip 服务器无认证 + LAN 访问启用 = LAN 上任何人可注入内容 |
| **安全 × 性能** | API Key 明文存储 + CSP 过于宽松 = XSS 可外泄所有密钥 |
| **质量 × 安全** | `ingest.ts` 3800 行 + LLM 输入未净化 = 高风险维护面 |

---

## 7. 风险评估

| 维度 | 等级 | 关键原因 |
|------|------|----------|
| **安全** | **高风险** | Clip 无认证 + API Key 明文 + 文件操作无目录限制 |
| **稳定性** | **低风险** | 测试覆盖完善，错误处理规范，类型安全 |
| **性能** | **低风险** | 主要瓶颈已通过异步/Worker 缓解 |

---

## 8. 未知项

- MCP 服务器错误传播到宿主应用的完整性
- LanceDB 表损坏后的恢复流程
- `claude` / `codex` CLI 子进程 SIGKILL 后的状态清理
- 大项目（1000+ 文件）下 ForceAtlas2 布局性能
- `app-state.json` 并发写入的竞态条件防护

---

## 附录

### 关键文件索引

| 文件 | 行数 | 用途 |
|------|------|------|
| `src-tauri/src/api_server.rs` | 2520 | REST API 服务器 + 鉴权 |
| `src-tauri/src/clip_server.rs` | 439 | Web 剪藏服务器 |
| `src-tauri/src/commands/fs.rs` | 2260 | 文件系统操作（PDF/Office/文本） |
| `src/lib/ingest.ts` | 3800 | 核心摄入流水线 |
| `src/lib/ingest-queue.ts` | 790 | 摄入队列管理 |
| `src/lib/chat-agent.ts` | 1500 | 智能聊天代理 |
| `src/lib/source-lifecycle.ts` | 548 | 源文件生命周期 |
| `src/lib/project-store.ts` | 404 | 持久化存储 |
| `src/components/layout/activity-panel.tsx` | 528 | 活动面板 UI |
| `src/stores/wiki-store.ts` | 580 | 中央状态管理 |
