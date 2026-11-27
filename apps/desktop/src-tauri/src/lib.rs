pub mod ipc;
pub mod lifecycle;

use std::sync::Mutex;
use ipc::client::{default_transport, DefaultTransport};
use ipc::IpcHealthClient;
use lifecycle::{CloseAction, ExitAction, TrayLifecycleState};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WindowEvent,
};

pub struct TrayClientState(pub Mutex<IpcHealthClient<DefaultTransport>>);

pub mod commands {
    use super::TrayClientState;
    use crate::ipc::SanitizedHealthStatus;

    /// T2/T3 real health command: queries the Rust IPC health client and returns
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

fn show_and_focus_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    app.state::<TrayLifecycleState>().on_show_status();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client = IpcHealthClient::new(default_transport());

    let app = tauri::Builder::default()
        .manage(TrayClientState(Mutex::new(client)))
        .manage(TrayLifecycleState::new(true))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            let lifecycle = app.state::<TrayLifecycleState>();
            if lifecycle.mark_tray_initialized() {
                let show_item =
                    MenuItem::with_id(app, "show_status", "Show Status", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

                let mut tray_builder = TrayIconBuilder::with_id("shadowshield-tray")
                    .menu(&menu)
                    .tooltip("ShadowShield — Desktop Tray Monitor")
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show_status" => {
                            show_and_focus_main_window(app);
                        }
                        "quit" => {
                            app.state::<TrayLifecycleState>().on_quit_requested();
                            if let Ok(mut client) = app.state::<TrayClientState>().0.lock() {
                                client.shutdown();
                            }
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
                            show_and_focus_main_window(tray.app_handle());
                        }
                    });

                if let Some(icon) = app.default_window_icon() {
                    tray_builder = tray_builder.icon(icon.clone());
                }

                tray_builder.build(app)?;
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let action = window
                        .app_handle()
                        .state::<TrayLifecycleState>()
                        .on_close_requested();
                    if action == CloseAction::HideToTray {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![commands::get_health_status])
        .build(tauri::generate_context!())
        .expect("error while building ShadowShield desktop tray");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            let action = app_handle
                .state::<TrayLifecycleState>()
                .on_exit_requested();
            if action == ExitAction::PreventExit {
                api.prevent_exit();
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            if !has_visible_windows {
                show_and_focus_main_window(app_handle);
            }
        }
        _ => {}
    });
}
