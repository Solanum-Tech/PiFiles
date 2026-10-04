//! Backend for the image editor (src/image-editor.js).
//!
//! * `detect_faces` - face boxes from the on-device YuNet detector, used by the AI tools
//!   (Portrait light, Smart crop). Normalised 0..1 to the upright image.
//! * `save_edit` - writes the edited pixels the page rendered. The previous file is always kept
//!   in version history first (even when history is off globally), and for JPEGs the original
//!   EXIF block (camera, lens, exposure, date, GPS…) is carried over with the orientation reset
//!   and the pixel dimensions updated, so photographers don't lose their metadata.

use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct Faces {
    pub width: u32,
    pub height: u32,
    /// x, y, w, h as fractions of width/height
    pub faces: Vec<[f32; 4]>,
}

pub fn detect_faces(path: &str) -> Result<Faces, String> {
    let img = crate::face_ai::load_oriented_rgb(Path::new(path))?;
    let (w, h) = (img.width() as f32, img.height() as f32);
    let dets = crate::face_ai::detect_faces(&img)?;
    Ok(Faces {
        width: img.width(),
        height: img.height(),
        faces: dets.iter().map(|d| [d.bbox[0] / w, d.bbox[1] / h, d.bbox[2] / w, d.bbox[3] / h]).collect(),
    })
}

fn free_copy_name(path: &Path) -> PathBuf {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let dir = path.parent().unwrap_or(Path::new("."));
    let mut i = 1;
    loop {
        let name = if i == 1 { format!("{stem} (edited){ext}") } else { format!("{stem} (edited {i}){ext}") };
        let p = dir.join(name);
        if !p.exists() {
            return p;
        }
        i += 1;
    }
}

/// The APP1 "Exif" segment of a JPEG (marker included), if any.
fn exif_segment(jpeg: &[u8]) -> Option<Vec<u8>> {
    if jpeg.len() < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        return None;
    }
    let mut i = 2;
    while i + 4 <= jpeg.len() && jpeg[i] == 0xFF {
        let marker = jpeg[i + 1];
        if marker == 0xDA || marker == 0xD9 {
            break; // start of scan / end: no more metadata
        }
        let len = u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]) as usize;
        let end = i + 2 + len;
        if end > jpeg.len() {
            return None;
        }
        if marker == 0xE1 && jpeg.get(i + 4..i + 10) == Some(b"Exif\0\0") {
            return Some(jpeg[i..end].to_vec());
        }
        i = end;
    }
    None
}

