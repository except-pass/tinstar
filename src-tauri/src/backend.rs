use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

pub struct ManagedBackend(pub Mutex<Option<Child>>);

#[tauri::command]
pub fn probe_backend(url: String) -> bool {
    let target = format!("{}/api/state", url.trim_end_matches('/'));
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map(|c| c.get(&target).send().is_ok_and(|r| r.status().is_success()))
        .unwrap_or(false)
}

#[tauri::command]
pub fn start_local_backend(state: State<'_, ManagedBackend>) -> Result<u32, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("backend already managed".into());
    }
    let exe = which::which("tinstar").map_err(|e| e.to_string())?;
    let child = Command::new(&exe)
        .args(["--no-setup", "--port", "5273"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let pid = child.id();
    *guard = Some(child);
    Ok(pid)
}

#[tauri::command]
pub fn stop_local_backend(state: State<'_, ManagedBackend>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_returns_false_for_unreachable() {
        // Use a port we deliberately leave closed.
        assert!(!probe_backend("http://127.0.0.1:1".to_string()));
    }

    #[test]
    fn probe_handles_trailing_slash() {
        // Should not crash and should still return false for an unreachable host.
        assert!(!probe_backend("http://127.0.0.1:1/".to_string()));
    }
}
