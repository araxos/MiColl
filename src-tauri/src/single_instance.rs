//! One MiColl per library.
//!
//! Starting MiColl again (pinned taskbar icon, Start menu) while it runs, maybe hidden in
//! the tray, used to start a second process on the same database. Now the second start
//! hands its command line to the running one and quits: that one shows its window, or
//! opens a new one for "--new-window" / starts "Add rewards" for "--add-rewards" (the
//! taskbar jump list tasks, see jump_list).
//!
//! Keyed by the library, not the app id: a portable copy has its own library next to the
//! exe and runs next to an installed MiColl or the dev build (those two share the
//! AppData library, so they share the lock too).
//!
//! How: a named mutex says "someone runs this library", a hidden message-only window
//! of that instance takes the WM_COPYDATA with the arguments.

#![cfg(windows)]

use std::sync::OnceLock;

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::COPYDATASTRUCT;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, CreateWindowExW, DefWindowProcW, DispatchMessageW, FindWindowExW,
    GetMessageW, GetWindowThreadProcessId, RegisterClassW, SendMessageTimeoutW, HWND_MESSAGE,
    MSG, SMTO_ABORTIFHUNG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_COPYDATA, WNDCLASSW,
};

/// Tag on our WM_COPYDATA ("MC").
const COPYDATA_TAG: usize = 0x4d43;

/// The library key of this process (set by acquire, used by listen).
static KEY: OnceLock<String> = OnceLock::new();
/// What to do with a second start's arguments (set by listen).
static HANDLER: OnceLock<Box<dyn Fn(Vec<String>) + Send + Sync>> = OnceLock::new();

/// Short stable key for a library scope (FNV-1a over the lowercased path).
fn key_for(scope: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in scope.to_lowercase().bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

fn class_name(key: &str) -> HSTRING {
    HSTRING::from(format!("MiColl-instance-{key}"))
}

/// The process that started us (an update or restart relaunches from the old process).
fn parent_pid() -> Option<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let me = std::process::id();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut e = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = None;
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                if e.th32ProcessID == me {
                    found = Some(e.th32ParentProcessID);
                    break;
                }
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        found
    }
}

/// Try to become the instance for this library (scope = the library folder, or a fixed
/// name for the AppData library). false = another MiColl runs it and got our arguments,
/// the caller exits.
pub fn acquire(scope: &str) -> bool {
    let key = key_for(scope);
    let mutex_name = HSTRING::from(format!("Local\\MiColl-instance-{key}"));
    let class = class_name(&key);
    let args: Vec<String> = std::env::args().collect();
    let parent = parent_pid();

    // a restart/update starts us from the old process while it's still exiting, so we
    // wait for it instead of handing over (that would end both)
    for attempt in 0..100 {
        // the handle stays open for the whole process (released when it ends)
        let created = unsafe { CreateMutexW(None, false, &mutex_name) };
        let exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        if created.is_err() {
            break; // no mutex at all, run without the lock
        }
        if !exists {
            let _ = KEY.set(key);
            return true;
        }
        if let Ok(h) = created {
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(h) };
        }
        let hwnd = unsafe { FindWindowExW(Some(HWND_MESSAGE), None, &class, PCWSTR::null()) };
        if let Ok(hwnd) = hwnd {
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
            if Some(pid) != parent && send_args(hwnd, pid, &args) {
                return false;
            }
        }
        // still starting (no window yet) or our own parent exiting: try again shortly
        let _ = attempt;
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    // ~10 s and nobody answered: start anyway rather than not at all
    let _ = KEY.set(key);
    true
}

