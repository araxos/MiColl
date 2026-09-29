//! Windows file properties (Title / Subject / Rating / Tags / Comments) through the
//! Shell Property System, the same fields as Explorer's Properties -> Details.
//! They're saved in the file itself, so other apps see them too.
//! Encrypted files have no readable properties, callers check that first.

/// The editable properties for the viewer's Details -> Advanced. rating = 0 or 1-5 stars.
#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileProps {
    pub title: String,
    pub subject: String,
    pub rating: u32,
    pub tags: Vec<String>,
    pub comments: String,
}

/// Which properties to clear in bulk. The lower group is "notable" metadata
/// (camera, location, author) that can leak info.
#[derive(serde::Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PropFields {
    pub title: bool,
    pub subject: bool,
    pub rating: bool,
    pub tags: bool,
    pub comments: bool,
    pub authors: bool,
    pub copyright: bool,
    pub camera: bool,
    pub date_taken: bool,
    pub gps: bool,
}

/// All properties we show, for the "delete metadata" preview.
#[derive(serde::Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MetaRead {
    pub title: String,
    pub subject: String,
    pub rating: u32,
    pub tags: Vec<String>,
    pub comments: String,
    pub authors: String,
    pub copyright: String,
    pub camera_maker: String,
    pub camera_model: String,
    pub date_taken: String,
    pub gps: String,
}

/// Stars <-> the 0-99 System.Rating scale Explorer uses.
fn stars_to_rating(stars: u32) -> u32 {
    match stars {
        1 => 1,
        2 => 25,
        3 => 50,
        4 => 75,
        n if n >= 5 => 99,
        _ => 0,
    }
}
fn rating_to_stars(v: u32) -> u32 {
    match v {
        0 => 0,
        1..=12 => 1,
        13..=37 => 2,
        38..=62 => 3,
        63..=87 => 4,
        _ => 5,
    }
}

