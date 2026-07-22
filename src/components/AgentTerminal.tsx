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
}

// The interactive claude session lives for as long as this component is mounted:
// mounting starts the PTY, unmounting kills it. Collapsing the panel only hides
// it (visible=false), so the session keeps running in the background.
export function AgentTerminal({
  sessionId,
  plistPath,
  prompt,
  visible,
}: AgentTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      fontSize: 12,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: "#0a0a0a", foreground: "#e4e4e7" },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const unlisteners: Array<() => void> = []
    let disposed = false

    // Subscribe to output BEFORE starting so nothing is missed.
    listen<OutputPayload>("claude-terminal-output", (e) => {
      if (e.payload.id === sessionId) {
        term.write(new Uint8Array(e.payload.bytes))
      }
    }).then((un) => unlisteners.push(un))

    listen<ExitPayload>("claude-terminal-exit", (e) => {
      if (e.payload.id === sessionId && !disposed) {
        term.write("\r\n\x1b[2m[claude session ended]\x1b[0m\r\n")
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
