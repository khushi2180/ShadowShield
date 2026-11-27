use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShowAction {
    ShowAndFocus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    HideToTray,
    AllowClose,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitAction {
    ExitCleanly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitAction {
    PreventExit,
    AllowExit,
}

/// Manages T3 menu-bar/tray persistence and window lifecycle invariants:
/// - Tray icon is initialized once (no duplicates).
/// - Closing the status window hides it to the tray instead of exiting.
/// - "Show Status" reveals and focuses the existing status window.
/// - "Quit" marks an intentional exit and allows clean termination.
pub struct TrayLifecycleState {
    tray_initialized: AtomicBool,
    window_visible: AtomicBool,
    quit_requested: AtomicBool,
}

impl TrayLifecycleState {
    pub fn new(initial_window_visible: bool) -> Self {
        Self {
            tray_initialized: AtomicBool::new(false),
            window_visible: AtomicBool::new(initial_window_visible),
            quit_requested: AtomicBool::new(false),
        }
    }

    /// Marks the tray icon as initialized. Returns `true` only on the first call
    /// so duplicate tray icons are never created.
    pub fn mark_tray_initialized(&self) -> bool {
        !self.tray_initialized.swap(true, Ordering::SeqCst)
    }

    pub fn is_tray_initialized(&self) -> bool {
        self.tray_initialized.load(Ordering::SeqCst)
    }

    pub fn is_window_visible(&self) -> bool {
        self.window_visible.load(Ordering::SeqCst)
    }

    pub fn is_quitting(&self) -> bool {
        self.quit_requested.load(Ordering::SeqCst)
    }

    pub fn on_show_status(&self) -> ShowAction {
        self.window_visible.store(true, Ordering::SeqCst);
        ShowAction::ShowAndFocus
    }

    pub fn on_close_requested(&self) -> CloseAction {
        if self.quit_requested.load(Ordering::SeqCst) {
            CloseAction::AllowClose
        } else {
            self.window_visible.store(false, Ordering::SeqCst);
            CloseAction::HideToTray
        }
    }

    pub fn on_quit_requested(&self) -> QuitAction {
        self.quit_requested.store(true, Ordering::SeqCst);
        QuitAction::ExitCleanly
    }

    pub fn on_exit_requested(&self) -> ExitAction {
        if self.quit_requested.load(Ordering::SeqCst) {
            ExitAction::AllowExit
        } else {
            ExitAction::PreventExit
        }
    }
}
