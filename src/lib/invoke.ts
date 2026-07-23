import { invoke } from "@tauri-apps/api/core"
import type { JobListEntry, LaunchdJob, PlistConfig } from "@/types"

export const listJobs = () => invoke<JobListEntry[]>("list_jobs")

export const getJobDetail = (plistPath: string) =>
  invoke<LaunchdJob>("get_job_detail", { plistPath })

export const startJob = (plistPath: string) =>
  invoke<void>("start_job", { plistPath })

export const stopJob = (plistPath: string) =>
  invoke<void>("stop_job", { plistPath })

export const restartJob = (plistPath: string) =>
  invoke<void>("restart_job", { plistPath })

export const kickstartJob = (label: string, plistPath: string) =>
  invoke<void>("kickstart_job", { label, plistPath })

export const enableJob = (label: string) =>
  invoke<void>("enable_job", { label })

export const disableJob = (label: string) =>
  invoke<void>("disable_job", { label })

export const saveJob = (plistPath: string, config: PlistConfig) =>
  invoke<void>("save_job", { plistPath, config })

export const createJob = (label: string, config: PlistConfig) =>
  invoke<string>("create_job", { label, config })

export const deleteJob = (plistPath: string, label: string) =>
  invoke<void>("delete_job", { plistPath, label })

export type LogFileResult = {
  content: string
  modified_at: string | null
}

export const readLogFile = (path: string, tailLines?: number) =>
  invoke<LogFileResult>("read_log_file", { path, tailLines })

export const clearLogFile = (path: string) =>
  invoke<void>("clear_log_file", { path })

export const openLogInEditor = (path: string) =>
  invoke<void>("open_log_in_editor", { path })

export const getHomeDir = () => invoke<string>("get_home_dir")

export const revealInFinder = (path: string) =>
  invoke<void>("reveal_in_finder", { path })

// --- Claude launch terminal (interactive PTY) ---

export const claudeTerminalStart = (
  id: string,
  plistPath: string,
  cols: number,
  rows: number,
  prompt: string
) => invoke<void>("claude_terminal_start", { id, plistPath, cols, rows, prompt })

export const claudeTerminalWrite = (id: string, data: string) =>
  invoke<void>("claude_terminal_write", { id, data })

export const claudeTerminalResize = (id: string, cols: number, rows: number) =>
  invoke<void>("claude_terminal_resize", { id, cols, rows })

export const claudeTerminalStop = (id: string) =>
  invoke<void>("claude_terminal_stop", { id })

export const claudeTerminalPause = (id: string) =>
  invoke<void>("claude_terminal_pause", { id })

export const claudeTerminalResume = (id: string) =>
  invoke<void>("claude_terminal_resume", { id })
