//! Thumbnails and previews.
//!
//! Fast path (jpg/png/webp/bmp/gif): decode with JPEG DCT-domain downscaling (1/2..1/8 inside the
//! decoder, 3-10x faster than full decode + resize) and apply EXIF orientation.
//! Everything else - HEIC/HEIF, videos, PDFs, RAW, or files the fast path can't read - goes through
//! the Windows Shell thumbnail provider (IShellItemImageFactory), the same source Explorer uses,
//! backed by the system thumbnail cache.

use base64::Engine;
use image::DynamicImage;
use std::collections::HashMap;
use std::io::BufReader;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

static THUMB_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static PREVIEW_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn thumb_cache() -> &'static Mutex<HashMap<String, String>> {
    THUMB_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}
fn preview_cache() -> &'static Mutex<HashMap<String, String>> {
    PREVIEW_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_get(cache: &Mutex<HashMap<String, String>>, key: &str) -> Option<String> {
    cache.lock().ok()?.get(key).cloned()
}

fn cache_insert(cache: &Mutex<HashMap<String, String>>, key: String, val: String, cap: usize) {
    if let Ok(mut m) = cache.lock() {
        if m.len() >= cap {
            let drop: Vec<String> = m.keys().take(cap / 2).cloned().collect();
            for k in drop {
                m.remove(&k);
            }
        }
        m.insert(key, val);
    }
}

const THUMB_MAX: u32 = 256;
const THUMB_QUALITY: u8 = 80;
const PREVIEW_MAX: u32 = 2560;
const PREVIEW_QUALITY: u8 = 90;
/// Originals up to this size are sent untouched for the preview fallback; larger ones are resized.
const ORIGINAL_PREVIEW_MAX_BYTES: u64 = 3 * 1024 * 1024;
const MAX_DECODE_BYTES: u64 = 200 * 1024 * 1024;

fn ext_of(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default()
}

fn is_fast_decodable(ext: &str) -> bool {
    matches!(ext, "jpg" | "jpeg" | "png" | "webp" | "bmp" | "gif")
}

fn exif_orientation(path: &Path) -> u32 {
    let Ok(file) = std::fs::File::open(path) else { return 1 };
    exif::Reader::new()
        .read_from_container(&mut BufReader::new(file))
        .ok()
        .and_then(|e| e.get_field(exif::Tag::Orientation, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0)))
        .unwrap_or(1)
}

fn apply_orientation(img: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

/// Decodes an image upright with its long side at least `min_long` (when the source is that big).
/// JPEGs are downscaled inside the IDCT. Returns the image un-resized beyond that.
pub fn decode_oriented(path: &Path, min_long: u32) -> Result<DynamicImage, String> {
    let ext = ext_of(path);
    let len = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if len == 0 || len > MAX_DECODE_BYTES {
        return Err("unsupported size".into());
    }
    let img = if ext == "jpg" || ext == "jpeg" {
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut dec = image::codecs::jpeg::JpegDecoder::new(BufReader::new(file)).map_err(|e| e.to_string())?;
        let req = min_long.min(u16::MAX as u32) as u16;
        dec.scale(req, req).map_err(|e| e.to_string())?;
        DynamicImage::from_decoder(dec).map_err(|e| e.to_string())?
    } else {
        image::open(path).map_err(|e| e.to_string())?
    };
    Ok(apply_orientation(img, exif_orientation(path)))
}

/// The small JPEG preview most cameras and phones store inside the EXIF block (IFD1).
/// Reading it costs one small file read instead of decoding a 20+ megapixel image.
fn exif_thumbnail(path: &Path) -> Option<DynamicImage> {
    let file = std::fs::File::open(path).ok()?;
    let ex = exif::Reader::new().read_from_container(&mut BufReader::new(file)).ok()?;
    let off = ex.get_field(exif::Tag::JPEGInterchangeFormat, exif::In::THUMBNAIL)?.value.get_uint(0)? as usize;
    let len = ex.get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In::THUMBNAIL)?.value.get_uint(0)? as usize;
    let buf = ex.buf();
    let data = buf.get(off..off.checked_add(len)?)?;
    let img = image::load_from_memory_with_format(data, image::ImageFormat::Jpeg).ok()?;
    Some(apply_orientation(img, ex.get_field(exif::Tag::Orientation, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0)).unwrap_or(1)))
}

