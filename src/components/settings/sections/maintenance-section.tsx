import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"
import { open, save } from "@tauri-apps/plugin-dialog"
import {
  Wrench,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Trash2,
  RotateCcw,
  Clock,
  Archive,
  ListRestart,
  FileText,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { useWikiStore } from "@/stores/wiki-store"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { runDuplicateDetection, type DedupScanStage } from "@/lib/dedup-runner"
import { addNotDuplicate } from "@/lib/dedup-storage"
import {
  enqueueMerge,
  cancelTask,
  retryTask,
  getQueue,
  getQueueSummary,
  resumeProcessing,
  groupKey,
  type DedupTask,
} from "@/lib/dedup-queue"
import type { DuplicateGroup } from "@/lib/dedup"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { openProject, readFile } from "@/commands/fs"
import { addToRecentProjects } from "@/lib/project-store"
import { normalizePath } from "@/lib/path-utils"

interface GroupUiEntry {
  group: DuplicateGroup
  canonicalPath: string
  /** Becomes true when the user marks the group as "not duplicates"
   *  in this session — the card transitions to skipped state. */
  skipped: boolean
}

/** Match a card to its task in the queue (if any) by page-path set. */
function findTaskForGroup(
  tasks: readonly DedupTask[],
  pages: readonly string[],
): DedupTask | undefined {
  const key = groupKey(pages)
  return tasks.find((t) => groupKey(t.group.pages) === key)
}

/** `wiki/entities/foo.md` → `foo`. */
function basenameFromPath(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/, "")
}

/** `wiki/entities/foo.md` → `entities`. */
function typeFromPath(path: string): string {
  const parts = path.split("/")
  return parts.length >= 2 ? parts[parts.length - 2] : "page"
}

