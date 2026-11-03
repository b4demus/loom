//! Plain Win32 windows that hold plugin editors. They are owned by the app window (so they
//! float above it), have a dark title bar, and live on the UI thread, whose message loop
//! (the app's) dispatches their messages.

use std::sync::Once;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
use windows_sys::Win32::Graphics::Gdi::CreateSolidBrush;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

pub trait Events {
    /// the user (or the app) closed the window; detach the editor here
    fn closed(&mut self);
    /// new client size, in pixels
    fn resized(&mut self, _w: i32, _h: i32) {}
    fn timer(&mut self) {}
}

const CLASS: &str = "loomPluginWindow";
const TIMER_ID: usize = 1;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    let ev = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Box<dyn Events>;
    match msg {
        WM_NCCREATE => {
            let cs = lp as *const CREATESTRUCTW;
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, (*cs).lpCreateParams as isize);
        }
        WM_CLOSE => {
            if !ev.is_null() {
                (*ev).closed();
            }
            DestroyWindow(hwnd);
            return 0;
        }
        WM_SIZE => {
            if !ev.is_null() && wp as u32 != SIZE_MINIMIZED {
                (*ev).resized((lp & 0xffff) as i32, ((lp >> 16) & 0xffff) as i32);
            }
        }
        WM_TIMER if wp == TIMER_ID => {
            if !ev.is_null() {
                (*ev).timer();
            }
            return 0;
        }
        WM_NCDESTROY => {
            KillTimer(hwnd, TIMER_ID);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            if !ev.is_null() {
                drop(Box::from_raw(ev));
            }
        }
        _ => {}
    }
    DefWindowProcW(hwnd, msg, wp, lp)
}

fn register() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        let name = wide(CLASS);
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: GetModuleHandleW(std::ptr::null()),
            hIcon: std::ptr::null_mut(),
            hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
            // graphite, like the app: no white flash before the editor paints
            hbrBackground: CreateSolidBrush(0x00141414),
            lpszMenuName: std::ptr::null(),
            lpszClassName: name.as_ptr(),
            hIconSm: std::ptr::null_mut(),
        };
        RegisterClassExW(&wc);
    });
}

fn style(resizable: bool) -> u32 {
    let mut s = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_CLIPCHILDREN;
    if resizable {
        s |= WS_THICKFRAME | WS_MAXIMIZEBOX;
    }
    s
}

/// Window size for a client area of `w`×`h`.
fn outer(w: i32, h: i32, st: u32) -> (i32, i32) {
    let mut r = RECT { left: 0, top: 0, right: w, bottom: h };
    unsafe { AdjustWindowRectEx(&mut r, st, 0, 0) };
    (r.right - r.left, r.bottom - r.top)
}

/// Creates a hidden window; call `show` after the editor is attached.
pub fn create(owner: isize, title: &str, w: i32, h: i32, resizable: bool, timer_ms: u32, ev: Box<dyn Events>) -> Result<isize, String> {
    register();
    let st = style(resizable);
    let (ow, oh) = outer(w.max(80), h.max(40), st);
    // centred over the owner
    let (mut x, mut y) = (CW_USEDEFAULT, CW_USEDEFAULT);
    unsafe {
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        if owner != 0 && GetWindowRect(owner as HWND, &mut r) != 0 {
            x = r.left + ((r.right - r.left) - ow) / 2;
            y = r.top + ((r.bottom - r.top) - oh) / 3;
            x = x.max(r.left);
            y = y.max(r.top);
        }
    }
    let data = Box::into_raw(Box::new(ev));
    let class = wide(CLASS);
    let t = wide(title);
    let hwnd = unsafe {
        CreateWindowExW(0, class.as_ptr(), t.as_ptr(), st, x, y, ow, oh, owner as HWND, std::ptr::null_mut(), GetModuleHandleW(std::ptr::null()), data as *const _)
    };
    if hwnd.is_null() {
        unsafe { drop(Box::from_raw(data)) };
        return Err("could not create the plugin window".into());
    }
    unsafe {
        let dark: i32 = 1;
        // DWMWA_USE_IMMERSIVE_DARK_MODE
        DwmSetWindowAttribute(hwnd, 20, &dark as *const i32 as *const _, 4);
        if timer_ms > 0 {
            SetTimer(hwnd, TIMER_ID, timer_ms, None);
        }
    }
    Ok(hwnd as isize)
}

pub fn show(hwnd: isize) {
    unsafe {
        ShowWindow(hwnd as HWND, SW_SHOWNORMAL);
        SetForegroundWindow(hwnd as HWND);
    }
}

/// Brings a minimised or hidden window back to the front.
pub fn focus(hwnd: isize) {
    unsafe {
        if IsIconic(hwnd as HWND) != 0 {
            ShowWindow(hwnd as HWND, SW_RESTORE);
        }
        SetForegroundWindow(hwnd as HWND);
    }
}