fn fit(img: DynamicImage, max: u32) -> DynamicImage {
    if img.width() > max || img.height() > max {
        img.resize(max, max, image::imageops::FilterType::Triangle)
    } else {
        img
    }
}

/// JPEG for opaque images, PNG when there is transparency (icons, logos, shell thumbnails).
fn encode_data_url(img: &DynamicImage, quality: u8) -> Result<String, String> {
    let has_alpha = img.color().has_alpha() && img.to_rgba8().pixels().any(|p| p[3] < 250);
    let mut buf = Vec::new();
    let mime = if has_alpha {
        img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageOutputFormat::Png)
            .map_err(|e| e.to_string())?;
        "image/png"
    } else {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality)
            .encode_image(&DynamicImage::ImageRgb8(img.to_rgb8()))
            .map_err(|e| e.to_string())?;
        "image/jpeg"
    };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&buf)))
}

/// Converts a GDI bitmap (32-bit, possibly premultiplied alpha) into an RGBA image.
#[cfg(windows)]
pub fn hbitmap_to_rgba(hbmp: windows::Win32::Graphics::Gdi::HBITMAP) -> Option<image::RgbaImage> {
    use windows::Win32::Graphics::Gdi::{
        GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    unsafe {
        let mut bm = BITMAP::default();
        let got = GetObjectW(HGDIOBJ(hbmp.0), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _));
        let (w, h) = (bm.bmWidth, bm.bmHeight.abs());
        if got == 0 || w <= 0 || h <= 0 {
            return None;
        }
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bgra = vec![0u8; (w * h * 4) as usize];
        let hdc = GetDC(None);
        let lines = GetDIBits(hdc, hbmp, 0, h as u32, Some(bgra.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS);
        ReleaseDC(None, hdc);
        if lines == 0 {
            return None;
        }
        // BGRA (premultiplied; alpha is all-zero for opaque bitmaps) -> straight RGBA
        let all_zero_alpha = bgra.chunks_exact(4).all(|p| p[3] == 0);
        let mut rgba = Vec::with_capacity(bgra.len());
        for p in bgra.chunks_exact(4) {
            let a = if all_zero_alpha { 255 } else { p[3] };
            let un = |c: u8| if a == 0 || a == 255 { c } else { ((c as u32 * 255) / a as u32).min(255) as u8 };
            rgba.extend_from_slice(&[un(p[2]), un(p[1]), un(p[0]), a]);
        }
        image::RgbaImage::from_raw(w as u32, h as u32, rgba)
    }
}

/// PNG data URL of a GDI bitmap (menu item icons). `owned`: delete the bitmap afterwards.
#[cfg(windows)]
pub fn hbitmap_to_png_data_url(hbmp: windows::Win32::Graphics::Gdi::HBITMAP, owned: bool) -> Option<String> {
    let img = hbitmap_to_rgba(hbmp);
    if owned {
        unsafe {
            let _ = windows::Win32::Graphics::Gdi::DeleteObject(windows::Win32::Graphics::Gdi::HGDIOBJ(hbmp.0));
        }
    }
    let mut buf = Vec::new();
    DynamicImage::ImageRgba8(img?).write_to(&mut std::io::Cursor::new(&mut buf), image::ImageOutputFormat::Png).ok()?;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&buf)))
}

/// Image from the Windows Shell for `path`: a thumbnail (HEIC, video frames, PDF, Office…) or,
/// with `icon_only`, the file's own icon (exe, shortcuts, ico…).
/// Shell thumbnail providers (PDF, Office, many codecs) are apartment-threaded and fail with
/// odd errors (e.g. 0x8004B200 for PDFs) when called from a multithreaded worker, so each
/// request runs on a short-lived single-threaded-apartment thread.
#[cfg(windows)]
fn shell_image(path: &str, size: u32, icon_only: bool) -> Result<DynamicImage, String> {
    let path = path.to_string();
    std::thread::Builder::new()
        .name("shell-thumb".into())
        .spawn(move || shell_image_sta(&path, size, icon_only))
        .map_err(|e| e.to_string())?
        .join()
        .map_err(|_| "thumbnail provider crashed".to_string())?
}