/// Sets Orientation to 1, updates PixelX/YDimension, and drops the embedded thumbnail (IFD1),
/// which would still show the unedited picture. Works in place on an APP1 segment.
fn patch_exif(seg: &mut [u8], width: u32, height: u32) -> Option<()> {
    let tiff = 10; // FF E1 len(2) "Exif\0\0"
    let t = seg.get(tiff..)?.to_vec();
    let le = match t.get(0..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let r16 = |b: &[u8], o: usize| -> Option<u16> { let x = b.get(o..o + 2)?; Some(if le { u16::from_le_bytes([x[0], x[1]]) } else { u16::from_be_bytes([x[0], x[1]]) }) };
    let r32 = |b: &[u8], o: usize| -> Option<u32> { let x = b.get(o..o + 4)?; Some(if le { u32::from_le_bytes([x[0], x[1], x[2], x[3]]) } else { u32::from_be_bytes([x[0], x[1], x[2], x[3]]) }) };
    let w16 = |b: &mut [u8], o: usize, v: u16| { let x = if le { v.to_le_bytes() } else { v.to_be_bytes() }; b[tiff + o..tiff + o + 2].copy_from_slice(&x); };
    let w32 = |b: &mut [u8], o: usize, v: u32| { let x = if le { v.to_le_bytes() } else { v.to_be_bytes() }; b[tiff + o..tiff + o + 4].copy_from_slice(&x); };
    let ifd0 = r32(&t, 4)? as usize;
    let n = r16(&t, ifd0)? as usize;
    let mut exif_ifd = None;
    for k in 0..n {
        let e = ifd0 + 2 + k * 12;
        match r16(&t, e)? {
            0x0112 => w16(seg, e + 8, 1),
            0x8769 => exif_ifd = Some(r32(&t, e + 8)? as usize),
            _ => {}
        }
    }
    // next-IFD pointer after IFD0 -> 0: no IFD1 thumbnail
    w32(seg, ifd0 + 2 + n * 12, 0);
    if let Some(x) = exif_ifd {
        let m = r16(&t, x)? as usize;
        for k in 0..m {
            let e = x + 2 + k * 12;
            let (tag, typ) = (r16(&t, e)?, r16(&t, e + 2)?);
            let v = match tag {
                0xA002 => width,
                0xA003 => height,
                _ => continue,
            };
            if typ == 3 {
                w16(seg, e + 8, v.min(u16::MAX as u32) as u16);
            } else if typ == 4 {
                w32(seg, e + 8, v);
            }
        }
    }
    Some(())
}

/// New JPEG bytes with the original's (patched) EXIF segment inserted after SOI.
fn with_exif(new_jpeg: &[u8], exif: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::with_capacity(new_jpeg.len() + exif.len());
    out.extend_from_slice(&new_jpeg[..2]);
    out.extend_from_slice(&exif);
    out.extend_from_slice(&new_jpeg[2..]);
    out
}

pub fn save_edit(path: &str, data_b64: &str, width: u32, height: u32, as_copy: bool) -> Result<String, String> {
    let src = Path::new(path);
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_b64.trim_start_matches(|c| c != ',').trim_start_matches(',')).map_err(|e| format!("Bad image data: {e}"))?;
    if bytes.len() < 16 {
        return Err("Empty image".into());
    }
    let ext = src.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let is_jpeg_out = bytes.starts_with(&[0xFF, 0xD8]);
    let mut out = bytes;
    if is_jpeg_out && matches!(ext.as_str(), "jpg" | "jpeg" | "jfif") {
        if let Ok(orig) = std::fs::read(src) {
            if let Some(mut seg) = exif_segment(&orig) {
                if patch_exif(&mut seg, width, height).is_some() {
                    out = with_exif(&out, seg);
                }
            }
        }
    }
    let target = if as_copy { free_copy_name(src) } else { src.to_path_buf() };
    if !as_copy {
        crate::versions::before_edit(src);
    }
    let tmp = target.with_extension(format!("{ext}.pifiles-tmp"));
    std::fs::write(&tmp, &out).map_err(|e| format!("Couldn't write: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Couldn't replace the file: {e}")
    })?;
    crate::thumbnail::forget(path);
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    #[test]
    fn exif_orientation_is_reset_and_thumbnail_dropped() {
        // minimal little-endian TIFF: IFD0 with Orientation=6 and a next-IFD pointer of 0x99
        let mut tiff = b"II*\0\x08\0\0\0".to_vec();
        tiff.extend_from_slice(&1u16.to_le_bytes());
        tiff.extend_from_slice(&0x0112u16.to_le_bytes());
        tiff.extend_from_slice(&3u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&6u16.to_le_bytes());
        tiff.extend_from_slice(&[0, 0]);
        tiff.extend_from_slice(&0x99u32.to_le_bytes());
        let mut seg = vec![0xFF, 0xE1, 0, 0];
        seg.extend_from_slice(b"Exif\0\0");
        seg.extend_from_slice(&tiff);
        let len = (seg.len() - 2) as u16;
        seg[2..4].copy_from_slice(&len.to_be_bytes());
        let jpeg: Vec<u8> = [vec![0xFF, 0xD8], seg.clone(), vec![0xFF, 0xD9]].concat();
        let mut found = super::exif_segment(&jpeg).unwrap();
        assert_eq!(found, seg);
        super::patch_exif(&mut found, 10, 10).unwrap();
        let t = &found[10..];
        assert_eq!(u16::from_le_bytes([t[18], t[19]]), 1, "orientation reset");
        assert_eq!(u32::from_le_bytes([t[22], t[23], t[24], t[25]]), 0, "IFD1 dropped");
    }
}
