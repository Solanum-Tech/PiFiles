use rayon::prelude::*;
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::RwLock;
use std::time::SystemTime;
use walkdir::WalkDir;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SearchResult {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub matched: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
    pub total: usize,
    pub query: String,
    pub has_more: bool,
    pub took_ms: u128,
    pub indexed: bool,
}

// ---------- Global indexed search ----------
//
// Memory-lean file-name index. Instead of one heap `String` path + name per file (~250 bytes
// each), entries store a parent link and a slice of one shared name buffer (~30 bytes each), and
// full paths are rebuilt only for the results actually returned. The index lives on disk
// (binary cache in the app-data folder); it's loaded on the first search and dropped again
// after a few idle minutes, so an idle app holds none of it.

#[derive(Clone, Copy)]
struct Entry {
    parent: u32,
    name_off: u32,
    name_len: u16,
    is_dir: bool,
    size: u64,
}

const NO_PARENT: u32 = u32::MAX;
const MAX_ENTRIES: usize = 400_000;
const CACHE_TTL_SECS: u64 = 3600;
const IDLE_UNLOAD_SECS: u64 = 180;

#[derive(Default)]
struct Index {
    names: Vec<u8>,
    entries: Vec<Entry>,
}

impl Index {
    fn name(&self, e: &Entry) -> &str {
        std::str::from_utf8(&self.names[e.name_off as usize..e.name_off as usize + e.name_len as usize]).unwrap_or("")
    }
    fn push(&mut self, parent: u32, name: &str, is_dir: bool, size: u64) -> u32 {
        let bytes = name.as_bytes();
        let len = bytes.len().min(u16::MAX as usize);
        let off = self.names.len() as u32;
        self.names.extend_from_slice(&bytes[..len]);
        self.entries.push(Entry { parent, name_off: off, name_len: len as u16, is_dir, size });
        (self.entries.len() - 1) as u32
    }
    fn path(&self, mut i: u32) -> String {
        let mut parts: Vec<&str> = Vec::with_capacity(12);
        while i != NO_PARENT {
            let e = &self.entries[i as usize];
            parts.push(self.name(e));
            i = e.parent;
        }
        let mut out = String::new();
        for (n, p) in parts.iter().rev().enumerate() {
            if n > 0 && !out.ends_with(['\\', '/']) {
                out.push(std::path::MAIN_SEPARATOR);
            }
            out.push_str(p);
        }
        out
    }
    fn depth(&self, mut i: u32) -> usize {
        let mut d = 0;
        while i != NO_PARENT {
            i = self.entries[i as usize].parent;
            d += 1;
        }
        d
    }
}

static INDEX: RwLock<Option<std::sync::Arc<Index>>> = RwLock::new(None);
static INDEX_READY: AtomicBool = AtomicBool::new(false);
static INDEX_BUILDING: AtomicBool = AtomicBool::new(false);
static INDEX_SIZE: AtomicUsize = AtomicUsize::new(0);
static LAST_USE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn now_secs() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn cache_path() -> std::path::PathBuf {
    crate::app_data_dir().join("search_index_v2.bin")
}

fn cache_fresh() -> bool {
    std::fs::metadata(cache_path())
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .map(|age| age.as_secs() < CACHE_TTL_SECS)
        .unwrap_or(false)
}

fn save_cache(ix: &Index) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = cache_path().with_extension("tmp");
    let mut w = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
    w.write_all(b"PFIX2")?;
    w.write_all(&(ix.entries.len() as u32).to_le_bytes())?;
    w.write_all(&(ix.names.len() as u32).to_le_bytes())?;
    w.write_all(&ix.names)?;
    for e in &ix.entries {
        w.write_all(&e.parent.to_le_bytes())?;
        w.write_all(&e.name_off.to_le_bytes())?;
        w.write_all(&e.name_len.to_le_bytes())?;
        w.write_all(&[e.is_dir as u8])?;
        w.write_all(&e.size.to_le_bytes())?;
    }
    w.flush()?;
    drop(w);
    std::fs::rename(tmp, cache_path())
}

fn load_cache() -> Option<Index> {
    let data = std::fs::read(cache_path()).ok()?;
    if data.len() < 13 || &data[..5] != b"PFIX2" {
        return None;
    }
    let u32_at = |o: usize| u32::from_le_bytes(data[o..o + 4].try_into().unwrap());
    let (n, names_len) = (u32_at(5) as usize, u32_at(9) as usize);
    let names_end = 13 + names_len;
    const REC: usize = 4 + 4 + 2 + 1 + 8;
    if data.len() != names_end + n * REC {
        return None;
    }
    let mut ix = Index { names: data[13..names_end].to_vec(), entries: Vec::with_capacity(n) };
    for k in 0..n {
        let o = names_end + k * REC;
        let e = Entry {
            parent: u32_at(o),
            name_off: u32_at(o + 4),
            name_len: u16::from_le_bytes([data[o + 8], data[o + 9]]),
            is_dir: data[o + 10] != 0,
            size: u64::from_le_bytes(data[o + 11..o + 19].try_into().unwrap()),
        };
        if e.name_off as usize + e.name_len as usize > names_len || (e.parent != NO_PARENT && e.parent as usize >= n) {
            return None;
        }
        ix.entries.push(e);
    }
    Some(ix)
}

