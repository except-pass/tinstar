use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Open a native folder-picker dialog and return the chosen path as a string,
/// or `None` if the user cancelled.
///
/// Uses `FileDialogBuilder::blocking_pick_folder` (tauri-plugin-dialog 2.7.x),
/// which is the correct blocking API for use inside a `#[tauri::command]` async
/// function — it must NOT be called from the main thread (which Tauri commands
/// never run on).
#[tauri::command]
pub async fn open_directory_dialog(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}
