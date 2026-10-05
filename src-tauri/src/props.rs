//! Full item properties, like Explorer's / Finder's Properties dialog.
//!
//! General facts (type, size on disk, timestamps, attributes, owner, default app) come from
//! the file system. On Windows the Details come from the shell property system - the same
//! source as Explorer's Details tab - so cameras, lenses, GPS, media, document authors, etc.
//! all appear without per-format parsing. Other platforms fall back to EXIF for photos.

use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Default)]
pub struct PropGroup {
    pub title: String,
    pub items: Vec<(String, String)>,
}

#[derive(Serialize, Default)]
pub struct DriveProps {
    pub label: String,
    pub file_system: String,
    pub serial: String,
    pub total: u64,
    pub free: u64,
    pub drive_type: String,
}

#[derive(Serialize, Default)]
pub struct Props {
    pub name: String,
    pub path: String,
    /// "file", "folder" or "drive"
    pub kind: String,
    pub type_name: String,
    pub location: String,
    pub size: u64,
    pub size_on_disk: Option<u64>,
    pub created: Option<u64>,
    pub modified: Option<u64>,
    pub accessed: Option<u64>,
    pub attributes: Vec<String>,
    pub readonly: bool,
    pub hidden: bool,
    pub owner: Option<String>,
    pub opens_with: Option<String>,
    pub link_target: Option<String>,
    pub drive: Option<DriveProps>,
    pub details: Vec<PropGroup>,
}

#[derive(Serialize, Default)]
pub struct FolderStats {
    pub files: u64,
    pub folders: u64,
    pub size: u64,
    pub size_on_disk: u64,
}

fn ms(t: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    t.ok()?.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

fn is_drive_root(path: &str) -> bool {
    let b = path.as_bytes();
    (b.len() == 2 || (b.len() == 3 && (b[2] == b'\\' || b[2] == b'/'))) && b[0].is_ascii_alphabetic() && b[1] == b':'
}

pub fn properties(path: &str) -> Result<Props, String> {
    let p = Path::new(path);
    let meta = std::fs::symlink_metadata(p).map_err(|e| format!("Can't read properties: {e}"))?;
    let drive = is_drive_root(path);
    let mut out = Props {
        name: if drive { path[..2].to_uppercase() } else { p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string()) },
        path: path.to_string(),
        kind: if drive { "drive" } else if meta.is_dir() { "folder" } else { "file" }.into(),
        location: p.parent().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        size: if meta.is_file() { meta.len() } else { 0 },
        created: ms(meta.created()),
        modified: ms(meta.modified()),
        accessed: ms(meta.accessed()),
        readonly: meta.permissions().readonly(),
        ..Default::default()
    };
    if meta.file_type().is_symlink() {
        out.link_target = std::fs::read_link(p).ok().map(|t| t.to_string_lossy().into_owned());
    }
    platform::fill(path, &meta, &mut out);
    if out.type_name.is_empty() {
        out.type_name = match out.kind.as_str() {
            "drive" => "Drive".into(),
            "folder" => "File folder".into(),
            _ => p.extension().map(|e| format!("{} File", e.to_string_lossy().to_uppercase())).unwrap_or_else(|| "File".into()),
        };
    }
    if out.details.is_empty() && meta.is_file() {
        out.details = exif_details(p);
    }
    Ok(out)
}

