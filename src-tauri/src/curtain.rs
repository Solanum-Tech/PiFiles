//! A native cover used to hide window changes during a full-screen switch.
//!
//! PiFiles' window is see-through (Mica/glass), so while it changes size the desktop and other
//! apps could show for a few frames. Instead, the current screen is captured and shown in a
//! top-most window (so nothing visibly changes), the switch happens underneath it, and the
//! snapshot then fades out, crossfading into the new layout. No black frame, no background.
//! The cover lives on its own thread with its own message loop, so the app's UI thread and the
//! WebView keep running (and painting) while it is up.

#[cfg(windows)]
mod imp {
    use std::cell::Cell;
    use std::sync::mpsc::{channel, Sender};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use windows::core::w;
    use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::Graphics::Dwm::DwmFlush;
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::*;

    static REVEAL: Mutex<Option<Sender<u32>>> = Mutex::new(None);

    thread_local! {
        /// Memory DC holding the captured screen, painted by the cover window.
        static SNAP: Cell<(isize, i32, i32)> = const { Cell::new((0, 0, 0)) };
    }

    unsafe extern "system" fn proc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        match m {
            // Never take focus or mouse input from the app.
            WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
            WM_ERASEBKGND => LRESULT(1),
            WM_PAINT => {
                let mut ps = PAINTSTRUCT::default();
                let dc = BeginPaint(h, &mut ps);
                let (mem, cw, ch) = SNAP.with(|s| s.get());
                if mem != 0 {
                    let _ = BitBlt(dc, 0, 0, cw, ch, Some(HDC(mem as _)), 0, 0, SRCCOPY);
                } else {
                    FillRect(dc, &ps.rcPaint, HBRUSH(GetStockObject(BLACK_BRUSH).0));
                }
                let _ = EndPaint(h, &ps);
                LRESULT(0)
            }
            _ => DefWindowProcW(h, m, w, l),
        }
    }

    fn ease_out(t: f32) -> f32 {
        1.0 - (1.0 - t).powi(3)
    }

    unsafe fn pump() {
        let mut msg = MSG::default();
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    unsafe fn fade_out(h: HWND, ms: u32) {
        let start = Instant::now();
        let total = ms.max(1) as f32 / 1000.0;
        loop {
            let t = (start.elapsed().as_secs_f32() / total).min(1.0);
            let a = 255.0 * (1.0 - ease_out(t));
            let _ = SetLayeredWindowAttributes(h, COLORREF(0), a.round() as u8, LWA_ALPHA);
            pump();
            if t >= 1.0 {
                break;
            }
            let _ = DwmFlush(); // one step per displayed frame: smooth on any refresh rate
        }
    }

    /// Covers the monitor that `over` is on with a snapshot of what is on screen right now.
    /// Returns once the cover is displayed (about one frame).
    pub fn cover(over: isize, _fade_in_ms: u32) {
        reveal(0); // a previous cover, if any, goes away immediately
        let (ready_tx, ready_rx) = channel::<()>();
        let (reveal_tx, reveal_rx) = channel::<u32>();
        *REVEAL.lock().unwrap() = Some(reveal_tx);
        std::thread::Builder::new()
            .name("fs-cover".into())
            .spawn(move || unsafe {
                let inst = GetModuleHandleW(None).unwrap_or_default();
                let class = w!("PiFilesCover");
                let wc = WNDCLASSW {
                    lpfnWndProc: Some(proc),
                    hInstance: inst.into(),
                    lpszClassName: class,
                    hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                    ..Default::default()
                };
                RegisterClassW(&wc); // fails harmlessly when already registered
                let mon = MonitorFromWindow(HWND(over as _), MONITOR_DEFAULTTONEAREST);
                let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
                let r: RECT = if GetMonitorInfoW(mon, &mut mi).as_bool() { mi.rcMonitor } else { RECT { left: 0, top: 0, right: 1920, bottom: 1080 } };
                let (cw, ch) = (r.right - r.left, r.bottom - r.top);

                // Snapshot of the monitor as it is now (DWM's composed image, so the current video
                // frame and Mica are included).
                let screen = GetDC(None);
                let mem = CreateCompatibleDC(Some(screen));
                let bmp = CreateCompatibleBitmap(screen, cw, ch);
                let old = SelectObject(mem, bmp.into());
                let _ = BitBlt(mem, 0, 0, cw, ch, Some(screen), r.left, r.top, SRCCOPY);
                ReleaseDC(None, screen);
                SNAP.with(|s| s.set((mem.0 as isize, cw, ch)));

                let cleanup = || {
                    SNAP.with(|s| s.set((0, 0, 0)));
                    SelectObject(mem, old);
                    let _ = DeleteObject(bmp.into());
                    let _ = DeleteDC(mem);
                };
                let Ok(h) = CreateWindowExW(
                    WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
                    class,
                    w!(""),
                    WS_POPUP,
                    r.left,
                    r.top,
                    cw,
                    ch,
                    None,
                    None,
                    Some(inst.into()),
                    None,
                ) else {
                    cleanup();
                    let _ = ready_tx.send(());
                    return;
                };
                let _ = SetLayeredWindowAttributes(h, COLORREF(0), 255, LWA_ALPHA);
                let _ = ShowWindow(h, SW_SHOWNOACTIVATE);
                let _ = SetWindowPos(h, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                let _ = UpdateWindow(h); // paint the snapshot now
                pump();
                let _ = DwmFlush(); // ...and wait until it is actually on screen
                let _ = ready_tx.send(());
                // Hold until revealed (or a safety timeout, so the screen can never stay frozen).
                let deadline = Instant::now() + Duration::from_secs(3);
                let out_ms = loop {
                    if let Ok(ms) = reveal_rx.try_recv() {
                        break ms;
                    }
                    if Instant::now() > deadline {
                        break 120;
                    }
                    pump();
                    std::thread::sleep(Duration::from_millis(4));
                };
                if out_ms > 0 {
                    fade_out(h, out_ms);
                }
                let _ = DestroyWindow(h);
                pump();
                cleanup();
            })
            .ok();
        let _ = ready_rx.recv_timeout(Duration::from_millis(400));
    }

    /// Fades the cover out (0 = remove at once).
    pub fn reveal(fade_out_ms: u32) {
        if let Some(tx) = REVEAL.lock().unwrap().take() {
            let _ = tx.send(fade_out_ms);
        }
    }
}

#[cfg(windows)]
pub use imp::{cover, reveal};

#[cfg(not(windows))]
pub fn cover(_over: isize, _fade_in_ms: u32) {}
#[cfg(not(windows))]
pub fn reveal(_fade_out_ms: u32) {}

#[cfg(all(test, windows))]
mod tests {
    /// Shows the snapshot cover for a moment: cargo test --lib curtain -- --ignored --nocapture
    #[test]
    #[ignore]
    fn cover_and_reveal() {
        let desktop = unsafe { windows::Win32::UI::WindowsAndMessaging::GetDesktopWindow() };
        let t = std::time::Instant::now();
        super::cover(desktop.0 as isize, 0);
        println!("cover on screen after {:?}", t.elapsed());
        std::thread::sleep(std::time::Duration::from_millis(150));
        let t = std::time::Instant::now();
        super::reveal(170);
        std::thread::sleep(std::time::Duration::from_millis(400));
        println!("revealed (returned after {:?})", t.elapsed());
    }
}
