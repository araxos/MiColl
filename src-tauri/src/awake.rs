//! Keeps Windows from falling asleep by itself while something long runs (a MiSD
//! transport, an import, encrypting, AI work). The screen may still go off, and a sleep
//! the user asks for still happens.
//!
//! A power request and not SetThreadExecutionState(ES_CONTINUOUS): that one belongs to
//! the thread that set it, and a command goes on on another thread after every await.

/// Held for as long as the work runs, dropped (also on an error or a panic) it lets
/// Windows sleep again.
#[must_use]
pub struct Awake(#[cfg_attr(not(windows), allow(dead_code))] Option<isize>);

/// `what` is shown by `powercfg /requests`.
#[cfg(windows)]
pub fn hold(what: &str) -> Awake {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Power::{PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest};
    use windows::Win32::System::Threading::{POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0};

    let mut text: Vec<u16> = format!("MiColl: {what}").encode_utf16().chain(Some(0)).collect();
    let context = REASON_CONTEXT {
        Version: 0,
        Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
        // Windows makes its own copy
        Reason: REASON_CONTEXT_0 { SimpleReasonString: PWSTR(text.as_mut_ptr()) },
    };
    unsafe {
        let Ok(request) = PowerCreateRequest(&context) else {
            return Awake(None);
        };
        if PowerSetRequest(request, PowerRequestSystemRequired).is_err() {
            let _ = CloseHandle(request);
            return Awake(None);
        }
        Awake(Some(request.0 as isize))
    }
}

#[cfg(not(windows))]
pub fn hold(_what: &str) -> Awake {
    Awake(None)
}

#[cfg(windows)]
impl Drop for Awake {
    fn drop(&mut self) {
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        use windows::Win32::System::Power::{
            PowerClearRequest, PowerRequestSystemRequired, SetThreadExecutionState, ES_SYSTEM_REQUIRED,
        };
        let Some(raw) = self.0.take() else { return };
        let request = HANDLE(raw as *mut core::ffi::c_void);
        unsafe {
            // the idle time starts over: work made of several commands (an import, a batch
            // of upscales) doesn't fall asleep between two of them
            SetThreadExecutionState(ES_SYSTEM_REQUIRED);
            let _ = PowerClearRequest(request, PowerRequestSystemRequired);
            let _ = CloseHandle(request);
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// Commands hold it across awaits, on whatever thread they go on.
    #[test]
    fn it_can_move_between_threads_and_be_held_twice() {
        let a = hold("test a");
        let b = hold("test b");
        assert!(a.0.is_some() && b.0.is_some());
        assert_ne!(a.0, b.0);
        std::thread::spawn(move || drop(a)).join().unwrap();
        drop(b);
    }
}