/// Portable photo details (used where the OS property system isn't available).
fn exif_details(p: &Path) -> Vec<PropGroup> {
    let Ok(f) = std::fs::File::open(p) else { return vec![] };
    let Ok(ex) = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(f)) else { return vec![] };
    let mut camera = PropGroup { title: "Camera".into(), ..Default::default() };
    let mut image = PropGroup { title: "Image".into(), ..Default::default() };
    for fld in ex.fields() {
        let label = match fld.tag {
            exif::Tag::Make => "Camera maker",
            exif::Tag::Model => "Camera model",
            exif::Tag::LensModel => "Lens model",
            exif::Tag::FNumber => "F-stop",
            exif::Tag::ExposureTime => "Exposure time",
            exif::Tag::PhotographicSensitivity => "ISO speed",
            exif::Tag::FocalLength => "Focal length",
            exif::Tag::FocalLengthIn35mmFilm => "35mm focal length",
            exif::Tag::ExposureBiasValue => "Exposure bias",
            exif::Tag::Flash => "Flash",
            exif::Tag::MeteringMode => "Metering mode",
            exif::Tag::WhiteBalance => "White balance",
            exif::Tag::DateTimeOriginal => "Date taken",
            exif::Tag::PixelXDimension => "Width",
            exif::Tag::PixelYDimension => "Height",
            exif::Tag::Orientation => "Orientation",
            exif::Tag::ColorSpace => "Color representation",
            exif::Tag::Software => "Program name",
            exif::Tag::Artist => "Authors",
            exif::Tag::Copyright => "Copyright",
            _ => continue,
        };
        if fld.ifd_num != exif::In::PRIMARY {
            continue;
        }
        let v = fld.display_value().with_unit(&ex).to_string().trim_matches('"').trim().to_string();
        if v.is_empty() {
            continue;
        }
        let g = if matches!(fld.tag, exif::Tag::PixelXDimension | exif::Tag::PixelYDimension | exif::Tag::Orientation | exif::Tag::ColorSpace | exif::Tag::Software | exif::Tag::Artist | exif::Tag::Copyright) { &mut image } else { &mut camera };
        g.items.push((label.into(), v));
    }
    [camera, image].into_iter().filter(|g| !g.items.is_empty()).collect()
}

pub fn folder_stats(path: &str) -> FolderStats {
    let cluster = platform::cluster_size(path).max(1);
    let mut s = FolderStats::default();
    for e in walkdir::WalkDir::new(path).follow_links(false).min_depth(1).into_iter().filter_map(|e| e.ok()) {
        if e.file_type().is_dir() {
            s.folders += 1;
        } else {
            s.files += 1;
            let len = e.metadata().map(|m| m.len()).unwrap_or(0);
            s.size += len;
            s.size_on_disk += len.div_ceil(cluster) * cluster;
        }
    }
    s
}

