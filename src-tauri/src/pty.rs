//! Interactive Claude sessions running inside a PTY.
//!
//! The "super lightning" button launches `claude` (interactive) in the working
//! directory of the clicked agent and streams the PTY to an embedded xterm.js
//! terminal in the frontend. Because it is a real PTY, Ctrl+C, Esc and Claude's
//! interactive menus all work.

use crate::error::AppError;
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    pid: Option<u32>,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, Session>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, serde::Serialize)]
struct OutputPayload {
    id: String,
    bytes: Vec<u8>,
}

#[derive(Clone, serde::Serialize)]
struct ExitPayload {
    id: String,
}

/// Resolve the `claude` binary, preferring known Homebrew/local locations.
fn resolve_claude() -> String {
    for candidate in ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"] {
        if std::path::Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    "claude".to_string()
}

/// Extract the target of a `cd "<path>"` / `cd '<path>'` from a shell command string.
fn extract_cd_dir(s: &str) -> Option<String> {
    let (start, quote) = s
        .find("cd \"")
        .map(|i| (i + 4, '"'))
        .or_else(|| s.find("cd '").map(|i| (i + 4, '\'')))?;
    let rest = &s[start..];
    let end = rest.find(quote)?;
    Some(rest[..end].to_string())
}

/// Best-effort working directory for an agent: its `WorkingDirectory`, else a
/// `cd` inside its command, else the directory of the script it runs, else $HOME.
fn derive_cwd(plist_path: &str) -> String {
    let home = dirs::home_dir().unwrap_or_default();
    let home_str = home.to_string_lossy().to_string();

    if let Ok(cfg) = crate::plist_util::parse_plist(plist_path) {
        if let Some(wd) = cfg.working_directory {
            if !wd.is_empty() && std::path::Path::new(&wd).is_dir() {
                return wd;
            }
        }
        let mut candidates: Vec<String> = Vec::new();
        if let Some(p) = cfg.program {
            candidates.push(p);
        }
        if let Some(args) = cfg.program_arguments {
            candidates.extend(args);
        }
        for c in &candidates {
            if let Some(dir) = extract_cd_dir(c) {
                if std::path::Path::new(&dir).is_dir() {
                    return dir;
                }
            }
        }
        for c in &candidates {
            if c.starts_with(&home_str) && !c.contains(".app/") {
                let p = std::path::Path::new(c);
                if p.is_dir() {
                    return c.clone();
                }
                if p.is_file() {
                    if let Some(parent) = p.parent() {
                        return parent.to_string_lossy().to_string();
                    }
                }
            }
        }
    }
    home_str
}

/// True when claude already has a saved conversation for `cwd`, so it can be
/// resumed with `--continue` instead of starting fresh. Claude stores per-project
/// transcripts under ~/.claude/projects/<slug>/ where <slug> is the cwd with every
/// non-alphanumeric character replaced by '-'.
fn has_prior_conversation(cwd: &str) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let slug: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let dir = home.join(".claude/projects").join(slug);
    match std::fs::read_dir(&dir) {
        Ok(entries) => entries
            .flatten()
            .any(|e| e.path().extension().is_some_and(|x| x == "jsonl")),
        Err(_) => false,
    }
}

fn start(
    app: AppHandle,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    prompt: String,
) -> Result<(), AppError> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::Launchctl(format!("pty open: {e}")))?;

    // Try to resume this folder's last conversation, but fall back to a fresh
    // session (via `||`) so claude never just exits when `--continue` finds
    // nothing to resume. `exec` keeps the final claude as the PTY session leader.
    let claude = resolve_claude();
    let quoted = format!("'{}'", prompt.replace('\'', "'\\''"));
    let inner = if has_prior_conversation(&cwd) {
        format!("{claude} --continue {quoted} || exec {claude} {quoted}")
    } else {
        format!("exec {claude} {quoted}")
    };
    let mut cmd = CommandBuilder::new("/bin/zsh");
    cmd.arg("-c");
    cmd.arg(inner);
    cmd.cwd(cwd);
    // Inherit the parent environment, then ensure claude is findable and the
    // terminal type is set for its TUI.
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    let path = std::env::var("PATH").unwrap_or_default();
    cmd.env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{path}"));
    cmd.env("TERM", "xterm-256color");
    // GUI apps often launch without a UTF-8 locale; set one so accented prompts
    // ("où en est-on ?") aren't mangled.
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("LC_ALL", "en_US.UTF-8");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::Launchctl(format!("spawn claude: {e}")))?;
    let pid = child.process_id();
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::Launchctl(format!("pty reader: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::Launchctl(format!("pty writer: {e}")))?;

    SESSIONS.lock().unwrap().insert(
        id.clone(),
        Session {
            master: pair.master,
            writer,
            child,
            pid,
        },
    );

    // Stream PTY output to the frontend until the process exits.
    let reader_app = app.clone();
    let reader_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = reader_app.emit(
                        "claude-terminal-output",
                        OutputPayload {
                            id: reader_id.clone(),
                            bytes: buf[..n].to_vec(),
                        },
                    );
                }
            }
        }
        let _ = reader_app.emit(
            "claude-terminal-exit",
            ExitPayload {
                id: reader_id.clone(),
            },
        );
        SESSIONS.lock().unwrap().remove(&reader_id);
    });

    Ok(())
}

#[tauri::command]
pub fn claude_terminal_start(
    app: AppHandle,
    id: String,
    plist_path: String,
    cols: u16,
    rows: u16,
    prompt: String,
) -> Result<(), AppError> {
    let cwd = derive_cwd(&plist_path);
    start(app, id, cwd, cols, rows, prompt)
}

#[tauri::command]
pub fn claude_terminal_write(id: String, data: String) -> Result<(), AppError> {
    let mut map = SESSIONS.lock().unwrap();
    if let Some(s) = map.get_mut(&id) {
        s.writer
            .write_all(data.as_bytes())
            .map_err(|e| AppError::Launchctl(format!("pty write: {e}")))?;
        let _ = s.writer.flush();
    }
    Ok(())
}

#[tauri::command]
pub fn claude_terminal_resize(id: String, cols: u16, rows: u16) -> Result<(), AppError> {
    let map = SESSIONS.lock().unwrap();
    if let Some(s) = map.get(&id) {
        s.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Launchctl(format!("pty resize: {e}")))?;
    }
    Ok(())
}

#[tauri::command]
pub fn claude_terminal_stop(id: String) -> Result<(), AppError> {
    // Kill the whole group (the launcher shell and claude) so nothing is left
    // orphaned, then drop the session.
    signal_group(&id, "-KILL");
    if let Some(mut s) = SESSIONS.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
    Ok(())
}

/// Send a signal to the session's whole process group (claude + its children,
/// which share the PTY session leader's group). Used to pause/resume.
fn signal_group(id: &str, signal: &str) {
    let map = SESSIONS.lock().unwrap();
    if let Some(s) = map.get(id) {
        if let Some(pid) = s.pid {
            let _ = std::process::Command::new("/bin/kill")
                .arg(signal)
                .arg(format!("-{pid}"))
                .status();
        }
    }
}

#[tauri::command]
pub fn claude_terminal_pause(id: String) -> Result<(), AppError> {
    signal_group(&id, "-STOP");
    Ok(())
}

#[tauri::command]
pub fn claude_terminal_resume(id: String) -> Result<(), AppError> {
    signal_group(&id, "-CONT");
    Ok(())
}
