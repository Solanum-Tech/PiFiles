//! RAW photos (CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2…).
//!
//! Every camera stores a JPEG rendering of the shot inside the RAW file - usually full size - 
//! which is what the camera's own screen shows. We find the largest displayable one and decode
//! that: instant, colour-correct as the camera rendered it, and no demosaicing library needed.
//! The sensor data itself is often stored as lossless JPEG (SOF3), which is skipped.

use image::DynamicImage;
use std::path::Path;

const MAX_RAW_BYTES: u64 = 300 * 1024 * 1024;

/// (offset, length) of complete baseline/progressive JPEG streams found in `data`.
fn jpeg_streams(data: &[u8]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 4 < data.len() {
        if !(data[i] == 0xFF && data[i + 1] == 0xD8 && data[i + 2] == 0xFF) {
            i += 1;
            continue;
        }
        match scan_jpeg(data, i) {
            Some((len, displayable)) => {
                if displayable {
                    out.push((i, len));
                }
                i += len.max(2);
            }
            None => i += 2,
        }
    }
    out
}

/// Walks JPEG segments from SOI; returns (length through EOI, is a displayable DCT JPEG).
fn scan_jpeg(d: &[u8], start: usize) -> Option<(usize, bool)> {
    let mut p = start + 2;
    let mut displayable = false;
    let mut saw_sof = false;
    while p + 4 <= d.len() {
        if d[p] != 0xFF {
            return None;
        }
        let m = d[p + 1];
        match m {
            0xFF => {
                p += 1; // fill byte
                continue;
            }
            0xD9 => return Some((p + 2 - start, displayable)),
            0x01 | 0xD0..=0xD7 => {
                p += 2;
                continue;
            }
            _ => {}
        }
        let len = u16::from_be_bytes([d[p + 2], d[p + 3]]) as usize;
        if len < 2 {
            return None;
        }
        if (0xC0..=0xCF).contains(&m) && !matches!(m, 0xC4 | 0xC8 | 0xCC) {
            saw_sof = true;
            displayable = matches!(m, 0xC0 | 0xC1 | 0xC2);
        }
        p += 2 + len;
        if m == 0xDA {
            if !saw_sof {
                return None;
            }
            // Entropy-coded data runs until a marker that isn't stuffing (FF00) or a restart.
            while p + 1 < d.len() {
                if d[p] == 0xFF && d[p + 1] != 0x00 && !(0xD0..=0xD7).contains(&d[p + 1]) {
                    break;
                }
                p += 1;
            }
        }
    }
    None
}

/// The camera's embedded preview, upright, with its long side at most `max` pixels.
pub fn embedded_preview(path: &Path, max: u32) -> Result<DynamicImage, String> {
    let len = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if len > MAX_RAW_BYTES {
        return Err("file too large".into());
    }
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut streams = jpeg_streams(&data);
    streams.sort_by_key(|s| std::cmp::Reverse(s.1));
    for (off, n) in streams.into_iter().take(4) {
        let bytes = &data[off..off + n];
        let Ok(mut dec) = image::codecs::jpeg::JpegDecoder::new(std::io::Cursor::new(bytes)) else { continue };
        let req = max.min(u16::MAX as u32) as u16;
        let _ = dec.scale(req, req);
        if let Ok(img) = DynamicImage::from_decoder(dec) {
            if img.width() >= 64 {
                return Ok(orient(img, path));
            }
        }
    }
    Err("no embedded preview in this RAW file".into())
}

fn orient(img: DynamicImage, path: &Path) -> DynamicImage {
    let o = std::fs::File::open(path)
        .ok()
        .and_then(|f| exif::Reader::new().read_from_container(&mut std::io::BufReader::new(f)).ok())
        .and_then(|e| e.get_field(exif::Tag::Orientation, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0)))
        .unwrap_or(1);
    match o {
        3 => img.rotate180(),
        6 => img.rotate90(),
        8 => img.rotate270(),
        _ => img,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real RAW file from this machine (path in PIFILES_RAW); prints size and timing only.
    #[test]
    #[ignore]
    fn embedded_preview_real() {
        let raw = std::env::var("PIFILES_RAW").expect("PIFILES_RAW");
        let p = raw.trim().trim_start_matches('\u{feff}').to_string();
        let t = std::time::Instant::now();
        let img = embedded_preview(Path::new(&p), 2560).unwrap();
        println!("embedded preview {}x{} in {:?}", img.width(), img.height(), t.elapsed());
        let t = std::time::Instant::now();
        let thumb = crate::thumbnail::get_thumbnail(p).unwrap();
        println!("thumbnail {} KB in {:?}", thumb.len() / 1024, t.elapsed());
    }

    #[test]
    fn finds_largest_displayable_jpeg_in_container() {
        // A fake RAW: header bytes, a small thumbnail JPEG, a fake lossless (SOF3) stream, a bigger JPEG.
        let mk = |w: u32, h: u32| {
            let img = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(w, h, image::Rgb([200, 30, 30])));
            let mut buf = Vec::new();
            img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageOutputFormat::Jpeg(85)).unwrap();
            buf
        };
        let small = mk(160, 120);
        let big = mk(1200, 800);
        let lossless = vec![0xFF, 0xD8, 0xFF, 0xC3, 0x00, 0x0B, 8, 0, 16, 0, 16, 1, 1, 0x11, 0, 0xFF, 0xDA, 0x00, 0x08, 1, 1, 0, 0, 0x3F, 0, 1, 2, 3, 4, 0xFF, 0xD9];
        let mut data = b"II*\0fake raw header".to_vec();
        data.extend(&small);
        data.extend([0u8; 100]);
        data.extend(&lossless);
        data.extend(&big);
        data.extend([1u8; 50]);
        let streams = jpeg_streams(&data);
        assert_eq!(streams.len(), 2, "lossless sensor JPEG must be skipped");
        assert_eq!(streams.iter().map(|s| s.1).max().unwrap(), big.len());
        let p = std::env::temp_dir().join("pifiles-raw-test.cr2");
        std::fs::write(&p, &data).unwrap();
        let img = embedded_preview(&p, 4000).unwrap();
        assert_eq!((img.width(), img.height()), (1200, 800));
        let _ = std::fs::remove_file(p);
    }
}