#[cfg(windows)]
fn shell_image_sta(path: &str, size: u32, icon_only: bool) -> Result<DynamicImage, String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{DeleteObject, HGDIOBJ};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY, SIIGBF_THUMBNAILONLY,
    };
    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    unsafe {
        let _com = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok().then_some(Com);
        let factory: IShellItemImageFactory =
            SHCreateItemFromParsingName(&HSTRING::from(path), None).map_err(|e| e.to_string())?;
        let flags = if icon_only { SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK } else { SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK };
        match factory.GetImage(SIZE { cx: size as i32, cy: size as i32 }, flags) {
            Ok(hbmp) => {
                let img = hbitmap_to_rgba(hbmp);
                let _ = DeleteObject(HGDIOBJ(hbmp.0));
                img.map(DynamicImage::ImageRgba8).ok_or_else(|| "empty shell bitmap".into())
            }
            // Some providers (several PDF handlers) reject the direct call but work through the
            // system thumbnail cache, which is what Explorer uses.
            Err(e) if !icon_only => thumbnail_cache_image(&factory, size).ok_or_else(|| e.to_string()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(windows)]
unsafe fn thumbnail_cache_image(factory: &windows::Win32::UI::Shell::IShellItemImageFactory, size: u32) -> Option<DynamicImage> {
    use windows::core::Interface;
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::{IShellItem, ISharedBitmap, IThumbnailCache, LocalThumbnailCache, WTS_EXTRACT, WTS_SCALETOREQUESTEDSIZE};
    unsafe {
        let item: IShellItem = factory.cast().ok()?;
        let cache: IThumbnailCache = CoCreateInstance(&LocalThumbnailCache, None, CLSCTX_INPROC_SERVER).ok()?;
        let mut shared: Option<ISharedBitmap> = None;
        cache.GetThumbnail(&item, size, WTS_EXTRACT | WTS_SCALETOREQUESTEDSIZE, Some(&mut shared), None, None).ok()?;
        let hbmp = shared?.GetSharedBitmap().ok()?;
        hbitmap_to_rgba(hbmp).map(DynamicImage::ImageRgba8)
    }
}

#[cfg(windows)]
fn shell_thumbnail(path: &str, size: u32) -> Result<DynamicImage, String> {
    shell_image(path, size, false)
}

#[cfg(not(windows))]
fn shell_thumbnail(_path: &str, _size: u32) -> Result<DynamicImage, String> {
    Err("no shell thumbnails on this platform".into())
}

/// First page of a PDF via Windows' own PDF engine (Windows.Data.Pdf), independent of whichever
/// PDF app registered a (sometimes broken) thumbnail handler.
#[cfg(windows)]
fn pdf_first_page(path: &str, max: u32) -> Result<DynamicImage, String> {
    use windows::core::HSTRING;
    use windows::Data::Pdf::{PdfDocument, PdfPageRenderOptions};
    use windows::Storage::StorageFile;
    use windows::Storage::Streams::{DataReader, InMemoryRandomAccessStream};
    let run = || -> windows::core::Result<Vec<u8>> {
        let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))?.get()?;
        let doc = PdfDocument::LoadFromFileAsync(&file)?.get()?;
        let page = doc.GetPage(0)?;
        let size = page.Size()?;
        let opts = PdfPageRenderOptions::new()?;
        if size.Width >= size.Height { opts.SetDestinationWidth(max)?; } else { opts.SetDestinationHeight(max)?; }
        let stream = InMemoryRandomAccessStream::new()?;
        page.RenderWithOptionsToStreamAsync(&stream, &opts)?.get()?;
        let len = stream.Size()? as u32;
        let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
        reader.LoadAsync(len)?.get()?;
        let mut buf = vec![0u8; len as usize];
        reader.ReadBytes(&mut buf)?;
        Ok(buf)
    };
    let bytes = run().map_err(|e| e.message())?;
    image::load_from_memory(&bytes).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn pdf_first_page(_path: &str, _max: u32) -> Result<DynamicImage, String> {
    Err("no PDF renderer on this platform".into())
}

/// RAW camera formats: decoded through the camera's own embedded JPEG preview.
pub fn is_raw(ext: &str) -> bool {
    matches!(
        ext,
        "cr2" | "cr3" | "crw" | "nef" | "nrw" | "arw" | "srf" | "sr2" | "dng" | "raf" | "orf" | "rw2" | "pef" | "srw"
            | "x3f" | "3fr" | "iiq" | "erf" | "kdc" | "mef" | "mos" | "rwl"
    )
}

fn render(path: &str, max: u32, quality: u8) -> Result<String, String> {
    let p = Path::new(path);
    if !p.is_file() {
        return Err(format!("not found: {path}"));
    }
    let ext = ext_of(p);
    let big_jpeg = matches!(ext.as_str(), "jpg" | "jpeg") && max <= THUMB_MAX && std::fs::metadata(p).map(|m| m.len() > 3 * 1024 * 1024).unwrap_or(false);
    let fast = if big_jpeg {
        // Large camera/phone JPEGs: the embedded EXIF preview when it's big enough (a few ms),
        // else Windows' thumbnail engine (often already cached by Explorer), and only then a
        // full scaled decode (1-2 s for 20+ MP files).
        exif_thumbnail(p)
            .filter(|t| t.width().max(t.height()) >= 240)
            .or_else(|| shell_thumbnail(path, max).ok())
            .or_else(|| decode_oriented(p, max).ok())
    } else if is_fast_decodable(&ext) {
        decode_oriented(p, max).ok()
    } else if is_raw(&ext) {
        crate::raw::embedded_preview(p, max).ok()
    } else if ext == "pdf" {
        pdf_first_page(path, max).ok()
    } else {
        None
    };
    let img = match fast {
        Some(img) => img,
        None => shell_thumbnail(path, max)?,
    };
    encode_data_url(&fit(img, max), quality)
}

/// The file's own icon (programs, shortcuts, .ico, installers…) as a PNG data URL.
pub fn get_file_icon(path: String, size: u32) -> Result<String, String> {
    let key = format!("icon{size}:{path}");
    if let Some(cached) = cache_get(thumb_cache(), &key) {
        return Ok(cached);
    }
    #[cfg(windows)]
    {
        let img = shell_image(&path, size.clamp(16, 256), true)?;
        let mut buf = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageOutputFormat::Png).map_err(|e| e.to_string())?;
        let url = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&buf));
        cache_insert(thumb_cache(), key, url.clone(), 600);
        Ok(url)
    }
    #[cfg(not(windows))]
    {
        let _ = key;
        Err("system icons are not available on this platform".into())
    }
}

