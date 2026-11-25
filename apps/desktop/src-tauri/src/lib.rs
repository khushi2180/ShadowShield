use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

pub const PROTOCOL_VERSION: u32 = 1;
pub const UNMONITORED_LABEL: &str = "Unknown (unmonitored)";

/// Exact HealthResponse structure from crates/protocol/src/ipc.rs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HealthResponse {
    pub agent_running: bool,
    pub inspection_engine_available: bool,
    pub protocol_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MockTrayStatus {
    pub health: HealthResponse,
    pub browser_protection: String,
    pub ide_protection: String,
    pub mode: String,
}

pub mod commands {
    use super::{HealthResponse, MockTrayStatus, PROTOCOL_VERSION, UNMONITORED_LABEL};

    /// T1 mock status command: returns deterministic contract-aligned status
    /// without connecting to any real daemon.
    #[tauri::command]
    pub fn get_status() -> MockTrayStatus {
        MockTrayStatus {
            health: HealthResponse {
                agent_running: true,
                inspection_engine_available: true,
                protocol_version: PROTOCOL_VERSION,
            },
            browser_protection: UNMONITORED_LABEL.to_string(),
            ide_protection: UNMONITORED_LABEL.to_string(),
            mode: "mock".to_string(),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let show_item = MenuItem::with_id(app, "show_status", "Show Status", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::with_id("shadowshield-tray")
                .menu(&menu)
                .tooltip("ShadowShield — Desktop Tray Monitor")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show_status" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }

            tray_builder.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![commands::get_status])
        .run(tauri::generate_context!())
        .expect("error while running ShadowShield desktop tray");
}
