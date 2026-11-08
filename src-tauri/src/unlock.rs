//! Who keeps a file open when a delete fails, and freeing it from the COM Surrogate.
//!
//! dllhost.exe ("COM Surrogate") runs Explorer's thumbnail and property handlers outside
//! Explorer, and sometimes holds a file for minutes after it's done with it. It's made to
//! be ended (Windows starts it again when it needs one), so a delete ends exactly the
//! surrogates holding its files and tries again. Any other program is only named.
//! The Restart Manager says who holds a file, the same thing Explorer's "file in use"
//! dialog asks.

use std::path::{Path, PathBuf};

/// Files asked about in a folder at most (a creator can have tens of thousands).
const CAP: usize = 4000;

/// What freeing a path did.
#[derive(Debug, PartialEq)]
pub enum Freed {
    /// Only COM Surrogates held it, this many were ended.
    Surrogates(usize),
    /// These programs hold it, nothing was ended.
    Others(Vec<String>),
    /// Nobody holds a file there, the delete failed for another reason.
    Nobody,
}

/// The files a delete of this path touches: the path itself, or a folder's files.
fn files_of(path: &Path) -> Vec<PathBuf> {
    if !path.is_dir() {
        return vec![path.to_path_buf()];
    }
    let mut out = Vec::new();
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            match e.file_type() {
                Ok(t) if t.is_dir() => stack.push(p),
                Ok(_) => out.push(p),
                Err(_) => {}
            }
            if out.len() >= CAP {
                return out;
            }
        }
    }
    out
}

/// A COM Surrogate: dllhost.exe from the Windows folder (not a program that only
/// borrowed the name).
fn is_surrogate(exe: &str) -> bool {
    let low = exe.to_ascii_lowercase().replace('/', "\\");
    let windir = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into()).to_ascii_lowercase();
    [r"\system32\dllhost.exe", r"\syswow64\dllhost.exe"]
        .iter()
        .any(|tail| low == format!("{windir}{tail}"))
}

/// After a failed delete: end the surrogates holding files under path, if they're the
/// only ones holding any.
#[cfg(windows)]
pub fn free(path: &Path) -> Freed {
    let files = files_of(path);
    let held = win::lockers(&files);
    if held.is_empty() {
        return Freed::Nobody;
    }
    let (surrogates, others): (Vec<_>, Vec<_>) = held.into_iter().partition(|l| is_surrogate(&l.exe));
    if !others.is_empty() {
        let mut names: Vec<String> = others.into_iter().map(|l| l.name).collect();
        names.sort();
        names.dedup();
        return Freed::Others(names);
    }
    let ended = surrogates.iter().filter(|l| win::end(l)).count();
    if ended == 0 { Freed::Nobody } else { Freed::Surrogates(ended) }
}

#[cfg(not(windows))]
pub fn free(_path: &Path) -> Freed {
    Freed::Nobody
}

#[cfg(windows)]
mod win {
    use std::path::PathBuf;
    use windows::core::{HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_MORE_DATA, ERROR_SUCCESS, FILETIME, HANDLE};
    use windows::Win32::System::RestartManager::{
        RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY, RM_PROCESS_INFO,
        RM_UNIQUE_PROCESS,
    };
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    /// A process holding one of the files.
    pub struct Locker {
        pub process: RM_UNIQUE_PROCESS,
        /// What Windows calls it ("COM Surrogate", "Photos" …).
        pub name: String,
        /// Its exe, empty if it can't be read.
        pub exe: String,
    }