export function MaintenanceSection() {
  const { t } = useTranslation()
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const project = useWikiStore((s) => s.project)

  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [groups, setGroups] = useState<GroupUiEntry[]>([])
  const [scanCompleted, setScanCompleted] = useState(false)
  const [scanProgress, setScanProgress] = useState<DedupScanStage | null>(null)
  // Detail popup state: map of page path → file content. Multiple
  // popups can be open simultaneously for side-by-side comparison.
  const [detailPopups, setDetailPopups] = useState<Map<string, string>>(new Map())
  const [detailLoading, setDetailLoading] = useState<Set<string>>(new Set())
  const [projectToolStatus, setProjectToolStatus] = useState<string | null>(null)
  const [projectToolBusy, setProjectToolBusy] = useState(false)

  const handleRebuildIndex = useCallback(async () => {
    if (!project) return
    setProjectToolBusy(true)
    try {
      const result = await invoke<{ pages: number; groups: number }>("rebuild_wiki_index", { projectPath: project.path })
      await refreshProjectFileTree(project.path, { bumpDataVersion: true })
      setProjectToolStatus(t("settings.sections.maintenance.projectData.rebuilt", { pages: result.pages, groups: result.groups }))
    } catch (error) { setProjectToolStatus(String(error)) } finally { setProjectToolBusy(false) }
  }, [project, t])

  const handleExportProject = useCallback(async () => {
    if (!project) return
    const destination = await save({ defaultPath: `${project.name}.llmwiki.zip`, filters: [{ name: "LLM Wiki project", extensions: ["zip"] }] })
    if (!destination) return
    setProjectToolBusy(true)
    try {
      await invoke("export_project_archive", { projectPath: project.path, destination })
      setProjectToolStatus(t("settings.sections.maintenance.projectData.exported", { path: destination }))
    } catch (error) { setProjectToolStatus(String(error)) } finally { setProjectToolBusy(false) }
  }, [project, t])

  const handleImportProject = useCallback(async () => {
    const archive = await open({ multiple: false, filters: [{ name: "LLM Wiki project", extensions: ["zip"] }] })
    if (!archive || Array.isArray(archive)) return
    const destination = await open({ directory: true, multiple: false, createDirectories: true })
    if (!destination || Array.isArray(destination)) return
    setProjectToolBusy(true)
    try {
      const path = await invoke<string>("import_project_archive", { archivePath: archive, destination })
      const imported = await openProject(path)
      await addToRecentProjects(imported)
      setProjectToolStatus(t("settings.sections.maintenance.projectData.imported", { name: imported.name }))
    } catch (error) { setProjectToolStatus(String(error)) } finally { setProjectToolBusy(false) }
  }, [t])

  // Poll the queue at 1Hz so the UI reflects pending → processing →
  // failed transitions and cross-window queue activity (e.g. a merge
  // that completed while the user was on a different settings tab).
  // Same pattern activity-panel uses for ingest-queue.
  const [tasks, setTasks] = useState<readonly DedupTask[]>([])
  const [queueSummary, setQueueSummary] = useState(() => getQueueSummary())
  useEffect(() => {
    setTasks([...getQueue()])
    setQueueSummary(getQueueSummary())
    const id = setInterval(() => {
      setTasks([...getQueue()])
      setQueueSummary(getQueueSummary())
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const llmReady = hasUsableLlm(llmConfig)
  const projectReady = !!project

  const handleScan = useCallback(async () => {
    if (!project) return
    setScanning(true)
    setScanError(null)
    setGroups([])
    setScanCompleted(false)
    setScanProgress(null)
    try {
      const detected = await runDuplicateDetection(project.path, llmConfig, {
        onProgress: (p) => setScanProgress(p),
      })
      setGroups(
        detected.map((g) => ({
          group: g,
          canonicalPath: g.pages[0],
          skipped: false,
        })),
      )
      setScanCompleted(true)
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanning(false)
      setScanProgress(null)
    }
  }, [project, llmConfig])

  const handleCanonicalChange = useCallback(
    (idx: number, path: string) => {
      setGroups((prev) =>
        prev.map((g, i) => (i === idx ? { ...g, canonicalPath: path } : g)),
      )
    },
    [],
  )

  const handleEnqueue = useCallback(
    async (entry: GroupUiEntry) => {
      if (!project) return
      try {
        await enqueueMerge(project.id, entry.group, entry.canonicalPath)
        // Refresh immediately so the card flips to "queued" without
        // waiting for the next 1s poll tick.
        setTasks([...getQueue()])
        setQueueSummary(getQueueSummary())
      } catch (err) {
        console.error("[Maintenance] enqueue failed:", err)
      }
    },
    [project],
  )

  const handleCancel = useCallback(async (taskId: string) => {
    // Remember this group so the "task left the queue" transition below
    // treats it as cancelled (card returns to idle) rather than as a
    // completed merge (card disappears).
    const task = getQueue().find((t) => t.id === taskId)
    if (task) cancelledKeysRef.current.add(groupKey(task.group.pages))
    await cancelTask(taskId)
    setTasks([...getQueue()])
    setQueueSummary(getQueueSummary())
  }, [])

  const handleRetry = useCallback(async (taskId: string) => {
    await retryTask(taskId)
    setTasks([...getQueue()])
    setQueueSummary(getQueueSummary())
  }, [])

  const handleResumeRestoredQueue = useCallback(() => {
    resumeProcessing()
    setTasks([...getQueue()])
    setQueueSummary(getQueueSummary())
  }, [])

  const handleNotDuplicate = useCallback(
    async (idx: number) => {
      if (!project) return
      const entry = groups[idx]
      if (!entry) return
      try {
        await addNotDuplicate(project.path, entry.group.pages)
        setGroups((prev) =>
          prev.map((g, i) => (i === idx ? { ...g, skipped: true } : g)),
        )
      } catch (err) {
        console.error("[Maintenance] addNotDuplicate failed:", err)
      }
    },
    [project, groups],
  )

  const handleShowDetail = useCallback(async (path: string) => {
    if (!project) return
    if (detailPopups.has(path)) return // already open
    setDetailLoading((prev) => new Set(prev).add(path))
    try {
      const pp = normalizePath(project.path)
      const content = await readFile(`${pp}/${path}`)
      setDetailPopups((prev) => new Map(prev).set(path, content))
    } catch (err) {
      setDetailPopups((prev) => new Map(prev).set(path, `[Error loading page: ${err}]`))
    } finally {
      setDetailLoading((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    }
  }, [project, detailPopups])

  const handleCloseDetail = useCallback((path: string) => {
    setDetailPopups((prev) => {
      const next = new Map(prev)
      next.delete(path)
      return next
    })
  }, [])

  const handleRemoveFromGroup = useCallback((idx: number, pathToRemove: string) => {
    setGroups((prev) => {
      const entry = { ...prev[idx] }
      const group = { ...entry.group }
      group.pages = group.pages.filter((p) => p !== pathToRemove)
      if (group.pages.length < 2) {
        // Group becomes invalid — remove it entirely
        return prev.filter((_, i) => i !== idx)
      }
      entry.group = group
      if (entry.canonicalPath === pathToRemove) {
        entry.canonicalPath = group.pages[0]
      }
      const updated = [...prev]
      updated[idx] = entry
      return updated
    })
  }, [])

  // Drive each card's status from the queue.
  // - Card not in queue + not skipped → idle, can merge / dismiss
  // - Task pending → "Queued (N ahead)"
  // - Task processing → "Merging…"
  // - Task gone after being observed in-flight → the merge finished:
  //     drop the card from the list so merged pages stop appearing
  //     as candidates. (The queue removes done tasks immediately, so
  //     "success" is inferred from observing the task then seeing it
  //     vanish. A user-initiated cancel is tracked separately so it
  //     returns the card to idle instead.)
  // - Task failed → show error + retry / delete.
  const [recentlyMergedKeys, setRecentlyMergedKeys] = useState<Set<string>>(
    () => new Set(),
  )
  const lastSeenTaskKeysRef = useRefInit<Set<string>>(() => new Set())
  const cancelledKeysRef = useRefInit<Set<string>>(() => new Set())

  useEffect(() => {
    // Detect transitions out of the queue: a page-set we saw last
    // tick is now gone → either the merge completed or the task was
    // cancelled. Completed merges remove the card from the list;
    // cancelled ones keep it so the user can merge again later.
    const currentKeys = new Set(tasks.map((t) => groupKey(t.group.pages)))
    const completedKeys = new Set<string>()
    for (const g of groups) {
      const k = groupKey(g.group.pages)
      if (lastSeenTaskKeysRef.current.has(k) && !currentKeys.has(k)) {
        completedKeys.add(k)
      }
    }
    lastSeenTaskKeysRef.current = currentKeys
    if (completedKeys.size === 0) return

    let changed = false
    setRecentlyMergedKeys((prev) => {
      const next = new Set(prev)
      for (const k of completedKeys) {
        if (cancelledKeysRef.current.has(k)) continue
        if (!next.has(k)) {
          next.add(k)
          changed = true
        }
      }
      return changed ? next : prev
    })
    setGroups((prev) =>
      prev.filter((g) => {
        const k = groupKey(g.group.pages)
        if (cancelledKeysRef.current.has(k)) return true
        return !completedKeys.has(k)
      }),
    )
    // We intentionally only re-run when tasks change — the closure
    // over `groups` is fine because newly-scanned groups can't be
    // "recently merged" until they've been observed in-flight first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks])

  // Pending position helper: "queued (N ahead)" — count pending tasks
  // before this one in arrival order.
  const pendingPositionByTaskId = useMemo(() => {
    const positions = new Map<string, number>()
    let position = 0
    for (const t of tasks) {
      if (t.status === "pending") {
        positions.set(t.id, position)
        position++
      }
    }
    return positions
  }, [tasks])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.maintenance.title", { defaultValue: "Maintenance" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.maintenance.description", {
            defaultValue:
              "Tools for cleaning up the wiki — detect and merge duplicate entities/concepts that the LLM created under different names across re-ingests.",
          })}
        </p>
      </div>

      <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
        <div className="flex items-center gap-2"><ListRestart className="h-4 w-4 text-muted-foreground" /><h3 className="text-sm font-semibold">{t("settings.sections.maintenance.projectData.title")}</h3></div>
        <p className="text-xs text-muted-foreground">{t("settings.sections.maintenance.projectData.description")}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void handleRebuildIndex()} disabled={!project || projectToolBusy}>{t("settings.sections.maintenance.projectData.rebuild")}</Button>
          <Button variant="outline" onClick={() => void handleExportProject()} disabled={!project || projectToolBusy}><Archive className="h-4 w-4" />{t("settings.sections.maintenance.projectData.export")}</Button>
          <Button variant="outline" onClick={() => void handleImportProject()} disabled={projectToolBusy}>{t("settings.sections.maintenance.projectData.import")}</Button>
        </div>
        {projectToolStatus && <p className="text-xs text-muted-foreground">{projectToolStatus}</p>}
      </div>

      <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">
            {t("settings.sections.maintenance.dedup.title", {
              defaultValue: "Detect duplicate entities / concepts",
            })}
          </h3>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("settings.sections.maintenance.dedup.description", {
            defaultValue:
              "Asks the LLM to scan all entity / concept pages and group ones that likely refer to the same topic under different names (English vs Chinese, plural vs singular, abbreviation vs full form). You confirm each group before merging. Merges are queued and run one at a time so cross-references stay consistent.",
          })}
        </p>

        {!projectReady && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t("settings.sections.maintenance.noProject", {
              defaultValue: "Open a project first.",
            })}
          </p>
        )}
        {projectReady && !llmReady && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t("settings.sections.maintenance.noLlm", {
              defaultValue: "Configure an LLM provider first.",
            })}
          </p>
        )}

        <Button
          onClick={() => void handleScan()}
          disabled={scanning || !projectReady || !llmReady}
        >
          {scanning ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("settings.sections.maintenance.dedup.scanning", {
                defaultValue: "Scanning…",
              })}
            </>
          ) : (
            t("settings.sections.maintenance.dedup.scanButton", {
              defaultValue: "Scan for duplicates",
            })
          )}
        </Button>

        {scanning && scanProgress && (
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {scanProgress.stage === "reading" &&
                t("settings.sections.maintenance.dedup.scanProgress.reading", {
                  defaultValue: "Reading pages {{n}}/{{total}}",
                  n: scanProgress.index,
                  total: scanProgress.total,
                })}
              {scanProgress.stage === "loading" &&
                t("settings.sections.maintenance.dedup.scanProgress.loading", {
                  defaultValue: "Loading vectors {{n}}/{{total}}",
                  n: scanProgress.index,
                  total: scanProgress.total,
                })}
              {scanProgress.stage === "embedding" &&
                t("settings.sections.maintenance.dedup.scanProgress.embedding", {
                  defaultValue: "Generating embeddings {{n}}/{{total}}",
                  n: scanProgress.index,
                  total: scanProgress.total,
                })}
              {scanProgress.stage === "detecting" &&
                t("settings.sections.maintenance.dedup.scanProgress.detecting", {
                  defaultValue: "Detecting groups {{n}}/{{total}}",
                  n: scanProgress.index,
                  total: scanProgress.total,
                })}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{
                  width: `${Math.round((scanProgress.index / scanProgress.total) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}

        {scanError && (
          <div className="flex items-start gap-1.5 rounded border border-rose-500/40 bg-rose-500/5 px-2 py-1.5 text-xs text-rose-700 dark:text-rose-400">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>{scanError}</div>
          </div>
        )}

        {scanCompleted && groups.length === 0 && !scanError && (
          <div className="flex items-start gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/5 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              {t("settings.sections.maintenance.dedup.noneFound", {
                defaultValue: "No duplicate groups found. The wiki is clean.",
              })}
            </div>
          </div>
        )}
      </div>

      <QueueOrphanList
        tasks={tasks}
        groups={groups}
        restoredBacklogWaiting={queueSummary.restoredBacklogWaiting}
        onResumeRestored={handleResumeRestoredQueue}
        onCancel={(id) => void handleCancel(id)}
        onRetry={(id) => void handleRetry(id)}
        pendingPositionByTaskId={pendingPositionByTaskId}
      />

      {/* Detail popups — one per open page, allow multiple for comparison */}
      {project && [...detailPopups.keys()].map((path) => (
        <PageDetailPopup
          key={path}
          path={path}
          content={detailPopups.get(path) ?? ""}
          loading={detailLoading.has(path)}
          onClose={() => handleCloseDetail(path)}
        />
      ))}

      {groups.map((entry, idx) => {
        const mergedKey = groupKey(entry.group.pages)
        // A merge that already completed (observed in a previous tick,
        // or the card was already marked Merged before this session's
        // fix) should no longer be listed as a candidate. The queue
        // removed the done task, so the merged pages won't be detected
        // again on a re-scan anyway.
        if (recentlyMergedKeys.has(mergedKey)) return null
        const task = findTaskForGroup(tasks, entry.group.pages)
        return (
          <DuplicateGroupCard
            key={entry.group.pages.join(",")}
            entry={entry}
            task={task}
            pendingPosition={
              task && task.status === "pending"
                ? pendingPositionByTaskId.get(task.id) ?? 0
                : 0
            }
            onCanonicalChange={(path) => handleCanonicalChange(idx, path)}
            onEnqueue={() => void handleEnqueue(entry)}
            onCancel={() => task && void handleCancel(task.id)}
            onRetry={() => task && void handleRetry(task.id)}
            onNotDuplicate={() => void handleNotDuplicate(idx)}
            onShowDetail={(path) => void handleShowDetail(path)}
            onRemoveFromGroup={(path) => void handleRemoveFromGroup(idx, path)}
          />
        )
      })}
    </div>
  )
}

// ── Page detail popup ──────────────────────────────────────────────────────

interface PageDetailPopupProps {
  path: string
  content: string
  loading: boolean
  onClose: () => void
}

function PageDetailPopup({ path, content, loading, onClose }: PageDetailPopupProps) {
  const { t } = useTranslation()
  return (
    <div className="fixed bottom-4 right-4 z-50 w-[42rem] max-h-[80vh] overflow-auto rounded-xl border bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 shadow-lg">
      <div className="flex items-center justify-between gap-2 mb-3">
        <code className="truncate font-mono text-xs">{path}</code>
        <button
          onClick={onClose}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="max-h-[65vh] overflow-auto">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("settings.sections.maintenance.dedup.loadingPage", {
              defaultValue: "Loading page…",
            })}
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-all rounded bg-muted/30 p-3 font-mono text-[11px] leading-relaxed text-foreground">
            {content}
          </pre>
        )}
      </div>
    </div>
  )
}

// --- helpers ---------------------------------------------------------------

/** A useRef variant that initializes lazily — avoids constructing a new
 *  Set on every render. Kept inline since it's only used here. */
function useRefInit<T>(init: () => T): { current: T } {
  // `useState` returning a ref-shaped object lets us mutate `.current`
  // without triggering re-renders, which is exactly the ref semantics
  // we want for the "last seen task keys" tracking above.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [ref] = useState<{ current: T }>(() => ({ current: init() }))
  return ref
}

interface QueueOrphanListProps {
  tasks: readonly DedupTask[]
  groups: GroupUiEntry[]
  restoredBacklogWaiting: boolean
  onResumeRestored: () => void
  onCancel: (taskId: string) => void
  onRetry: (taskId: string) => void
  pendingPositionByTaskId: Map<string, number>
}

/**
 * Render queued tasks that don't have a matching card on screen. This
 * happens after the user closes the Maintenance pane and re-opens it,
 * or after an app restart with pending tasks: those tasks are real
 * but the user hasn't re-scanned, so without this list they'd be
 * invisible.
 */
function QueueOrphanList({
  tasks,
  groups,
  restoredBacklogWaiting,
  onResumeRestored,
  onCancel,
  onRetry,
  pendingPositionByTaskId,
}: QueueOrphanListProps) {
  const { t } = useTranslation()
  const groupKeys = new Set(groups.map((g) => groupKey(g.group.pages)))
  const orphans = tasks.filter((t) => !groupKeys.has(groupKey(t.group.pages)))

  if (orphans.length === 0) return null

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-muted/10 p-4">
      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">
          {t("settings.sections.maintenance.dedup.queueTitle", {
            defaultValue: "In-progress merges",
          })}
        </h3>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("settings.sections.maintenance.dedup.queueDescription", {
          defaultValue:
            "Tasks queued from a previous scan that haven't finished yet. Merges run one at a time.",
        })}
      </p>
      {restoredBacklogWaiting && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
          <span className="text-amber-800 dark:text-amber-300">
            {t("settings.sections.maintenance.dedup.restoredBacklog", {
              defaultValue:
                "These merge tasks were restored from the previous session and are paused to avoid unexpected LLM usage.",
            })}
          </span>
          <Button size="sm" variant="secondary" onClick={onResumeRestored}>
            <RotateCcw className="h-3.5 w-3.5" />
            {t("settings.sections.maintenance.dedup.resumeRestored", {
              defaultValue: "Resume merges",
            })}
          </Button>
        </div>
      )}
      {orphans.map((task) => (
        <div
          key={task.id}
          className="flex flex-wrap items-center gap-2 rounded border border-border/40 bg-background px-3 py-2 text-xs"
        >
          <code className="font-mono">{task.group.pages.join(" + ")}</code>
          <span className="text-muted-foreground">
            →{" "}
            <code className="font-mono">{task.canonicalPath}</code>
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            <TaskStatusChip
              task={task}
              pendingPosition={pendingPositionByTaskId.get(task.id) ?? 0}
            />
            {task.status === "failed" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onRetry(task.id)}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("settings.sections.maintenance.dedup.retry", {
                  defaultValue: "Retry",
                })}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => onCancel(task.id)}>
              <Trash2 className="h-3.5 w-3.5" />
              {t("settings.sections.maintenance.dedup.delete", {
                defaultValue: "Delete",
              })}
            </Button>
          </span>
          {task.error && task.status === "failed" && (
            <div className="basis-full rounded border border-rose-500/40 bg-rose-500/5 px-2 py-1 text-rose-700 dark:text-rose-400">
              {task.error}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

interface ChipProps {
  task: DedupTask
  pendingPosition: number
}

function TaskStatusChip({ task, pendingPosition }: ChipProps) {
  const { t } = useTranslation()
  if (task.status === "processing") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-700 dark:text-amber-400">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t("settings.sections.maintenance.dedup.merging", {
          defaultValue: "Merging…",
        })}
      </span>
    )
  }
  if (task.status === "pending") {
    if (pendingPosition === 0) {
      return (
        <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
          {t("settings.sections.maintenance.dedup.queued", {
            defaultValue: "Queued",
          })}
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
        {t("settings.sections.maintenance.dedup.queuedAhead", {
          defaultValue: "Queued ({{n}} ahead)",
          n: pendingPosition,
        })}
      </span>
    )
  }
  if (task.status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-rose-700 dark:text-rose-400">
        <AlertTriangle className="h-3 w-3" />
        {t("settings.sections.maintenance.dedup.failed", {
          defaultValue: "Failed ({{retries}}/3)",
          retries: task.retryCount,
        })}
      </span>
    )
  }
  return null
}

interface CardProps {
  entry: GroupUiEntry
  task: DedupTask | undefined
  pendingPosition: number
  onCanonicalChange: (path: string) => void
  onEnqueue: () => void
  onCancel: () => void
  onRetry: () => void
  onNotDuplicate: () => void
  onShowDetail: (path: string) => void
  onRemoveFromGroup: (path: string) => void
}

function DuplicateGroupCard({
  entry,
  task,
  pendingPosition,
  onCanonicalChange,
  onEnqueue,
  onCancel,
  onRetry,
  onNotDuplicate,
  onShowDetail,
  onRemoveFromGroup,
}: CardProps) {
  const { t } = useTranslation()
  const { group, canonicalPath, skipped } = entry

  const inFlight = !!task && (task.status === "pending" || task.status === "processing")
  const failed = !!task && task.status === "failed"
  const finished = skipped

  const confidenceClass =
    group.confidence === "high"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
      : group.confidence === "medium"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
        : "bg-muted text-muted-foreground"

  return (
    <div
      className={`space-y-3 rounded-lg border px-4 py-3 ${
        finished ? "border-border/40 bg-muted/10 opacity-60" : "border-border bg-background"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${confidenceClass}`}>
          {group.confidence}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("settings.sections.maintenance.dedup.candidates", {
            defaultValue: "{{n}} candidates",
            n: group.pages.length,
          })}
        </span>
        {skipped && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
            {t("settings.sections.maintenance.dedup.skipped", { defaultValue: "Marked not duplicates" })}
          </span>
        )}
        {task && !finished && (
          <span className="ml-auto">
            <TaskStatusChip task={task} pendingPosition={pendingPosition} />
          </span>
        )}
      </div>

      {group.reason && (
        <div className="text-xs italic leading-relaxed text-muted-foreground">{group.reason}</div>
      )}

      {!finished && (
        <>
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t("settings.sections.maintenance.dedup.canonicalLabel", {
                defaultValue: "Keep this page as canonical:",
              })}
            </Label>
            {group.pages.map((path) => (
              <div
                key={path}
                className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent"
              >
                <input
                  type="radio"
                  name={`canonical-${group.pages.join(",")}`}
                  checked={canonicalPath === path}
                  onChange={() => onCanonicalChange(path)}
                  disabled={inFlight}
                />
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <code className="truncate font-mono text-xs">{path}</code>
                  <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] font-semibold uppercase text-muted-foreground">
                    {typeFromPath(path)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => onShowDetail(path)}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  title={t("settings.sections.maintenance.dedup.pageDetail", { defaultValue: "View page" })}
                  disabled={inFlight}
                >
                  <FileText className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveFromGroup(path)}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600"
                  title={t("settings.sections.maintenance.dedup.removeFromGroup", { defaultValue: "Remove from group" })}
                  disabled={inFlight}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {!task && (
              <>
                <Button size="sm" onClick={onEnqueue}>
                  {t("settings.sections.maintenance.dedup.mergeButton", {
                    defaultValue: "Merge into {{page}}",
                    page: basenameFromPath(canonicalPath),
                  })}
                </Button>
                <Button size="sm" variant="ghost" onClick={onNotDuplicate}>
                  {t("settings.sections.maintenance.dedup.notDuplicates", {
                    defaultValue: "Not duplicates",
                  })}
                </Button>
              </>
            )}
            {inFlight && (
              <Button size="sm" variant="ghost" onClick={onCancel}>
                <Trash2 className="h-3.5 w-3.5" />
                {t("settings.sections.maintenance.dedup.cancel", {
                  defaultValue: "Cancel",
                })}
              </Button>
            )}
            {failed && (
              <>
                <Button size="sm" onClick={onRetry}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t("settings.sections.maintenance.dedup.retry", {
                    defaultValue: "Retry",
                  })}
                </Button>
                <Button size="sm" variant="ghost" onClick={onCancel}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("settings.sections.maintenance.dedup.delete", {
                    defaultValue: "Delete",
                  })}
                </Button>
              </>
            )}
          </div>
        </>
      )}

      {failed && task?.error && (
        <div className="flex items-start gap-1.5 rounded border border-rose-500/40 bg-rose-500/5 px-2 py-1.5 text-xs text-rose-700 dark:text-rose-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>{task.error}</div>
        </div>
      )}
    </div>
  )
}