fn index_roots() -> Vec<String> {
    #[cfg(windows)]
    {
        let mut r = vec![];
        for letter in b'C'..=b'Z' {
            let p = format!("{}:\\", letter as char);
            if Path::new(&p).exists() {
                r.push(p);
            }
        }
        if r.is_empty() {
            r.push("C:\\".to_string());
        }
        r
    }
    #[cfg(not(windows))]
    {
        vec![std::env::var("HOME").unwrap_or_else(|_| "/".into())]
    }
}

/// Folders that only hold OS/app internals; skipping them keeps the index about user files.
fn skip_dir(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "$recycle.bin" | "system volume information" | "windows" | "winsxs" | "node_modules" | ".git" | "$windows.~bt" | "$windows.~ws" | "msocache" | "programdata" | "appdata"
    )
}

fn build_index() -> Index {
    let mut ix = Index::default();
    for root in index_roots() {
        if ix.entries.len() >= MAX_ENTRIES {
            break;
        }
        let root_idx = ix.push(NO_PARENT, &root, true, 0);
        // stack[d] = index of the directory at depth d on the current walk path.
        let mut stack: Vec<u32> = vec![root_idx];
        let walker = WalkDir::new(&root).follow_links(false).max_depth(12).min_depth(1).into_iter().filter_entry(|e| !(e.file_type().is_dir() && skip_dir(&e.file_name().to_string_lossy())));
        for entry in walker.filter_map(|e| e.ok()) {
            if ix.entries.len() >= MAX_ENTRIES {
                break;
            }
            let d = entry.depth();
            stack.truncate(d);
            let parent = *stack.last().unwrap_or(&root_idx);
            let is_dir = entry.file_type().is_dir();
            let size = if is_dir { 0 } else { entry.metadata().map(|m| m.len()).unwrap_or(0) };
            let i = ix.push(parent, &entry.file_name().to_string_lossy(), is_dir, size);
            if is_dir {
                stack.push(i);
            }
        }
    }
    ix.names.shrink_to_fit();
    ix.entries.shrink_to_fit();
    ix
}

/// Index for searching: memory if loaded, else the disk cache, else a fresh build.
fn acquire() -> std::sync::Arc<Index> {
    LAST_USE.store(now_secs(), Ordering::Relaxed);
    if let Some(ix) = INDEX.read().unwrap().as_ref() {
        return ix.clone();
    }
    let ix = match load_cache() {
        Some(ix) => ix,
        None => {
            INDEX_BUILDING.store(true, Ordering::Relaxed);
            let ix = build_index();
            let _ = save_cache(&ix);
            INDEX_BUILDING.store(false, Ordering::Relaxed);
            ix
        }
    };
    INDEX_SIZE.store(ix.entries.len(), Ordering::Relaxed);
    INDEX_READY.store(true, Ordering::Relaxed);
    let arc = std::sync::Arc::new(ix);
    *INDEX.write().unwrap() = Some(arc.clone());
    spawn_janitor();
    arc
}

/// Drops the in-memory index after a few idle minutes; the next search reloads it (~50 ms).
fn spawn_janitor() {
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("search-janitor".into())
        .spawn(|| loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            if now_secs().saturating_sub(LAST_USE.load(Ordering::Relaxed)) > IDLE_UNLOAD_SECS {
                if INDEX.write().unwrap().take().is_some() {
                    crate::perf::trim_memory();
                }
                RUNNING.store(false, Ordering::SeqCst);
                return;
            }
        })
        .ok();
}

/// Builds (or refreshes) the on-disk index in the background without keeping it in memory.
pub fn spawn_background_index() {
    if cache_fresh() {
        if let Some(n) = std::fs::metadata(cache_path()).ok().map(|m| m.len()) {
            // Entry count is stored in the header; read just that.
            let _ = n;
            if let Ok(mut f) = std::fs::File::open(cache_path()) {
                use std::io::Read;
                let mut h = [0u8; 9];
                if f.read_exact(&mut h).is_ok() && &h[..5] == b"PFIX2" {
                    INDEX_SIZE.store(u32::from_le_bytes(h[5..9].try_into().unwrap()) as usize, Ordering::Relaxed);
                    INDEX_READY.store(true, Ordering::Relaxed);
                }
            }
        }
        return;
    }
    rebuild();
}

