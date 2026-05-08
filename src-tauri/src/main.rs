#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

mod backend;
mod config;
mod dialog;

fn resolve_api_base(cfg: Option<&config::DesktopConfig>) -> String {
    cfg.map(|c| c.backend.url.clone()).unwrap_or_default()
}

/// Strip trailing slashes and reject anything containing characters that would
/// let an attacker break out of the JS string literal we eval. We never accept
/// origins from untrusted sources (only desktop.json or a hardcoded constant),
/// but defense-in-depth: if the string contains anything outside a strict URL
/// charset, return empty so the frontend falls back to same-origin.
fn sanitize_api_base(raw: &str) -> String {
    let trimmed = raw.trim_end_matches('/');
    if trimmed.contains(['"', '\'', '\n', '\r', '\\', '<', '>']) {
        return String::new();
    }
    trimmed.to_string()
}

/// Pure function — builds the JS snippet we hand to `Window::eval()` to set
/// `window.__TINSTAR_API_BASE__`. Extracted from `on_page_load` for unit
/// testing: Tauri 2 has no headless webview test harness in OSS, so the best
/// we can do is verify the string we'd inject is correctly quoted.
fn build_eval_script(base: &str) -> String {
    let sanitized = sanitize_api_base(base);
    format!(
        "window.__TINSTAR_API_BASE__ = {};",
        serde_json::to_string(&sanitized).expect("json string is always serializable")
    )
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(backend::ManagedBackend(std::sync::Mutex::new(None)))
        .setup(|app| {
            // Build the main window programmatically so we can attach an
            // `initialization_script` — that script is documented to run BEFORE
            // any document parsing or inline scripts, so apiClient.ts always
            // sees the correct __TINSTAR_API_BASE__.
            //
            // `Window::eval()` from on_page_load is unreliable on Windows
            // WebView2: the inline placeholder `<script>__TINSTAR_API_BASE__ = ''</script>`
            // executes before our eval lands, leaving the global as empty
            // string. Using initialization_script eliminates the race.
            let app_data_dir = app.path().app_data_dir().ok();
            let cfg = app_data_dir.as_ref().and_then(|d| config::read_config(d));
            let base = resolve_api_base(cfg.as_ref());
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::default(),
            )
            .title("Tinstar")
            .inner_size(1400.0, 900.0)
            .min_inner_size(900.0, 600.0)
            .decorations(true)
            .initialization_script(build_eval_script(&base))
            .build()
            .expect("failed to build main window");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::get_config,
            config::save_config,
            backend::probe_backend,
            backend::start_local_backend,
            backend::stop_local_backend,
            dialog::open_directory_dialog,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_trailing_slash() {
        assert_eq!(sanitize_api_base("http://infrapoc:5273/"), "http://infrapoc:5273");
    }

    #[test]
    fn rejects_quotes_and_newlines() {
        assert_eq!(sanitize_api_base("http://x\"; alert(1)//"), "");
        assert_eq!(sanitize_api_base("http://x\n"), "");
    }

    #[test]
    fn passes_clean_origin() {
        assert_eq!(sanitize_api_base("http://infrapoc:5273"), "http://infrapoc:5273");
    }

    #[test]
    fn eval_script_quotes_string() {
        assert_eq!(
            build_eval_script("http://infrapoc:5273"),
            "window.__TINSTAR_API_BASE__ = \"http://infrapoc:5273\";"
        );
    }

    #[test]
    fn eval_script_blanks_on_unsafe_input() {
        assert_eq!(
            build_eval_script("http://x\"; alert(1)//"),
            "window.__TINSTAR_API_BASE__ = \"\";"
        );
    }

    #[test]
    fn empty_when_no_config() {
        assert_eq!(resolve_api_base(None), "");
    }

    #[test]
    fn uses_config_url_when_present() {
        use crate::config::{BackendConfig, BackendMode, DesktopConfig};
        let cfg = DesktopConfig {
            backend: BackendConfig {
                mode: BackendMode::Remote,
                url: "http://example.com:5273".to_string(),
                manage_pid: None,
            },
        };
        assert_eq!(resolve_api_base(Some(&cfg)), "http://example.com:5273");
    }
}
