//! Fuzz-style robustness tests: every parser that reads untrusted bytes (photos, RAW, videos,
//! archives, spreadsheets, text, EXIF) is fed random and deliberately corrupted files. They may
//! return errors, but must never panic or hang. Deterministic (fixed seed) so failures reproduce.

use std::path::{Path, PathBuf};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn bytes(&mut self, n: usize) -> Vec<u8> {
        (0..n).map(|_| self.next() as u8).collect()
    }
}

/// Real-format headers, so parsers get past the magic number and into the interesting code.
const HEADERS: &[(&str, &[u8])] = &[
    ("jpg", &[0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x40, b'E', b'x', b'i', b'f', 0, 0, b'I', b'I', 42, 0, 8, 0, 0, 0]),
    ("png", &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R']),
    ("arw", &[b'I', b'I', 42, 0, 8, 0, 0, 0, 3, 0, 0x11, 0x01, 4, 0, 1, 0, 0, 0]),
    ("cr3", &[0, 0, 0, 24, b'f', b't', b'y', b'p', b'c', b'r', b'x', b' ']),
    ("mp4", &[0, 0, 0, 24, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm', 0, 0, 0, 0, 0, 0, 0, 40, b'm', b'o', b'o', b'v']),
    ("mov", &[0, 0, 0, 8, b'w', b'i', b'd', b'e', 0xFF, 0xFF, 0xFF, 0xFF, b'm', b'd', b'a', b't']),
    ("zip", &[b'P', b'K', 3, 4, 20, 0, 0, 0, 8, 0]),
    ("7z", &[b'7', b'z', 0xBC, 0xAF, 0x27, 0x1C, 0, 4]),
    ("rar", &[b'R', b'a', b'r', b'!', 0x1A, 0x07, 0x01, 0x00]),
    ("tar", &[]),
    ("gz", &[0x1F, 0x8B, 8, 0]),
    ("xlsx", &[b'P', b'K', 3, 4]),
    ("csv", b"a,b,c\n1,\"2\n"),
    ("txt", &[0xFF, 0xFE]),
];

fn dir() -> PathBuf {
    let d = std::env::temp_dir().join(format!("pifiles-robustness-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn exercise(path: &Path, ext: &str) {
    let p = path.to_string_lossy().to_string();
    match ext {
        "jpg" | "png" => {
            let _ = crate::thumbnail::decode_oriented(path, 128);
            let _ = crate::library::exif_meta(path);
        }
        "arw" | "cr3" => {
            let _ = crate::raw::embedded_preview(path, 128);
            let _ = crate::library::exif_meta(path);
        }
        "mp4" | "mov" => {
            let _ = crate::library::video_meta(path);
        }
        "zip" | "7z" | "rar" | "tar" | "gz" => {
            let _ = crate::archive::list(path, None);
            let _ = crate::archive::list(path, Some("pw"));
        }
        "xlsx" | "csv" => {
            let _ = crate::spreadsheet::read(path, None);
        }
        "txt" => {
            let _ = crate::viewer::text_open(&p);
        }
        _ => {}
    }
    let _ = crate::props::properties(&p);
}

#[test]
fn parsers_never_panic_on_garbage() {
    let d = dir();
    let mut rng = Rng(0x5EED_F00D_1234_5678);
    let mut panics = Vec::new();
    for round in 0..60 {
        for (ext, head) in HEADERS {
            // header + random tail, sometimes truncated, sometimes with bytes flipped in the header
            let mut data = head.to_vec();
            if round % 5 == 0 && !data.is_empty() {
                let i = (rng.next() as usize) % data.len();
                data[i] ^= rng.next() as u8;
            }
            let len = match round % 4 { 0 => 0, 1 => (rng.next() % 64) as usize, 2 => (rng.next() % 4096) as usize, _ => (rng.next() % 65536) as usize };
            data.extend(rng.bytes(len));
            let path = d.join(format!("case{round}.{ext}"));
            std::fs::write(&path, &data).unwrap();
            let ext_s = ext.to_string();
            let path2 = path.clone();
            let r = std::panic::catch_unwind(move || exercise(&path2, &ext_s));
            if r.is_err() {
                panics.push(format!("{ext} round {round} ({} bytes)", data.len()));
            }
            let _ = std::fs::remove_file(&path);
        }
    }
    let _ = std::fs::remove_dir_all(&d);
    assert!(panics.is_empty(), "parsers panicked on: {panics:?}");
}