    fn wide_str(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    /// The process's exe, or "" (another user's process, gone already …).
    fn exe_of(h: HANDLE) -> String {
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        unsafe {
            if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok() {
                return String::from_utf16_lossy(&buf[..len as usize]);
            }
        }
        String::new()
    }

    /// Is the process behind h still the one Restart Manager meant (pids get reused)?
    fn same_start(h: HANDLE, want: FILETIME) -> bool {
        let (mut created, mut exited, mut kernel, mut user) =
            (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        unsafe { GetProcessTimes(h, &mut created, &mut exited, &mut kernel, &mut user) }.is_ok()
            && created.dwLowDateTime == want.dwLowDateTime
            && created.dwHighDateTime == want.dwHighDateTime
    }

    /// The processes that hold any of these files, never this one.
    pub fn lockers(files: &[PathBuf]) -> Vec<Locker> {
        if files.is_empty() {
            return Vec::new();
        }
        let names: Vec<HSTRING> = files.iter().map(|f| HSTRING::from(f.as_os_str())).collect();
        let ptrs: Vec<PCWSTR> = names.iter().map(|h| PCWSTR(h.as_ptr())).collect();
        let mut session = 0u32;
        let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
        unsafe {
            if RmStartSession(&mut session, None, PWSTR(key.as_mut_ptr())) != ERROR_SUCCESS {
                return Vec::new();
            }
            let mut out = Vec::new();
            if RmRegisterResources(session, Some(&ptrs), None, None) == ERROR_SUCCESS {
                let mut infos: Vec<RM_PROCESS_INFO> = Vec::new();
                // the list can grow between the two calls, so ask again a few times
                for _ in 0..4 {
                    let (mut needed, mut count, mut reasons) = (0u32, infos.len() as u32, 0u32);
                    let ptr = if infos.is_empty() { None } else { Some(infos.as_mut_ptr()) };
                    let r = RmGetList(session, &mut needed, &mut count, ptr, &mut reasons);
                    if r == ERROR_SUCCESS {
                        infos.truncate(count as usize);
                        break;
                    }
                    if r != ERROR_MORE_DATA {
                        infos.clear();
                        break;
                    }
                    infos = vec![RM_PROCESS_INFO::default(); needed as usize];
                }
                let me = std::process::id();
                for info in infos.into_iter().filter(|i| i.Process.dwProcessId != me) {
                    let exe = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, info.Process.dwProcessId) {
                        Ok(h) => {
                            let exe = if same_start(h, info.Process.ProcessStartTime) { exe_of(h) } else { String::new() };
                            let _ = CloseHandle(h);
                            exe
                        }
                        Err(_) => String::new(),
                    };
                    let mut name = wide_str(&info.strAppName);
                    if name.is_empty() {
                        name = exe.rsplit('\\').next().unwrap_or("").to_string();
                    }
                    out.push(Locker { process: info.Process, name, exe });
                }
            }
            let _ = RmEndSession(session);
            out
        }
    }

    /// End this process if it's still the same one, and wait for it to let go.
    pub fn end(l: &Locker) -> bool {
        unsafe {
            let Ok(h) = OpenProcess(
                PROCESS_TERMINATE | PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                l.process.dwProcessId,
            ) else {
                return false;
            };
            let ok = same_start(h, l.process.ProcessStartTime) && TerminateProcess(h, 1).is_ok();
            if ok {
                // its handles close as it exits
                let _ = WaitForSingleObject(h, 3000);
            }
            let _ = CloseHandle(h);
            ok
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_windows_dllhost_is_a_surrogate() {
        let windir = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        assert!(is_surrogate(&format!(r"{windir}\System32\dllhost.exe")));
        assert!(is_surrogate(&format!(r"{windir}\SysWOW64\DLLHOST.EXE")));
        assert!(!is_surrogate(r"C:\Users\x\Downloads\dllhost.exe"));
        assert!(!is_surrogate(&format!(r"{windir}\System32\notepad.exe")));
        assert!(!is_surrogate(""));
    }

    /// A file this test holds open is found, and nothing is ended for it: the holder is
    /// this process, which never counts.
    #[test]
    fn a_free_file_has_nobody_holding_it() {
        let dir = std::env::temp_dir().join(format!("micoll-unlock-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("a.jpg"), b"x").unwrap();
        assert_eq!(files_of(&dir).len(), 1);
        assert_eq!(free(&dir), Freed::Nobody);
        let _held = std::fs::File::open(dir.join("sub").join("a.jpg")).unwrap();
        assert_eq!(free(&dir), Freed::Nobody, "our own handle never ends anything");
        drop(_held);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Another program holding a file is named and left running.
    #[cfg(windows)]
    #[test]
    fn another_program_is_named_and_left_alone() {
        let dir = std::env::temp_dir().join(format!("micoll-unlock-other-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("held.jpg");
        std::fs::write(&file, b"x").unwrap();
        // a PowerShell that opens the file without delete sharing and waits
        let script = format!(
            "$f=[IO.File]::Open('{}','Open','Read','Read'); Start-Sleep -Seconds 20",
            file.display()
        );
        let mut child = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .spawn()
            .unwrap();
        let mut freed = Freed::Nobody;
        for _ in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(250));
            freed = free(&dir);
            if freed != Freed::Nobody {
                break;
            }
        }
        let alive = child.try_wait().unwrap().is_none();
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(matches!(freed, Freed::Others(ref n) if !n.is_empty()), "{freed:?}");
        assert!(alive, "the other program must not be ended");
    }

    /// Ending a holder (what a surrogate gets) frees the file: run on a PowerShell here,
    /// a real dllhost.exe can't be made to hold a file on purpose.
    #[cfg(windows)]
    #[test]
    fn ending_a_holder_frees_its_file() {
        let dir = std::env::temp_dir().join(format!("micoll-unlock-end-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("held.jpg");
        std::fs::write(&file, b"x").unwrap();
        let script = format!(
            "$f=[IO.File]::Open('{}','Open','Read','Read'); Start-Sleep -Seconds 20",
            file.display()
        );
        let mut child = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .spawn()
            .unwrap();
        let mut held = Vec::new();
        for _ in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(250));
            held = win::lockers(&[file.clone()]);
            if !held.is_empty() {
                break;
            }
        }
        assert_eq!(held.len(), 1);
        assert!(held[0].exe.to_ascii_lowercase().ends_with("powershell.exe"), "{}", held[0].exe);
        assert!(std::fs::remove_file(&file).is_err(), "held files can't go");
        assert!(win::end(&held[0]));
        assert!(child.try_wait().unwrap().is_some(), "it was ended");
        assert!(std::fs::remove_file(&file).is_ok(), "and the file is free");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