pub fn sha256(path: &str) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Sets or clears the read-only / hidden attributes (the two checkboxes on the General tab).
pub fn set_attributes(path: &str, readonly: Option<bool>, hidden: Option<bool>) -> Result<(), String> {
    if let Some(ro) = readonly {
        let mut perm = std::fs::metadata(path).map_err(|e| e.to_string())?.permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perm.set_readonly(ro);
        std::fs::set_permissions(path, perm).map_err(|e| e.to_string())?;
    }
    if let Some(h) = hidden {
        platform::set_hidden(path, h)?;
    }
    Ok(())
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::os::windows::fs::MetadataExt;
    use windows::core::{Interface, HSTRING, PCWSTR, PWSTR};
    use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED};

    fn take(p: PWSTR) -> String {
        if p.is_null() {
            return String::new();
        }
        let s = unsafe { p.to_string().unwrap_or_default() };
        unsafe { CoTaskMemFree(Some(p.0 as _)) };
        s
    }

    pub fn cluster_size(path: &str) -> u64 {
        use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceW;
        let root: String = if path.len() >= 2 && path.as_bytes()[1] == b':' { format!("{}\\", &path[..2]) } else { return 4096 };
        let (mut spc, mut bps, mut free, mut total) = (0u32, 0u32, 0u32, 0u32);
        let ok = unsafe { GetDiskFreeSpaceW(&HSTRING::from(root), Some(&mut spc), Some(&mut bps), Some(&mut free), Some(&mut total)) };
        if ok.is_ok() && spc > 0 && bps > 0 { spc as u64 * bps as u64 } else { 4096 }
    }

    pub fn set_hidden(path: &str, hidden: bool) -> Result<(), String> {
        use windows::Win32::Storage::FileSystem::{GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_FLAGS_AND_ATTRIBUTES, INVALID_FILE_ATTRIBUTES};
        let h = HSTRING::from(path);
        let cur = unsafe { GetFileAttributesW(&h) };
        if cur == INVALID_FILE_ATTRIBUTES {
            return Err("Can't read attributes".into());
        }
        let next = if hidden { cur | FILE_ATTRIBUTE_HIDDEN.0 } else { cur & !FILE_ATTRIBUTE_HIDDEN.0 };
        unsafe { SetFileAttributesW(&h, FILE_FLAGS_AND_ATTRIBUTES(next)) }.map_err(|e| e.message())
    }

    pub fn fill(path: &str, meta: &std::fs::Metadata, out: &mut Props) {
        let attrs = meta.file_attributes();
        for (bit, name) in [
            (0x1, "Read-only"), (0x2, "Hidden"), (0x4, "System"), (0x20, "Archive"), (0x100, "Temporary"),
            (0x200, "Sparse"), (0x400, "Link / reparse point"), (0x800, "Compressed"), (0x1000, "Offline"),
            (0x2000, "Not content-indexed"), (0x4000, "Encrypted"), (0x400000, "Online-only (cloud)"),
        ] {
            if attrs & bit != 0 {
                out.attributes.push(name.into());
            }
        }
        out.hidden = attrs & 0x2 != 0;
        let wide = HSTRING::from(path);
        unsafe {
            // Type name exactly as Explorer shows it ("JPEG image", "Application", …).
            use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
            use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_TYPENAME};
            let mut info = SHFILEINFOW::default();
            if SHGetFileInfoW(&wide, FILE_FLAGS_AND_ATTRIBUTES(attrs), Some(&mut info), std::mem::size_of::<SHFILEINFOW>() as u32, SHGFI_TYPENAME) != 0 {
                let n = info.szTypeName.iter().position(|&c| c == 0).unwrap_or(0);
                out.type_name = String::from_utf16_lossy(&info.szTypeName[..n]);
            }
        }
        if meta.is_file() {
            use windows::Win32::Storage::FileSystem::GetCompressedFileSizeW;
            let mut high = 0u32;
            let low = unsafe { GetCompressedFileSizeW(&wide, Some(&mut high)) };
            if low != u32::MAX || high != 0 {
                let c = cluster_size(path);
                let raw = ((high as u64) << 32) | low as u64;
                out.size_on_disk = Some(raw.div_ceil(c) * c);
            }
            if let Some(ext) = Path::new(path).extension() {
                let a = crate::shellmenu::default_app(&format!(".{}", ext.to_string_lossy()));
                if !a.name.is_empty() {
                    out.opens_with = Some(a.name);
                }
            }
        }
        out.owner = owner(&wide);
        if out.kind == "drive" {
            out.drive = Some(drive(path));
        }
        out.details = std::thread::scope(|s| s.spawn(|| shell_details(path)).join().unwrap_or_default());
    }

    fn owner(path: &HSTRING) -> Option<String> {
        use windows::Win32::Foundation::{HLOCAL, LocalFree};
        use windows::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
        use windows::Win32::Security::{LookupAccountSidW, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SID_NAME_USE};
        unsafe {
            let mut sid = PSID::default();
            let mut sd = PSECURITY_DESCRIPTOR::default();
            if GetNamedSecurityInfoW(path, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, Some(&mut sid), None, None, None, &mut sd).is_err() {
                return None;
            }
            let (mut name, mut dom) = ([0u16; 256], [0u16; 256]);
            let (mut nl, mut dl) = (256u32, 256u32);
            let mut use_ = SID_NAME_USE::default();
            let r = LookupAccountSidW(PCWSTR::null(), sid, Some(PWSTR(name.as_mut_ptr())), &mut nl, Some(PWSTR(dom.as_mut_ptr())), &mut dl, &mut use_);
            let _ = LocalFree(Some(HLOCAL(sd.0)));
            r.ok()?;
            let n = String::from_utf16_lossy(&name[..nl as usize]);
            let d = String::from_utf16_lossy(&dom[..dl as usize]);
            Some(if d.is_empty() { n } else { format!("{d}\\{n}") })
        }
    }

    fn drive(path: &str) -> DriveProps {
        use windows::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW, GetVolumeInformationW};
        let root = HSTRING::from(format!("{}\\", &path[..2]));
        let mut d = DriveProps::default();
        unsafe {
            let (mut label, mut fs) = ([0u16; 261], [0u16; 261]);
            let mut serial = 0u32;
            if GetVolumeInformationW(&root, Some(&mut label), Some(&mut serial), None, None, Some(&mut fs)).is_ok() {
                let z = |b: &[u16]| String::from_utf16_lossy(&b[..b.iter().position(|&c| c == 0).unwrap_or(0)]);
                d.label = z(&label);
                d.file_system = z(&fs);
                d.serial = format!("{:04X}-{:04X}", serial >> 16, serial & 0xffff);
            }
            let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
            if GetDiskFreeSpaceExW(&root, Some(&mut avail), Some(&mut total), Some(&mut free)).is_ok() {
                d.total = total;
                d.free = avail;
            }
            d.drive_type = match GetDriveTypeW(&root) {
                2 => "Removable disk",
                3 => "Local disk",
                4 => "Network drive",
                5 => "CD/DVD drive",
                6 => "RAM disk",
                _ => "Drive",
            }
            .into();
        }
        d
    }

    /// Every viewable property the shell knows for the item, grouped like Explorer's Details tab.
    fn shell_details(path: &str) -> Vec<PropGroup> {
        use windows::Win32::UI::Shell::PropertiesSystem::{
            IPropertyDescription, IPropertyStore, PSFormatForDisplayAlloc, PSGetPropertyDescription,
            SHGetPropertyStoreFromParsingName, GPS_BESTEFFORT, GPS_OPENSLOWITEM, PDFF_DEFAULT, PDTF_ISVIEWABLE,
        };
        // Shown on the General tab already, or internal plumbing.
        const SKIP: &[&str] = &[
            "System.ItemNameDisplay", "System.ItemFolderPathDisplay", "System.ItemPathDisplay", "System.ItemTypeText",
            "System.Size", "System.DateCreated", "System.DateModified", "System.DateAccessed", "System.FileAttributes",
            "System.ItemType", "System.FileOwner", "System.ParsingName", "System.SFGAOFlags", "System.Kind",
            "System.KindText", "System.PerceivedType", "System.FileName", "System.ItemNameDisplayWithoutExtension",
            "System.ItemFolderNameDisplay", "System.ItemFolderPathDisplayNarrow", "System.ItemPathDisplayNarrow",
            "System.ZoneIdentifier", "System.ThumbnailCacheId", "System.IsShared", "System.SharedWith",
            "System.Link.TargetParsingPath", "System.ComputerName", "System.FileExtension", "System.ItemDate",
        ];
        let group_of = |canon: &str| -> &'static str {
            let c = canon.strip_prefix("System.").unwrap_or(canon);
            if c.starts_with("Photo.") { "Camera" }
            else if c.starts_with("GPS.") { "GPS" }
            else if c.starts_with("Image.") { "Image" }
            else if c.starts_with("Video.") { "Video" }
            else if c.starts_with("Audio.") || c.starts_with("Music.") { "Audio" }
            else if c.starts_with("Media.") { "Media" }
            else if c.starts_with("Document.") || c == "Author" || c == "Title" || c == "Subject" || c == "Comment" || c == "Keywords" || c == "Copyright" || c == "ApplicationName" { "Description" }
            else if c.starts_with("Software.") || c.starts_with("FileVersion") || c.starts_with("Company") || c == "FileDescription" || c == "OriginalFileName" || c == "Language" { "Program" }
            else if c.starts_with("Volume.") || c.starts_with("Drive") || c == "Capacity" || c == "FreeSpace" || c == "PercentFull" { "Drive" }
            else { "Other" }
        };
        let order = ["Description", "Camera", "Image", "GPS", "Media", "Video", "Audio", "Program", "Drive", "Other"];
        let mut groups: Vec<PropGroup> = order.iter().map(|t| PropGroup { title: (*t).into(), items: vec![] }).collect();
        unsafe {
            let inited = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
            let mut run = || -> Option<()> {
                let store: IPropertyStore = SHGetPropertyStoreFromParsingName(&HSTRING::from(path), None, GPS_BESTEFFORT | GPS_OPENSLOWITEM).ok()?;
                let n = store.GetCount().ok()?;
                for i in 0..n.min(400) {
                    let mut key = Default::default();
                    if store.GetAt(i, &mut key).is_err() {
                        continue;
                    }
                    let mut raw: *mut std::ffi::c_void = std::ptr::null_mut();
                    if PSGetPropertyDescription(&key, &IPropertyDescription::IID, &mut raw).is_err() || raw.is_null() {
                        continue;
                    }
                    let desc = IPropertyDescription::from_raw(raw);
                    if desc.GetTypeFlags(PDTF_ISVIEWABLE).map(|f| f.0 == 0).unwrap_or(true) {
                        continue;
                    }
                    let canon = desc.GetCanonicalName().map(take).unwrap_or_default();
                    if SKIP.contains(&canon.as_str()) {
                        continue;
                    }
                    let label = desc.GetDisplayName().map(take).unwrap_or_default();
                    let Ok(value) = store.GetValue(&key) else { continue };
                    let text = PSFormatForDisplayAlloc(&key, &value, PDFF_DEFAULT).map(take).unwrap_or_default();
                    // The shell wraps some values in bidi marks; strip them so they copy cleanly.
                    let text: String = text.chars().filter(|c| !matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}' | '\u{202c}')).collect();
                    if label.is_empty() || text.trim().is_empty() {
                        continue;
                    }
                    let g = group_of(&canon);
                    if let Some(grp) = groups.iter_mut().find(|x| x.title == g) {
                        if !grp.items.iter().any(|(k, _)| *k == label) {
                            grp.items.push((label, text));
                        }
                    }
                }
                Some(())
            };
            run();
            if inited {
                CoUninitialize();
            }
        }
        groups.retain(|g| !g.items.is_empty());
        groups
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;
    pub fn cluster_size(_path: &str) -> u64 {
        4096
    }
    pub fn set_hidden(_path: &str, _hidden: bool) -> Result<(), String> {
        Err("On this system, hidden files are those whose name starts with a dot".into())
    }
    pub fn fill(path: &str, meta: &std::fs::Metadata, out: &mut Props) {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        out.size_on_disk = Some(meta.blocks() * 512);
        out.hidden = Path::new(path).file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(false);
        let mode = meta.permissions().mode();
        let bits = |s: u32| format!("{}{}{}", if mode & (4 << s) != 0 { 'r' } else { '-' }, if mode & (2 << s) != 0 { 'w' } else { '-' }, if mode & (1 << s) != 0 { 'x' } else { '-' });
        out.attributes.push(format!("Permissions {}{}{}", bits(6), bits(3), bits(0)));
        out.owner = Some(format!("uid {}", meta.uid()));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore]
    fn props_real() {
        for p in std::env::var("PF_PROPS").unwrap_or_else(|_| r"C:\Windows\notepad.exe;C:\".into()).split(';') {
            let t = std::time::Instant::now();
            let r = super::properties(p).unwrap();
            println!("{} in {:?}\n{}", p, t.elapsed(), serde_json::to_string_pretty(&r).unwrap());
        }
    }
}
