use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BackendMode {
    Remote,
    LocalDetect,
    LocalManaged,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackendConfig {
    pub mode: BackendMode,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manage_pid: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    pub backend: BackendConfig,
}

pub(super) fn config_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("desktop.json")
}

pub fn read_config(app_data_dir: &Path) -> Option<DesktopConfig> {
    let path = config_path(app_data_dir);
    let bytes = fs::read(&path).ok()?;
    match serde_json::from_slice::<DesktopConfig>(&bytes) {
        Ok(cfg) => Some(cfg),
        Err(e) => {
            eprintln!("[tinstar config] parse error in {}: {}", path.display(), e);
            None
        }
    }
}

pub fn write_config(app_data_dir: &Path, cfg: &DesktopConfig) -> std::io::Result<()> {
    let path = config_path(app_data_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(cfg)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    fs::write(&path, bytes)
}

#[tauri::command]
pub fn get_config(app: tauri::AppHandle) -> Option<DesktopConfig> {
    let dir = app.path().app_data_dir().ok()?;
    read_config(&dir)
}

#[tauri::command]
pub fn save_config(app: tauri::AppHandle, cfg: DesktopConfig) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    write_config(&dir, &cfg).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn round_trip_remote_config() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let cfg = DesktopConfig {
            backend: BackendConfig {
                mode: BackendMode::Remote,
                url: "http://infrapoc:5273".to_string(),
                manage_pid: None,
            },
        };
        write_config(dir, &cfg).unwrap();
        let read = read_config(dir).expect("config should round-trip");
        assert_eq!(read, cfg);
    }

    #[test]
    fn missing_config_returns_none() {
        let tmp = TempDir::new().unwrap();
        assert!(read_config(tmp.path()).is_none());
    }

    #[test]
    fn malformed_config_returns_none() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let path = config_path(dir);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"not valid json").unwrap();
        // Returns None and logs to stderr (not asserted; the goal is that it doesn't crash or succeed)
        assert!(read_config(dir).is_none());
    }

    #[test]
    fn manage_pid_round_trips_when_set() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let cfg = DesktopConfig {
            backend: BackendConfig {
                mode: BackendMode::LocalManaged,
                url: "http://localhost:5273".to_string(),
                manage_pid: Some(42),
            },
        };
        write_config(dir, &cfg).unwrap();
        assert_eq!(read_config(dir), Some(cfg));
    }

    #[test]
    fn on_disk_json_uses_camelcase_keys() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let cfg = DesktopConfig {
            backend: BackendConfig {
                mode: BackendMode::LocalManaged,
                url: "http://localhost:5273".to_string(),
                manage_pid: Some(42),
            },
        };
        write_config(dir, &cfg).unwrap();
        let raw = fs::read_to_string(config_path(dir)).unwrap();
        assert!(raw.contains("\"managePid\""), "expected camelCase managePid, got: {raw}");
        assert!(raw.contains("\"local-managed\""), "expected kebab-case mode value, got: {raw}");
        assert!(!raw.contains("\"manage_pid\""), "snake_case key leaked into JSON: {raw}");
    }
}