/// On-disk thumbnail cache (app data/thumbs): keyed by path + size + modified time, so an
/// edited file gets a fresh thumbnail and later sessions show thumbnails instantly instead of
/// decoding every photo again.
fn disk_key(path: &str) -> Option<std::path::PathBuf> {
    use std::hash::{Hash, Hasher};
    let m = std::fs::metadata(path).ok()?;
    let mtime = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (path.to_lowercase(), m.len(), mtime, THUMB_MAX).hash(&mut h);
    let k = h.finish();
    Some(crate::app_data_dir().join("thumbs").join(format!("{:02x}", k & 0xff)).join(format!("{k:016x}.b64")))
}

pub fn get_thumbnail(path: String) -> Result<String, String> {
    if let Some(cached) = cache_get(thumb_cache(), &path) {
        return Ok(cached);
    }
    let key = disk_key(&path);
    if let Some(url) = key.as_ref().and_then(|k| std::fs::read_to_string(k).ok()).filter(|u| u.starts_with("data:image/")) {
        cache_insert(thumb_cache(), path, url.clone(), 600);
        return Ok(url);
    }
    let url = render(&path, THUMB_MAX, THUMB_QUALITY)?;
    if let Some(k) = key {
        if let Some(dir) = k.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&k, &url);
    }
    cache_insert(thumb_cache(), path, url.clone(), 600);
    Ok(url)
}

/// Drops cached thumbnails/previews of a file that was just changed (the disk cache is keyed by
/// size + modified time, so it refreshes by itself).
pub fn forget(path: &str) {
    for c in [thumb_cache(), preview_cache()] {
        if let Ok(mut m) = c.lock() {
            m.remove(path);
        }
    }
}

