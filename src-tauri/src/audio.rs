//! Make the Windows volume mixer say "MiColl".
//!
//! Video sound comes from a WebView2 child process, so the mixer shows
//! "Microsoft Edge WebView2". We can't rename that process, but every audio
//! session has a display name and icon we can set. So we go through the sessions
//! on every output device, keep the ones from our process tree and set our name and icon.
//!
//! This only works for sessions that already exist (created when something plays),
//! so claim retries a bit and the frontend calls it when a video starts.
//!
//! Related: Task Manager groups our WebView2 processes as "WebView2 Manager" instead
//! of under MiColl. That's a WebView2 bug
//! (https://github.com/MicrosoftEdge/WebView2Feedback/issues/5628), nothing we can do.
//! If it ever gets fixed, check if we need to change something here.

#![cfg(windows)]

use std::collections::{HashMap, HashSet};

/// All processes started from us (including us).
/// The audio process is a grandchild, so we walk the whole tree.
fn descendants() -> HashSet<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut ours: HashSet<u32> = HashSet::new();
    ours.insert(std::process::id());

    // pid -> parent for every process
    let mut parent: HashMap<u32, u32> = HashMap::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return ours;
        };
        let mut e = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                parent.insert(e.th32ProcessID, e.th32ParentProcessID);
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }

    // go up from each process, if it reaches us it's ours.
    // hop limit in case recycled pids make a loop
    for &pid in parent.keys() {
        let mut cur = pid;
        let mut chain: Vec<u32> = Vec::new();
        for _ in 0..32 {
            if ours.contains(&cur) {
                ours.extend(chain);
                break;
            }
            chain.push(cur);
            match parent.get(&cur) {
                Some(&p) if p != 0 && p != cur => cur = p,
                _ => break,
            }
        }
    }
    ours
}

/// Rename every audio session from us or our child processes. Returns the count.
fn stamp(name: &str) -> windows::core::Result<u32> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::Media::Audio::{
        eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
        MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    let ours = descendants();
    // "<exe>,0" = icon 0 from our exe (the app icon)
    let icon = std::env::current_exe()
        .map(|p| format!("{},0", p.display()))
        .unwrap_or_default();
    let name = HSTRING::from(name);
    let icon = HSTRING::from(icon);

    let mut hits = 0u32;
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        // every active output device, audio can go to a second device
        let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        for i in 0..devices.GetCount()? {
            let Ok(device) = devices.Item(i) else { continue };
            let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                continue;
            };
            let Ok(sessions) = manager.GetSessionEnumerator() else { continue };
            let count = sessions.GetCount().unwrap_or(0);
            for s in 0..count {
                let Ok(ctl) = sessions.GetSession(s) else { continue };
                let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
                // the system sounds session has pid 0
                if ctl2.IsSystemSoundsSession().is_ok() {
                    continue;
                }
                match ctl2.GetProcessId() {
                    Ok(pid) if ours.contains(&pid) => {}
                    _ => continue,
                }
                if ctl2.SetDisplayName(&name, std::ptr::null()).is_ok() {
                    hits += 1;
                }
                let _ = ctl2.SetIconPath(&icon, std::ptr::null());
            }
        }
    }
    Ok(hits)
}

/// Claim our audio sessions, retrying for a moment.
/// The session shows up a bit after playback starts. Runs on its own thread with
/// its own COM apartment so Tauri's threads aren't affected.
pub fn claim(name: &str) -> u32 {
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
    };

    std::thread::scope(|s| {
        s.spawn(|| unsafe {
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let mut hits = 0;
            for attempt in 0..6 {
                if attempt > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
                hits = stamp(name).unwrap_or(0);
                if hits > 0 {
                    break;
                }
            }
            if hr.is_ok() {
                CoUninitialize();
            }
            hits
        })
        .join()
        .unwrap_or(0)
    })
}