#[cfg(windows)]
mod imp {
    use super::{rating_to_stars, stars_to_rating, FileProps};
    use std::ffi::c_void;
    use windows::core::{HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::System::Com::StructuredStorage::{
        InitPropVariantFromStringVector, PropVariantClear, PropVariantToStringAlloc,
        PropVariantToUInt32, PROPVARIANT,
    };
    use windows::Win32::System::Com::{
        CoInitializeEx, CoTaskMemAlloc, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Variant::{VT_LPWSTR, VT_UI4};
    use windows::Win32::UI::Shell::PropertiesSystem::{
        IPropertyStore, PSGetPropertyKeyFromName, SHGetPropertyStoreFromParsingName,
        GETPROPERTYSTOREFLAGS, GPS_READWRITE,
    };
    // read from the default (read-only) store, it also has Title/Tags for read-only
    // handlers.
    // GPS_DEFAULT isn't exported in this binding, so use 0.
    #[allow(non_upper_case_globals)]
    const GPS_DEFAULT: GETPROPERTYSTOREFLAGS = GETPROPERTYSTOREFLAGS(0);

    unsafe fn pkey(name: &str) -> windows::core::Result<PROPERTYKEY> {
        let mut key = PROPERTYKEY::default();
        PSGetPropertyKeyFromName(&HSTRING::from(name), &mut key)?;
        Ok(key)
    }

    unsafe fn open_store(
        path: &str,
        flags: GETPROPERTYSTOREFLAGS,
    ) -> windows::core::Result<IPropertyStore> {
        SHGetPropertyStoreFromParsingName(&HSTRING::from(path), None, flags)
    }

    /// Run f on its own STA thread. Shell handlers need an STA, but Tauri's threads
    /// may already be MTA, then nothing gets read.
    fn run_sta<T: Send, F: FnOnce() -> T + Send>(f: F) -> T {
        std::thread::scope(|s| {
            s.spawn(|| unsafe {
                let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                let out = f();
                if hr.is_ok() {
                    CoUninitialize();
                }
                out
            })
            .join()
            .unwrap()
        })
    }

    /// VT_LPWSTR PROPVARIANT with a CoTaskMem copy of s (freed by PropVariantClear).
    unsafe fn pv_string(s: &str) -> PROPVARIANT {
        let wide: Vec<u16> = s.encode_utf16().chain(std::iter::once(0)).collect();
        let ptr = CoTaskMemAlloc(wide.len() * 2) as *mut u16;
        if !ptr.is_null() {
            std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
        }
        let mut pv = PROPVARIANT::default();
        let v = &mut *pv.Anonymous.Anonymous;
        v.vt = VT_LPWSTR;
        v.Anonymous.pwszVal = PWSTR(ptr);
        pv
    }

    /// VT_UI4 PROPVARIANT with n.
    unsafe fn pv_u32(n: u32) -> PROPVARIANT {
        let mut pv = PROPVARIANT::default();
        let v = &mut *pv.Anonymous.Anonymous;
        v.vt = VT_UI4;
        v.Anonymous.ulVal = n;
        pv
    }

    unsafe fn set_value(store: &IPropertyStore, name: &str, mut pv: PROPVARIANT) -> windows::core::Result<()> {
        let key = pkey(name)?;
        let r = store.SetValue(&key, &pv);
        let _ = PropVariantClear(&mut pv);
        r
    }

    unsafe fn set_tags(store: &IPropertyStore, tags: &[String]) -> windows::core::Result<()> {
        let key = pkey("System.Keywords")?;
        let wide: Vec<HSTRING> = tags.iter().map(HSTRING::from).collect();
        let ptrs: Vec<PCWSTR> = wide.iter().map(|h| PCWSTR(h.as_ptr())).collect();
        let mut pv = InitPropVariantFromStringVector(Some(&ptrs))?;
        let r = store.SetValue(&key, &pv);
        let _ = PropVariantClear(&mut pv);
        r
    }

    unsafe fn read_string(store: &IPropertyStore, name: &str) -> String {
        let Ok(key) = pkey(name) else { return String::new() };
        let Ok(mut pv) = store.GetValue(&key) else { return String::new() };
        let out = PropVariantToStringAlloc(&pv)
            .ok()
            .map(|pw| {
                let s = pw.to_string().unwrap_or_default();
                CoTaskMemFree(Some(pw.0 as *const c_void));
                s
            })
            .unwrap_or_default();
        let _ = PropVariantClear(&mut pv);
        out
    }

    unsafe fn read_u32(store: &IPropertyStore, name: &str) -> u32 {
        let Ok(key) = pkey(name) else { return 0 };
        let Ok(mut pv) = store.GetValue(&key) else { return 0 };
        let n = PropVariantToUInt32(&pv).unwrap_or(0);
        let _ = PropVariantClear(&mut pv);
        n
    }

    fn split_tags(joined: &str) -> Vec<String> {
        joined
            .split(';')
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect()
    }

    pub fn read(path: &str) -> Result<FileProps, String> {
        run_sta(|| unsafe {
            let store = open_store(path, GPS_DEFAULT).map_err(|e| e.message())?;
            Ok(FileProps {
                title: read_string(&store, "System.Title"),
                subject: read_string(&store, "System.Subject"),
                rating: rating_to_stars(read_u32(&store, "System.Rating")),
                tags: split_tags(&read_string(&store, "System.Keywords")),
                comments: read_string(&store, "System.Comment"),
            })
        })
    }

    /// Remove a property by setting VT_EMPTY.
    unsafe fn clear_value(store: &IPropertyStore, name: &str) -> windows::core::Result<()> {
        let key = pkey(name)?;
        let pv = PROPVARIANT::default(); // VT_EMPTY
        store.SetValue(&key, &pv)
    }

    pub fn read_all(path: &str) -> Result<super::MetaRead, String> {
        run_sta(|| unsafe {
            let store = open_store(path, GPS_DEFAULT).map_err(|e| e.message())?;
            let lat = read_string(&store, "System.GPS.Latitude");
            let lon = read_string(&store, "System.GPS.Longitude");
            let lat_dec = read_string(&store, "System.GPS.LatitudeDecimal");
            let gps = if !lat.is_empty() || !lon.is_empty() {
                format!("{} {}", lat, lon).trim().to_string()
            } else {
                lat_dec
            };
            Ok(super::MetaRead {
                title: read_string(&store, "System.Title"),
                subject: read_string(&store, "System.Subject"),
                rating: rating_to_stars(read_u32(&store, "System.Rating")),
                tags: split_tags(&read_string(&store, "System.Keywords")),
                comments: read_string(&store, "System.Comment"),
                authors: read_string(&store, "System.Author"),
                copyright: read_string(&store, "System.Copyright"),
                camera_maker: read_string(&store, "System.Photo.CameraManufacturer"),
                camera_model: read_string(&store, "System.Photo.CameraModel"),
                date_taken: read_string(&store, "System.Photo.DateTaken"),
                gps,
            })
        })
    }

    pub fn clear(path: &str, f: &super::PropFields) -> Result<(), String> {
        run_sta(|| unsafe {
            // each field is best effort, only the final Commit decides if it worked
            (|| -> windows::core::Result<()> {
                let store = open_store(path, GPS_READWRITE)?;
                if f.title {
                    let _ = clear_value(&store, "System.Title");
                }
                if f.subject {
                    let _ = clear_value(&store, "System.Subject");
                }
                if f.comments {
                    let _ = clear_value(&store, "System.Comment");
                }
                if f.rating {
                    let _ = clear_value(&store, "System.Rating");
                }
                if f.tags {
                    let _ = clear_value(&store, "System.Keywords");
                }
                if f.authors {
                    let _ = clear_value(&store, "System.Author");
                }
                if f.copyright {
                    let _ = clear_value(&store, "System.Copyright");
                }
                if f.camera {
                    let _ = clear_value(&store, "System.Photo.CameraManufacturer");
                    let _ = clear_value(&store, "System.Photo.CameraModel");
                }
                if f.date_taken {
                    let _ = clear_value(&store, "System.Photo.DateTaken");
                }
                if f.gps {
                    for k in [
                        "System.GPS.Latitude",
                        "System.GPS.Longitude",
                        "System.GPS.LatitudeRef",
                        "System.GPS.LongitudeRef",
                        "System.GPS.LatitudeDecimal",
                        "System.GPS.LongitudeDecimal",
                        "System.GPS.Altitude",
                    ] {
                        let _ = clear_value(&store, k);
                    }
                }
                store.Commit()
            })()
            .map_err(|e| e.message())
        })
    }

    pub fn write(path: &str, props: &FileProps) -> Result<(), String> {
        run_sta(|| unsafe {
            (|| -> windows::core::Result<()> {
                let store = open_store(path, GPS_READWRITE)?;
                set_value(&store, "System.Title", pv_string(&props.title))?;
                set_value(&store, "System.Subject", pv_string(&props.subject))?;
                set_value(&store, "System.Comment", pv_string(&props.comments))?;
                set_value(&store, "System.Rating", pv_u32(stars_to_rating(props.rating)))?;
                set_tags(&store, &props.tags)?;
                store.Commit()
            })()
            .map_err(|e| e.message())
        })
    }
}

#[cfg(not(windows))]
mod imp {
    use super::FileProps;
    pub fn read(_path: &str) -> Result<FileProps, String> {
        Err("File properties are only available on Windows.".into())
    }
    pub fn write(_path: &str, _props: &FileProps) -> Result<(), String> {
        Err("File properties are only available on Windows.".into())
    }
    pub fn clear(_path: &str, _f: &super::PropFields) -> Result<(), String> {
        Err("File properties are only available on Windows.".into())
    }
    pub fn read_all(_path: &str) -> Result<super::MetaRead, String> {
        Err("File properties are only available on Windows.".into())
    }
}

pub use imp::{clear, read, read_all, write};
