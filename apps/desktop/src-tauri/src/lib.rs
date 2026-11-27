pub mod ipc;

use std::sync::Mutex;
use ipc::client::{default_transport, DefaultTransport};
use ipc::IpcHealthClient;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

pub struct TrayClientState(pub Mutex<IpcHealthClient<DefaultTransport>>);

pub mod commands {
    use super::TrayClientState;
    use crate::ipc::SanitizedHealthStatus;

    /// T2 real health command: queries the Rust IPC health client and returns
    /// sanitized operational status to the frontend. Never exposes auth tokens.
    #[tauri::command]
    pub fn get_health_status(state: tauri::State<'_, TrayClientState>) -> SanitizedHealthStatus {
        match state.0.lock() {
            Ok(mut client) => client.poll_health(),
            Err(_) => SanitizedHealthStatus {
                state: crate::ipc::TrayHealthState::Offline,
                health: None,
                agent_version: None,
                browser_protection: crate::ipc::UNMONITORED_LABEL.to_string(),
                ide_protection: crate::ipc::UNMONITORED_LABEL.to_string(),
                status_reason: "Tray IPC client lock unavailable".to_string(),
            },
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client = IpcHealthClient::new(default_transport());

    tauri::Builder::default()
        .manage(TrayClientState(Mutex::new(client)))
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
        .invoke_handler(tauri::generate_handler![commands::get_health_status])
        .run(tauri::generate_context!())
        .expect("error while running ShadowShield desktop tray");
}
