#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

const HARDCODED_BASE: &str = "http://infrapoc:5273";

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
        .on_page_load(|window, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                let script = build_eval_script(HARDCODED_BASE);
                let _ = window.eval(&script);
            }
        })
        .setup(|app| {
            let main_window = app
                .get_webview_window("main")
                .expect("main window missing");
            main_window.show().expect("show main window");
            Ok(())
        })
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
}