pub fn rebuild() {
    if INDEX_BUILDING.swap(true, Ordering::SeqCst) {
        return;
    }
    // The old JSON cache lived in %TEMP% and was ~30 MB; it's no longer used.
    let _ = std::fs::remove_file(std::env::temp_dir().join("file_explorer_index.json"));
    std::thread::Builder::new()
        .name("search-index".into())
        .spawn(|| {
            crate::perf::background_priority();
            let ix = build_index();
            let _ = save_cache(&ix);
            INDEX_SIZE.store(ix.entries.len(), Ordering::Relaxed);
            INDEX_READY.store(true, Ordering::Relaxed);
            let mut slot = INDEX.write().unwrap();
            if slot.is_some() {
                *slot = Some(std::sync::Arc::new(ix));
            } else {
                drop(slot);
                drop(ix);
                crate::perf::trim_memory();
            }
            INDEX_BUILDING.store(false, Ordering::SeqCst);
        })
        .ok();
}

/// Case-insensitive substring test without allocating for ASCII queries.
fn contains_ci(hay: &str, needle_lower: &str, ascii: bool) -> bool {
    if ascii {
        let (h, n) = (hay.as_bytes(), needle_lower.as_bytes());
        if n.len() > h.len() {
            return false;
        }
        h.windows(n.len()).any(|w| w.iter().zip(n).all(|(a, b)| a.to_ascii_lowercase() == *b))
    } else {
        hay.to_lowercase().contains(needle_lower)
    }
}

pub fn search_files(query: &str, offset: usize, limit: usize) -> SearchResponse {
    let start = SystemTime::now();
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return SearchResponse { results: vec![], total: 0, query: query.to_string(), has_more: false, took_ms: 0, indexed: INDEX_READY.load(Ordering::Relaxed) };
    }
    let ix = acquire();
    let limit = limit.clamp(1, 200);
    let ascii = q.is_ascii();
    let mut hits: Vec<u32> = (0..ix.entries.len() as u32)
        .into_par_iter()
        .filter(|&i| {
            let e = &ix.entries[i as usize];
            e.parent != NO_PARENT && contains_ci(ix.name(e), &q, ascii)
        })
        .collect();
    // Relevance: exact name, then prefix, then shallower paths, then name.
    let rank = |i: u32| {
        let e = &ix.entries[i as usize];
        let n = ix.name(e);
        let exact = n.len() == q.len() && contains_ci(n, &q, ascii);
        let prefix = n.len() >= q.len() && n.is_char_boundary(q.len().min(n.len())) && contains_ci(&n[..q.len().min(n.len())], &q, ascii);
        (!exact, !prefix, ix.depth(i))
    };
    let mut keyed: Vec<((bool, bool, usize), u32)> = hits.drain(..).map(|i| (rank(i), i)).collect();
    keyed.par_sort_unstable_by(|a, b| a.0.cmp(&b.0).then_with(|| ix.name(&ix.entries[a.1 as usize]).cmp(ix.name(&ix.entries[b.1 as usize]))));
    let total = keyed.len();
    let results: Vec<SearchResult> = keyed
        .iter()
        .skip(offset)
        .take(limit)
        .map(|&(_, i)| {
            let e = &ix.entries[i as usize];
            SearchResult { path: ix.path(i), name: ix.name(e).to_string(), is_dir: e.is_dir, size: e.size, matched: q.clone() }
        })
        .collect();
    let has_more = total > offset + results.len();
    let took_ms = SystemTime::now().duration_since(start).unwrap_or_default().as_millis();
    SearchResponse { results, total, query: query.to_string(), has_more, took_ms, indexed: true }
}

pub fn get_index_status() -> serde_json::Value {
    serde_json::json!({
        "ready": INDEX_READY.load(Ordering::Relaxed),
        "building": INDEX_BUILDING.load(Ordering::Relaxed),
        "size": INDEX_SIZE.load(Ordering::Relaxed),
        "loaded": INDEX.read().unwrap().is_some(),
        "cache_path": cache_path().to_string_lossy()
    })
}

#[cfg(test)]
mod index_tests {
    use super::*;
    #[test]
    fn compact_index_paths_and_search() {
        let mut ix = Index::default();
        let root = ix.push(NO_PARENT, if cfg!(windows) { "C:\\" } else { "/" }, true, 0);
        let pics = ix.push(root, "Pictures", true, 0);
        let f = ix.push(pics, "Holiday Beach.JPG", false, 42);
        let sep = std::path::MAIN_SEPARATOR;
        let want = if cfg!(windows) { format!("C:\\Pictures{sep}Holiday Beach.JPG") } else { format!("/Pictures{sep}Holiday Beach.JPG") };
        assert_eq!(ix.path(f), want);
        assert!(contains_ci(ix.name(&ix.entries[f as usize]), "beach", true));
        assert!(!contains_ci("abc", "abcd", true));
        assert!(contains_ci("Ärger.txt", "ärg", false));
    }
}
