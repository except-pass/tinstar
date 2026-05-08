use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BackendMode {
    Remote,
    LocalDetect,
    LocalManaged,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct BackendConfig {
    pub mode: BackendMode,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manage_pid: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct DesktopConfig {
    pub backend: BackendConfig,
}

pub fn config_path(app_data_dir: &PathBuf) -> PathBuf {
    app_data_dir.join("desktop.json")
}

pub fn read_config(app_data_dir: &PathBuf) -> Option<DesktopConfig> {
    let path = config_path(app_data_dir);
    let bytes = fs::read(&path).ok()?;
    serde_json::from_slice::<DesktopConfig>(&bytes).ok()
}

pub fn write_config(app_data_dir: &PathBuf, cfg: &DesktopConfig) -> std::io::Result<()> {
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
        let dir = tmp.path().to_path_buf();
        let cfg = DesktopConfig {
            backend: BackendConfig {
                mode: BackendMode::Remote,
                url: "http://infrapoc:5273".to_string(),
                manage_pid: None,
            },
        };
        write_config(&dir, &cfg).unwrap();
        let read = read_config(&dir).expect("config should round-trip");
        assert_eq!(read, cfg);
    }

    #[test]
    fn missing_config_returns_none() {
        let tmp = TempDir::new().unwrap();
        assert!(read_config(&tmp.path().to_path_buf()).is_none());
    }
}