/// Deletes the on-disk thumbnail cache (Settings > Performance > Clear thumbnail cache).
pub fn clear_disk_cache() -> u64 {
    let dir = crate::app_data_dir().join("thumbs");
    let freed: u64 = walkdir::WalkDir::new(&dir).into_iter().filter_map(|e| e.ok()).filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum();
    let _ = std::fs::remove_dir_all(&dir);
    if let Ok(mut m) = thumb_cache().lock() {
        m.clear();
    }
    freed
}

/// Preview fallback when the webview can't stream the file via asset:// (HEIC, huge files…).
/// Small browser-renderable originals are sent as-is; everything else is a sharp 2560px render.
pub fn get_file_preview(path: String) -> Result<String, String> {
    if let Some(cached) = cache_get(preview_cache(), &path) {
        return Ok(cached);
    }
    let p = Path::new(&path);
    let ext = ext_of(p);
    let small = std::fs::metadata(p).map(|m| m.len() <= ORIGINAL_PREVIEW_MAX_BYTES).unwrap_or(false);
    let url = if small && matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp" | "svg") {
        get_original_data_url(path.clone())?
    } else {
        render(&path, PREVIEW_MAX, PREVIEW_QUALITY)?
    };
    cache_insert(preview_cache(), path, url.clone(), 40);
    Ok(url)
}

/// Original bytes as a data URL (no re-encode). Large files are resized instead so the IPC payload
/// stays reasonable.
pub fn get_original_data_url(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() == 0 {
        return Err("not a readable file".into());
    }
    if meta.len() > ORIGINAL_PREVIEW_MAX_BYTES {
        return render(&path, PREVIEW_MAX, PREVIEW_QUALITY);
    }
    let mime = match ext_of(p).as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => return render(&path, PREVIEW_MAX, PREVIEW_QUALITY),
    };
    let bytes = std::fs::read(p).map_err(|e| format!("read failed: {e}"))?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cold thumbnail timing for large images (no caches). PF_LARGE=path;path
    #[test]
    #[ignore]
    fn thumbs_large_cold() {
        for p in std::env::var("PF_LARGE").unwrap_or_default().split(';').filter(|s| !s.is_empty()) {
            let t = std::time::Instant::now();
            let r = render(p, THUMB_MAX, THUMB_QUALITY);
            println!("{:<50} {:>9.1?} {}", p, t.elapsed(), r.map(|u| format!("{} KB", u.len() / 1024)).unwrap_or_else(|e| e));
        }
    }

    #[test]
    #[ignore]
    fn thumbs_sources_compare() {
        for p in std::env::var("PF_LARGE").unwrap_or_default().split(';').filter(|s| !s.is_empty()) {
            let t = std::time::Instant::now();
            let sh = shell_thumbnail(p, THUMB_MAX).map(|i| format!("{}x{}", i.width(), i.height()));
            let shell_t = t.elapsed();
            let t = std::time::Instant::now();
            let ex = exif_thumbnail(Path::new(p)).map(|i| format!("{}x{}", i.width(), i.height()));
            println!("{:<44} shell {:>8.1?} {:?} | exif {:>8.1?} {:?}", p, shell_t, sh, t.elapsed(), ex);
        }
    }

    /// Thumbnails for real files on this machine (large JPEG, video, PDF, PNG).
    /// Run: cargo test --lib thumbnails_real_files -- --ignored --nocapture
    #[test]
    #[ignore]
    fn thumbnails_real_files() {
        for p in [
            r"D:\Accounts\L\DSC02065.JPG",
            r"F:\1000093124.jpg",
            r"D:\Accounts\L\VID_20230201_132050.mp4",
            r"E:\Exam Duty Slip Generator\Resources\Changelog.pdf",
            r"E:\Codes\Python\Vulnerability\logo.png",
        ] {
            let t = std::time::Instant::now();
            let r = get_thumbnail(p.to_string());
            println!("{:<55} {:>8.1?}  {}", p, t.elapsed(), match &r {
                Ok(u) => format!("ok {} ({} KB)", &u[..u.find(';').unwrap_or(10)], u.len() / 1024),
                Err(e) => format!("ERR {e}"),
            });
            let t = std::time::Instant::now();
            let r = get_file_preview(p.to_string());
            println!("{:<55} {:>8.1?}  preview {}", "", t.elapsed(), r.map(|u| format!("{} KB", u.len() / 1024)).unwrap_or_else(|e| e));
        }
    }
}
