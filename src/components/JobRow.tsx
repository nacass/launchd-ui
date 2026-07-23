import { useState, useRef } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TableCell, TableRow } from "@/components/ui/table"
import { AgentTerminal } from "@/components/AgentTerminal"
import {
  claudeTerminalWrite,
  claudeTerminalPause,
  claudeTerminalResume,
  claudeTerminalStop,
} from "@/lib/invoke"
import type { JobListEntry } from "@/types"
import {
  Play,
  Square,
  RotateCw,
  MoreHorizontal,
  Trash2,
  FileText,
  FolderOpen,
  Zap,
  Pause,
  ChevronDown,
  ChevronRight,
} from "lucide-react"

function formatRelativeTime(epochMillis: string): string {
  const ms = Number(epochMillis)
  if (isNaN(ms)) return "—"
  const diff = Date.now() - ms
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const date = new Date(ms)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

type JobRowProps = {
  job: JobListEntry
  onStart: (job: JobListEntry) => void
  onStop: (job: JobListEntry) => void
  onRestart: (job: JobListEntry) => void
  onKickstart: (job: JobListEntry) => void
  onDelete: (job: JobListEntry) => void
  onSelect: (job: JobListEntry) => void
  onRevealInFinder: (job: JobListEntry) => void
}

function StatusBadge({ status }: { status: JobListEntry["status"] }) {
  switch (status) {
    case "Running":
      return (
        <Badge variant="default" className="bg-emerald-500 hover:bg-emerald-600">
          Running
        </Badge>
      )
    case "Loaded":
      return (
        <Badge variant="default" className="bg-blue-500 hover:bg-blue-600">
          Loaded
        </Badge>
      )
    case "Unloaded":
      return <Badge variant="secondary">Unloaded</Badge>
    default:
      return <Badge variant="outline">Unknown</Badge>
  }
}

function SourceBadge({ source }: { source: JobListEntry["source"] }) {
  switch (source) {
    case "UserAgent":
      return <Badge variant="outline">User</Badge>
    case "SystemAgent":
      return (
        <Badge variant="outline" className="border-blue-300 text-blue-700">
          System
        </Badge>
      )
    case "SystemDaemon":
      return (
        <Badge variant="outline" className="border-purple-300 text-purple-700">
          Daemon
        </Badge>
      )
  }
}

export function JobRow({
  job,
  onStart,
  onStop,
  onRestart,
  onKickstart,
  onDelete,
  onSelect,
  onRevealInFinder,
}: JobRowProps) {
  const isUserAgent = job.source === "UserAgent"
  const isHome = job.is_home_agent

  // Interactive claude session for this agent. `claudeStarted` keeps the panel
  // mounted (so the transcript stays visible even after the process is stopped);
  // `generation` bumps to force a fresh session on relaunch.
  const [claudeStarted, setClaudeStarted] = useState(false)
  const [claudeStatus, setClaudeStatus] = useState<
    "working" | "waiting" | "idle" | "ended"
  >("idle")
  const [claudePaused, setClaudePaused] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [generation, setGeneration] = useState(0)
  // Digit to press to approve claude's current yes/no prompt ("2" when a
  // "yes, and don't ask again" option exists, else "1").
  const approveKeyRef = useRef("1")
  const sessionId = `claude-terminal:${job.plist_path}:${generation}`
  const claudePrompt = "où en est-on ?"

  const handleStatus = (
    status: "working" | "waiting" | "idle" | "ended",
    approveKey: string | null
  ) => {
    setClaudeStatus(status)
    if (approveKey) approveKeyRef.current = approveKey
  }

  // Alive = the panel is open AND claude's process is still running.
  const alive = claudeStarted && claudeStatus !== "ended"
  const claudeIdle = alive && claudeStatus === "idle" && !claudePaused
  // Pause is "lit" while manually paused OR while claude awaits a yes/no answer.
  const pauseLit = alive && (claudePaused || claudeStatus === "waiting")
  const greyIcon = "fill-muted-foreground/20 text-muted-foreground/40"

  // Super-lightning: launch claude, relaunch a fresh session after it ended, or
  // (when idle) re-ask in the same session.
  const onSuperLightning = () => {
    if (!claudeStarted) {
      setClaudeStarted(true)
      setClaudeStatus("working")
    } else if (claudeStatus === "ended") {
      setGeneration((g) => g + 1) // remount → fresh session
      setClaudePaused(false)
      setClaudeStatus("working")
    } else {
      claudeTerminalWrite(sessionId, `${claudePrompt}\r`)
      setClaudeStatus("working")
    }
    setExpanded(true)
  }
  // Blue pause button. When claude is waiting on a yes/no, it approves (sends
  // "yes", or "yes, and don't ask again" when that option exists). Otherwise it
  // pauses / resumes the whole claude process group.
  const onPause = () => {
    if (claudeStatus === "waiting") {
      claudeTerminalWrite(sessionId, approveKeyRef.current)
    } else if (claudePaused) {
      claudeTerminalResume(sessionId)
      setClaudePaused(false)
    } else {
      claudeTerminalPause(sessionId)
      setClaudePaused(true)
    }
  }
  // Super-stop: kill claude but keep the panel open showing the ended transcript
  // (status flips to "ended" via the exit event). Works even when collapsed.
  const onSuperStop = () => {
    claudeTerminalStop(sessionId)
    setClaudePaused(false)
  }

  return (
    <>
    <TableRow
      className="cursor-pointer hover:bg-muted/50"
      onClick={() => onSelect(job)}
    >
      <TableCell className="font-medium truncate max-w-0">{job.label}</TableCell>
      <TableCell>
        <SourceBadge source={job.source} />
      </TableCell>
      <TableCell>
        <StatusBadge status={job.status} />
      </TableCell>
      <TableCell className="text-muted-foreground tabular-nums">
        {job.pid ?? "—"}
      </TableCell>
      <TableCell className="text-muted-foreground text-xs tabular-nums">
        {job.last_run_at ? formatRelativeTime(job.last_run_at) : "—"}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {job.status === "Running" ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onStop(job)}
              disabled={!isUserAgent}
              title={isUserAgent ? "Stop" : "Cannot stop system agents"}
            >
              <Square className="h-4 w-4" />
            </Button>
          ) : job.status === "Loaded" ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onStop(job)}
              disabled={!isUserAgent}
              title={isUserAgent ? "Unload" : "Cannot unload system agents"}
            >
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onStart(job)}
              disabled={!isUserAgent}
              title={isUserAgent ? "Load" : "Cannot load system agents"}
            >
              <Play className="h-4 w-4" />
            </Button>
          )}
          {job.status !== "Unloaded" && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onRestart(job)}
              disabled={!isUserAgent}
              title={isUserAgent ? "Restart" : "Cannot restart system agents"}
            >
              <RotateCw className="h-4 w-4" />
            </Button>
          )}
          {(job.status === "Running" || job.status === "Loaded") && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onKickstart(job)}
              disabled={!isUserAgent}
              aria-label={isUserAgent ? "Run now" : "Cannot run system agents"}
              title={isUserAgent ? "Run now" : "Cannot run system agents"}
            >
              <Zap className="h-4 w-4" />
            </Button>
          )}
          {isHome && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={onSuperLightning}
                disabled={alive && !claudeIdle}
                title={
                  !claudeStarted
                    ? "Lancer un chat Claude (« où en est-on ? »)"
                    : claudeStatus === "ended"
                      ? "Relancer une session Claude"
                      : claudeIdle
                        ? "Redemander « où en est-on ? »"
                        : "Claude travaille…"
                }
              >
                <Zap
                  className={`h-4 w-4 ${alive && !claudeIdle ? greyIcon : "fill-amber-400 text-amber-500"}`}
                />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={onPause}
                disabled={!alive}
                title={
                  claudeStatus === "waiting"
                    ? "Approuver (Yes / Yes for all)"
                    : claudePaused
                      ? "Reprendre Claude"
                      : "Mettre Claude en pause"
                }
              >
                <Pause
                  className={`h-4 w-4 ${pauseLit ? "fill-sky-500 text-sky-500" : greyIcon}`}
                />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={onSuperStop}
                disabled={!alive}
                title="Arrêter Claude"
              >
                <Square
                  className={`h-4 w-4 ${alive ? "fill-red-500 text-red-500" : greyIcon}`}
                />
              </Button>
            </>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onKickstart(job)}>
                <Zap className="mr-2 h-4 w-4" />
                Test Run
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onSelect(job)}>
                <FileText className="mr-2 h-4 w-4" />
                Details
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onRevealInFinder(job)}>
                <FolderOpen className="mr-2 h-4 w-4" />
                Reveal in Finder
              </DropdownMenuItem>
              {isUserAgent && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={() => onDelete(job)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {isHome && claudeStarted && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? "Replier le terminal Claude" : "Déplier le terminal Claude"}
            >
              {expanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
    {isHome && claudeStarted && (
      <TableRow className={expanded ? "" : "hidden"}>
        <TableCell colSpan={6} className="p-0">
          <AgentTerminal
            key={generation}
            sessionId={sessionId}
            plistPath={job.plist_path}
            prompt={claudePrompt}
            visible={expanded}
            onStatusChange={handleStatus}
          />
        </TableCell>
      </TableRow>
    )}
    </>
  )
}