/// Resizes so the client area is `w`×`h`.
pub fn set_client_size(hwnd: isize, w: i32, h: i32) {
    unsafe {
        let st = GetWindowLongW(hwnd as HWND, GWL_STYLE) as u32;
        let (ow, oh) = outer(w, h, st);
        SetWindowPos(hwnd as HWND, std::ptr::null_mut(), 0, 0, ow, oh, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
}

pub fn client_size(hwnd: isize) -> (i32, i32) {
    let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    unsafe { GetClientRect(hwnd as HWND, &mut r) };
    (r.right - r.left, r.bottom - r.top)
}

/// Closes through WM_CLOSE, so `Events::closed` runs exactly as when the user closes it.
pub fn close(hwnd: isize) {
    unsafe {
        if IsWindow(hwnd as HWND) != 0 {
            SendMessageW(hwnd as HWND, WM_CLOSE, 0, 0);
        }
    }
}

pub fn alive(hwnd: isize) -> bool {
    hwnd != 0 && unsafe { IsWindow(hwnd as HWND) != 0 }
}

// ---------- keys typed into plugin windows ----------
// A plugin window has the keyboard focus, so the app's own page never sees those keys. A hook on
// the UI thread (where the plugin windows live) passes the keys loom plays with on to the app,
// as the physical key (scan code), so the keyboard layout does not matter. The plugin still
// gets every key too.

type KeyFn = Box<dyn Fn(&'static str, bool, bool) + Send + Sync>;
static KEY_CB: std::sync::OnceLock<KeyFn> = std::sync::OnceLock::new();

/// Set-1 scan code → the DOM `KeyboardEvent.code` the page uses for that key.
fn scan_name(scan: u32) -> Option<&'static str> {
    Some(match scan {
        0x02 => "Digit1", 0x03 => "Digit2", 0x04 => "Digit3", 0x05 => "Digit4", 0x06 => "Digit5",
        0x07 => "Digit6", 0x08 => "Digit7", 0x09 => "Digit8", 0x0A => "Digit9", 0x0B => "Digit0",
        0x0C => "Minus", 0x0D => "Equal",
        0x10 => "KeyQ", 0x11 => "KeyW", 0x12 => "KeyE", 0x13 => "KeyR", 0x14 => "KeyT",
        0x15 => "KeyY", 0x16 => "KeyU", 0x17 => "KeyI", 0x18 => "KeyO", 0x19 => "KeyP", 0x1A => "BracketLeft",
        0x1E => "KeyA", 0x1F => "KeyS", 0x20 => "KeyD", 0x21 => "KeyF", 0x22 => "KeyG", 0x23 => "KeyH",
        0x24 => "KeyJ", 0x25 => "KeyK", 0x26 => "KeyL", 0x27 => "Semicolon",
        0x2C => "KeyZ", 0x2D => "KeyX", 0x2E => "KeyC", 0x2F => "KeyV", 0x30 => "KeyB", 0x31 => "KeyN",
        0x32 => "KeyM", 0x33 => "Comma", 0x34 => "Period", 0x35 => "Slash",
        0x39 => "Space",
        _ => return None,
    })
}

fn is_plugin_window(h: HWND) -> bool {
    if h.is_null() {
        return false;
    }
    let root = unsafe { GetAncestor(h, GA_ROOT) };
    let mut buf = [0u16; 64];
    let n = unsafe { GetClassNameW(root, buf.as_mut_ptr(), buf.len() as i32) };
    n > 0 && String::from_utf16_lossy(&buf[..n as usize]) == CLASS
}

/// The app's own window (the frame around the page); see `set_main_window`.
static MAIN: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

/// The app's main window. A key that reaches it (rather than the page inside it) means the page
/// lost the keyboard focus — an Alt press does that — so the focus goes back to the page and the
/// key is passed on like a plugin window's.
pub fn set_main_window(hwnd: isize) {
    MAIN.store(hwnd, std::sync::atomic::Ordering::Relaxed);
}

/// Sees every message the UI thread takes from its queue; acts on key messages addressed to a
/// window inside a plugin editor, or to the app's frame instead of its page.
unsafe extern "system" fn key_hook(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_SHIFT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_SETFOCUS, WM_SYSKEYDOWN, WM_SYSKEYUP};
    // HC_ACTION and PM_REMOVE: the message is really being taken (not just peeked at)
    if code == 0 && wp == 1 && lp != 0 {
        let msg = &mut *(lp as *mut MSG);
        let bits = msg.lParam as u32;
        let main = MAIN.load(std::sync::atomic::Ordering::Relaxed);
        let in_main = main != 0 && !msg.hwnd.is_null() && GetAncestor(msg.hwnd, GA_ROOT) as isize == main;
        let frame = main != 0 && msg.hwnd as isize == main;
        let key_msg = matches!(msg.message, WM_KEYDOWN | WM_KEYUP | WM_SYSKEYDOWN | WM_SYSKEYUP);
        // The WebView handles its own shortcuts. Forward these only when focus
        // belongs to a plugin editor or the native frame, and consume them once.
        if msg.message == WM_KEYDOWN && GetKeyState(VK_CONTROL as i32) < 0
            && GetKeyState(VK_MENU as i32) >= 0 && GetKeyState(VK_LWIN as i32) >= 0
            && (frame || is_plugin_window(msg.hwnd)) {
            let shortcut = match scan_name(bits >> 16 & 0xff) {
                Some("KeyZ") if GetKeyState(VK_SHIFT as i32) < 0 => Some("Ctrl+Shift+KeyZ"),
                Some("KeyZ") => Some("Ctrl+KeyZ"),
                Some("KeyY") => Some("Ctrl+KeyY"),
                _ => None,
            };
            if let (Some(name), Some(cb)) = (shortcut, KEY_CB.get()) {
                cb(name, true, bits >> 30 & 1 == 1);
                msg.message = WM_NULL; msg.wParam = 0; msg.lParam = 0;
                return CallNextHookEx(std::ptr::null_mut(), code, wp, lp);
            }
        }
        // Forward Alt+R exactly once. A WebView child also belongs to the main window:
        // leaving this message in the queue would run both the native and DOM handlers.
        // Bit 29 is Windows' Alt context, including when Alt was released before dispatch.
        if msg.message == WM_SYSKEYDOWN && bits & (1 << 29) != 0
            && GetKeyState(VK_CONTROL as i32) >= 0 && GetKeyState(VK_LWIN as i32) >= 0
            && (scan_name(bits >> 16 & 0xff) == Some("KeyR") || (bits >> 16 & 0xff == 0 && msg.wParam == 0x52))
            && (in_main || is_plugin_window(msg.hwnd)) {
            if let Some(cb) = KEY_CB.get() {
                cb(if in_main { "Alt+KeyR" } else { "Plugin+Alt+KeyR" }, true, bits >> 30 & 1 == 1);
                // WH_GETMESSAGE permits replacing a removed message with WM_NULL.
                // It must not reach WebView2 or Windows' menu handling a second time.
                msg.message = WM_NULL;
                msg.wParam = 0;
                msg.lParam = 0;
                return CallNextHookEx(std::ptr::null_mut(), code, wp, lp);
            }
        }
        if frame && key_msg {
            // the page lost the focus: give it back (wry moves it into the page on WM_SETFOCUS)
            PostMessageW(main as HWND, WM_SETFOCUS, 0, 0);
            let down = msg.message == WM_KEYDOWN;
            let modded = GetKeyState(VK_CONTROL as i32) < 0 || GetKeyState(VK_MENU as i32) < 0 || GetKeyState(VK_LWIN as i32) < 0;
            if (down || msg.message == WM_KEYUP) && (!modded || !down) {
                if let (Some(name), Some(cb)) = (scan_name(bits >> 16 & 0xff), KEY_CB.get()) {
                    cb(name, down, down && bits >> 30 & 1 == 1);
                }
            }
        }
        let down = msg.message == WM_KEYDOWN;
        if (down || msg.message == WM_KEYUP) && is_plugin_window(msg.hwnd) {
            let modded = GetKeyState(VK_CONTROL as i32) < 0 || GetKeyState(VK_MENU as i32) < 0 || GetKeyState(VK_LWIN as i32) < 0;
            let repeat = down && bits >> 30 & 1 == 1;
            if !modded || !down {
                if let (Some(name), Some(cb)) = (scan_name(bits >> 16 & 0xff), KEY_CB.get()) {
                    cb(name, down, repeat);
                }
            }
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wp, lp)
}

/// Call once, on the UI thread: `cb(code, down, repeat)` for keys typed while a plugin window
/// has the focus.
pub fn hook_keys(cb: impl Fn(&'static str, bool, bool) + Send + Sync + 'static) {
    if KEY_CB.set(Box::new(cb)).is_ok() {
        unsafe {
            let thread = windows_sys::Win32::System::Threading::GetCurrentThreadId();
            SetWindowsHookExW(WH_GETMESSAGE, Some(key_hook), std::ptr::null_mut(), thread);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn native_alt_r_is_consumed_once_and_keeps_its_window_context() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let received = events.clone();
        assert!(KEY_CB.set(Box::new(move |code, down, repeat| {
            received.lock().unwrap().push((code, down, repeat));
        })).is_ok());
        unsafe {
            let class = wide("STATIC");
            let main = CreateWindowExW(0, class.as_ptr(), class.as_ptr(), 0, 0, 0, 100, 100,
                std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null());
            assert!(!main.is_null());
            let child = CreateWindowExW(0, class.as_ptr(), class.as_ptr(), WS_CHILD, 0, 0, 10, 10,
                main, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null());
            assert!(!child.is_null());
            set_main_window(main as isize);
            register();
            let plugin_class = wide(CLASS);
            let plugin = CreateWindowExW(0, plugin_class.as_ptr(), class.as_ptr(), 0, 0, 0, 100, 100,
                std::ptr::null_mut(), std::ptr::null_mut(), GetModuleHandleW(std::ptr::null()), std::ptr::null());
            assert!(!plugin.is_null());
            let mut msg = MSG { hwnd: child, message: WM_SYSKEYDOWN, wParam: 0x52,
                lParam: 1 | (0x13 << 16) | (1 << 29), ..std::mem::zeroed() };
            key_hook(0, 1, &mut msg as *mut MSG as LPARAM);
            assert_eq!(msg.message, WM_NULL, "the WebView must not also receive Alt+R");
            key_hook(0, 1, &mut msg as *mut MSG as LPARAM);
            assert_eq!(events.lock().unwrap().len(), 1, "dispatching the consumed message cannot toggle twice");
            for (hwnd, repeat) in [(main, false), (plugin, false), (child, true)] {
                msg = MSG { hwnd, message: WM_SYSKEYDOWN, wParam: 0x52,
                    lParam: 1 | (0x13 << 16) | (1 << 29) | if repeat { 1 << 30 } else { 0 }, ..std::mem::zeroed() };
                key_hook(0, 1, &mut msg as *mut MSG as LPARAM);
                assert_eq!(msg.message, WM_NULL);
            }
            assert_eq!(*events.lock().unwrap(), vec![
                ("Alt+KeyR", true, false), ("Alt+KeyR", true, false),
                ("Plugin+Alt+KeyR", true, false), ("Alt+KeyR", true, true),
            ]);
            msg = MSG { hwnd: child, message: WM_KEYDOWN, wParam: 0x20,
                lParam: 1 | (0x39 << 16), ..std::mem::zeroed() };
            key_hook(0, 1, &mut msg as *mut MSG as LPARAM);
            assert_eq!(events.lock().unwrap().len(), 4, "page-owned Space must not be forwarded twice either");
            msg = MSG { hwnd: child, message: WM_SYSKEYDOWN, wParam: 0x52,
                lParam: 1 | (0x13 << 16) | (1 << 29), ..std::mem::zeroed() };
            key_hook(0, 0, &mut msg as *mut MSG as LPARAM);
            assert_eq!(msg.message, WM_SYSKEYDOWN, "peeking at a message must not consume it");
            {
                use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetKeyboardState, SetKeyboardState, VK_CONTROL, VK_SHIFT};
                struct RestoreKeys([u8; 256]);
                impl Drop for RestoreKeys { fn drop(&mut self) { unsafe { SetKeyboardState(self.0.as_ptr()); } } }
                let mut saved = [0u8; 256]; assert_ne!(GetKeyboardState(saved.as_mut_ptr()), 0);
                let _restore = RestoreKeys(saved);
                for (hwnd, scan, shifted, expected) in [
                    (plugin, 0x2c, false, Some("Ctrl+KeyZ")),
                    (main, 0x2c, true, Some("Ctrl+Shift+KeyZ")),
                    (plugin, 0x15, false, Some("Ctrl+KeyY")),
                    (child, 0x2c, false, None),
                ] {
                    let mut keys = [0u8; 256]; keys[VK_CONTROL as usize] = 0x80;
                    if shifted { keys[VK_SHIFT as usize] = 0x80; }
                    assert_ne!(SetKeyboardState(keys.as_ptr()), 0);
                    let count = events.lock().unwrap().len();
                    msg = MSG { hwnd, message: WM_KEYDOWN, wParam: 0x5a, lParam: 1 | (scan << 16), ..std::mem::zeroed() };
                    key_hook(0, 1, &mut msg as *mut MSG as LPARAM);
                    if let Some(name) = expected {
                        assert_eq!(msg.message, WM_NULL);
                        assert_eq!(events.lock().unwrap().last().unwrap().0, name);
                        key_hook(0, 1, &mut msg as *mut MSG as LPARAM);
                        assert_eq!(events.lock().unwrap().len(), count + 1);
                    } else {
                        assert_eq!(msg.message, WM_KEYDOWN, "page shortcuts stay with the DOM");
                        assert_eq!(events.lock().unwrap().len(), count);
                    }
                }
            }
            set_main_window(0);
            DestroyWindow(plugin);
            DestroyWindow(main);
        }
    }
}