/// Hand the arguments to the running instance. true = it took them.
fn send_args(hwnd: HWND, pid: u32, args: &[String]) -> bool {
    let payload = args.join("\u{0}");
    let bytes = payload.as_bytes();
    let cds = COPYDATASTRUCT {
        dwData: COPYDATA_TAG,
        cbData: bytes.len() as u32,
        lpData: bytes.as_ptr() as *mut _,
    };
    unsafe {
        // we were started by the user, so we may give the focus right to the running one
        let _ = AllowSetForegroundWindow(pid);
        let mut result = 0usize;
        let sent = SendMessageTimeoutW(
            hwnd,
            WM_COPYDATA,
            WPARAM(0),
            LPARAM(&cds as *const COPYDATASTRUCT as isize),
            SMTO_ABORTIFHUNG,
            5000,
            Some(&mut result),
        );
        sent.0 != 0 && result == 1
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_COPYDATA {
        let cds = &*(lparam.0 as *const COPYDATASTRUCT);
        if cds.dwData != COPYDATA_TAG || cds.lpData.is_null() {
            return LRESULT(0);
        }
        let bytes = std::slice::from_raw_parts(cds.lpData as *const u8, cds.cbData as usize);
        let args: Vec<String> = String::from_utf8_lossy(bytes).split('\u{0}').map(String::from).collect();
        return match HANDLER.get() {
            Some(handler) => {
                handler(args);
                LRESULT(1)
            }
            None => LRESULT(0), // still starting up, the sender tries again
        };
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

/// Take second starts from now on. Call once the app is set up, the handler runs on a
/// background thread.
pub fn listen(handler: impl Fn(Vec<String>) + Send + Sync + 'static) {
    let Some(key) = KEY.get() else { return };
    if HANDLER.set(Box::new(handler)).is_err() {
        return;
    }
    let class = class_name(key);
    std::thread::Builder::new()
        .name("micoll-instance".into())
        .spawn(move || unsafe {
            let Ok(module) = GetModuleHandleW(None) else { return };
            let wc = WNDCLASSW {
                lpfnWndProc: Some(wndproc),
                hInstance: module.into(),
                lpszClassName: PCWSTR(class.as_ptr()),
                ..Default::default()
            };
            if RegisterClassW(&wc) == 0 {
                return;
            }
            let Ok(_hwnd) = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                &class,
                &class,
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                Some(module.into()),
                None,
            ) else {
                return;
            };
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                DispatchMessageW(&msg);
            }
        })
        .ok();
}

/// The taskbar jump list: right-click MiColl's taskbar button -> the tasks (title,
/// argument), each starts MiColl with its argument (handed to the running instance by
/// acquire).
pub fn register_jump_list(tasks: &[(&str, &str)]) {
    let tasks: Vec<(String, String)> =
        tasks.iter().map(|(t, a)| (t.to_string(), a.to_string())).collect();
    std::thread::spawn(move || {
        if let Err(e) = jump_list(&tasks) {
            eprintln!("micoll: jump list not set: {e}");
        }
    });
}

fn jump_list(tasks_in: &[(String, String)]) -> windows::core::Result<()> {
    use windows::core::{Interface, GUID};
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW,
        ShellLink,
    };

    // System.Title, the text the jump list shows for a task
    const PKEY_TITLE: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0xf29f85e0_4ff9_1068_ab91_08002b27b3d9),
        pid: 2,
    };

    let exe = std::env::current_exe().map_err(|_| windows::core::Error::from_win32())?;
    let exe = HSTRING::from(exe.as_os_str());
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let result = (|| {
            let list: ICustomDestinationList =
                CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
            let mut slots = 0u32;
            let _removed: IObjectArray = list.BeginList(&mut slots)?;
            let tasks: IObjectCollection =
                CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
            for (title, arg) in tasks_in {
                let link: IShellLinkW =
                    CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
                link.SetPath(&exe)?;
                link.SetArguments(&HSTRING::from(arg.as_str()))?;
                link.SetIconLocation(&exe, 0)?;
                let store: IPropertyStore = link.cast()?;
                store.SetValue(&PKEY_TITLE, &PROPVARIANT::from(title.as_str()))?;
                store.Commit()?;
                tasks.AddObject(&link)?;
            }
            let array: IObjectArray = tasks.cast()?;
            list.AddUserTasks(&array)?;
            list.CommitList()
        })();
        CoUninitialize();
        result
    }
}
