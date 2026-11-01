//! Whether Yavin's window has the user's focus (EXT-27), as Windows itself says it: the window
//! is the foreground one (or owns it, as with its own dialogs) and is not minimized.
//!
//! Neither of Tauri's own signals was reliable for this, measured in the packaged application:
//! its focus events follow WebView2's keyboard focus (a window activated while its web view
//! already holds the focus reports nothing), and `is_focused` answered false while the window
//! was in front. The foreground window is the OS's answer, readable from any thread.
//!
//! Changes come from WinEvent hooks -- the foreground changing, a window minimized or restored --
//! set on the UI thread, whose message loop delivers them. Each change is said once, as
//! [`EVENT`] with the new state; the window reads the state at start with [`window_focused`].

use tauri::{AppHandle, WebviewWindow};

/// The event that says the window's focus changed: `true` (focused) or `false`.
pub const EVENT: &str = "yavin://window-focus";

/// Whether the window is the foreground one now.
#[tauri::command]
pub fn window_focused(window: WebviewWindow) -> bool {
    os::focused(&window)
}

/// Follows the foreground window from now on; call it on the UI thread (the app's `setup`).
pub fn follow(app: &AppHandle) {
    os::follow(app);
}

#[cfg(windows)]
mod os {
    use super::EVENT;
    use std::ptr::null_mut;
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetForegroundWindow, IsIconic, EVENT_SYSTEM_FOREGROUND,
        EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZESTART, GA_ROOTOWNER, WINEVENT_OUTOFCONTEXT,
    };

    static APP: OnceLock<AppHandle> = OnceLock::new();
    /// The state last said: 0 none yet, 1 unfocused, 2 focused.
    static SAID: AtomicU8 = AtomicU8::new(0);

    pub fn focused(window: &WebviewWindow) -> bool {
        let Ok(hwnd) = window.hwnd() else {
            return false;
        };
        let mine = hwnd.0 as HWND;
        // SAFETY: plain queries of window handles; a stale or null handle answers false/null.
        unsafe {
            if IsIconic(mine) != 0 {
                return false;
            }
            let front = GetForegroundWindow();
            !front.is_null()
                && (front == mine
                    || GetAncestor(front, GA_ROOTOWNER) == GetAncestor(mine, GA_ROOTOWNER))
        }
    }

    pub fn follow(app: &AppHandle) {
        if APP.set(app.clone()).is_err() {
            return;
        }
        // SAFETY: out-of-context hooks for this process's UI thread; `changed` only reads
        // statics and asks the OS. They last as long as the process.
        unsafe {
            SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                null_mut(),
                Some(changed),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            SetWinEventHook(
                EVENT_SYSTEM_MINIMIZESTART,
                EVENT_SYSTEM_MINIMIZEEND,
                null_mut(),
                Some(changed),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
        }
    }

    unsafe extern "system" fn changed(
        _hook: HWINEVENTHOOK,
        _event: u32,
        _hwnd: HWND,
        _object: i32,
        _child: i32,
        _thread: u32,
        _time: u32,
    ) {
        let Some(window) = APP.get().and_then(|app| app.get_webview_window("main")) else {
            return;
        };
        let now = focused(&window);
        let code = if now { 2 } else { 1 };
        if SAID.swap(code, Ordering::SeqCst) != code {
            let _ = window.emit(EVENT, now);
        }
    }
}

#[cfg(not(windows))]
mod os {
    use tauri::{AppHandle, WebviewWindow};

    /// Elsewhere, Tauri's own state; changes are not followed (Yavin ships for Windows).
    pub fn focused(window: &WebviewWindow) -> bool {
        window.is_focused().unwrap_or(true)
    }

    pub fn follow(_app: &AppHandle) {}
}
