import { useEffect, useRef } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { listen } from "@tauri-apps/api/event"
import "@xterm/xterm/css/xterm.css"
import {
  claudeTerminalStart,
  claudeTerminalWrite,
  claudeTerminalResize,
  claudeTerminalStop,
} from "@/lib/invoke"

type OutputPayload = { id: string; bytes: number[] }
type ExitPayload = { id: string }

type AgentTerminalProps = {
  /** Stable session id (one interactive claude process per id). */
  sessionId: string
  plistPath: string
  /** Initial prompt seeded to claude on launch. */
  prompt: string
  /** Whether the panel is currently expanded (drives re-fit). */
  visible: boolean
  /**
   * Reports claude's activity, read from the terminal:
   * - "working": actively processing (shows "esc to interrupt")
   * - "waiting": awaiting a yes/no answer (shows "esc to cancel" / "proceed?")
   * - "idle": finished responding, sitting at its prompt
   * `approveKey` is the digit to press to approve when waiting ("2" = "yes, and
   * don't ask again" when that option exists, else "1" = plain yes); null otherwise.
   */
  onStatusChange?: (
    status: "working" | "waiting" | "idle" | "ended",
    approveKey: string | null
  ) => void
}

// The interactive claude session lives for as long as this component is mounted:
// mounting starts the PTY, unmounting kills it. Collapsing the panel only hides
// it (visible=false), so the session keeps running in the background.
export function AgentTerminal({
  sessionId,
  plistPath,
  prompt,
  visible,
  onStatusChange,
}: AgentTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const onStatusRef = useRef(onStatusChange)
  onStatusRef.current = onStatusChange

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      fontSize: 13,
      fontFamily:
        '"SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      cursorBlink: false,
      cursorStyle: "bar",
      scrollback: 5000,
      // Matches the user's Ghostty theme (~/.config/ghostty/config).
      theme: {
        background: "#f5f0e8",
        foreground: "#1a1a1a",
        cursor: "#8b5cf6",
        cursorAccent: "#f5f0e8",
        selectionBackground: "#e9d8fd",
        selectionForeground: "#1a1a1a",
        black: "#2d2d2d",
        red: "#c0392b",
        green: "#27ae60",
        yellow: "#d68910",
        blue: "#8b5cf6",
        magenta: "#9b59b6",
        cyan: "#16a085",
        white: "#e8e0d0",
        brightBlack: "#6b6b6b",
        brightRed: "#e74c3c",
        brightGreen: "#2ecc71",
        brightYellow: "#f39c12",
        brightBlue: "#a78bfa",
        brightMagenta: "#b77edb",
        brightCyan: "#1abc9c",
        brightWhite: "#f5f0e8",
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const unlisteners: Array<() => void> = []
    let disposed = false

    // Track claude's activity by reading the visible terminal: it shows
    // "esc to interrupt" while working and "Do you want to proceed / esc to
    // cancel" while waiting on a yes/no answer; neither means it is idle.
    type Status = "working" | "waiting" | "idle" | "ended"
    let lastStatus: Status | null = null
    const reportStatus = (status: Status, approveKey: string | null) => {
      // Fire on any status change, and keep firing while waiting so the approve
      // key stays fresh as the (possibly late-rendering) menu options appear.
      if (status !== lastStatus || status === "waiting") {
        lastStatus = status
        onStatusRef.current?.(status, approveKey)
      }
    }
    const evalStatus = () => {
      const buf = term.buffer.active
      const startLine = Math.max(0, buf.length - 25)
      let text = ""
      for (let i = startLine; i < buf.length; i++) {
        text += (buf.getLine(i)?.translateToString(true) ?? "") + "\n"
      }
      const t = text.toLowerCase()
      if (t.includes("esc to interrupt")) {
        reportStatus("working", null)
      } else if (
        t.includes("do you want to") ||
        t.includes("esc to cancel") ||
        t.includes("no, exit")
      ) {
        // 3-option prompt ("1. Yes / 2. Yes-for-all / 3. No") → approve with "2"
        // (works for edits "allow all edits…" and commands "don't ask again…");
        // a 2-option prompt ("1. Yes / 2. No") → "1".
        const hasThirdOption = /(?:^|\s)3\.\s/m.test(text)
        const approveKey = hasThirdOption ? "2" : "1"
        reportStatus("waiting", approveKey)
      } else {
        reportStatus("idle", null)
      }
    }
    reportStatus("working", null) // launching + processing the initial prompt
    const busyInterval = setInterval(evalStatus, 600)

    // Subscribe to output BEFORE starting so nothing is missed.
    listen<OutputPayload>("claude-terminal-output", (e) => {
      if (e.payload.id === sessionId) {
        term.write(new Uint8Array(e.payload.bytes))
      }
    }).then((un) => unlisteners.push(un))

    listen<ExitPayload>("claude-terminal-exit", (e) => {
      if (e.payload.id === sessionId && !disposed) {
        // Process died (stopped or /quit): keep the panel showing the transcript,
        // stop polling, and mark the session as ended.
        clearInterval(busyInterval)
        term.write("\r\n\x1b[2m[claude session ended]\x1b[0m\r\n")
        reportStatus("ended", null)
      }
    }).then((un) => unlisteners.push(un))

    // Keystrokes (incl. Ctrl+C \x03, Esc \x1b, arrows) → PTY.
    const dataSub = term.onData((data) => {
      claudeTerminalWrite(sessionId, data)
    })

    claudeTerminalStart(sessionId, plistPath, term.cols, term.rows, prompt).catch(
      (err) => term.write(`\r\n\x1b[31m[failed to start claude: ${err}]\x1b[0m\r\n`)
    )

    const ro = new ResizeObserver(() => {
      if (!termRef.current || !fitRef.current) return
      try {
        fitRef.current.fit()
        if (term.cols > 0 && term.rows > 0) {
          claudeTerminalResize(sessionId, term.cols, term.rows)
        }
      } catch {
        // container may be hidden (0 size) — ignore
      }
    })
    ro.observe(container)

    return () => {
      disposed = true
      clearInterval(busyInterval)
      reportStatus("idle", null)
      ro.disconnect()
      dataSub.dispose()
      unlisteners.forEach((un) => un())
      claudeTerminalStop(sessionId)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // Session identity is fixed for the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-fit when the panel is expanded (it can't measure while hidden).
  useEffect(() => {
    if (!visible) return
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit()
        const term = termRef.current
        if (term && term.cols > 0 && term.rows > 0) {
          claudeTerminalResize(sessionId, term.cols, term.rows)
        }
        term?.focus()
      } catch {
        // ignore
      }
    }, 30)
    return () => clearTimeout(t)
  }, [visible, sessionId])

  return <div ref={containerRef} className="h-72 w-full overflow-hidden" />
}
