//! Previous versions ("File History"-style restore) for folders the user protects.
//!
//! Storage is content-addressed and de-duplicated: a file is cut into content-defined chunks
//! (gear-hash CDC, ~64 KiB average) that are zstd-compressed and stored once by SHA-256, and a
//! version is just the list of its chunk hashes. Editing a few bytes of a 2 GB file stores only
//! the handful of chunks around the edit, and identical files anywhere share all their chunks.
//!
//! Versions are captured
//!   * right before PiFiles itself overwrites or deletes a protected file (paste/replace, delete,
//!     saving in the built-in editors), and
//!   * by a background watcher when other programs change files in protected folders. The watcher
//!     can only see a change after it happened, so every protected file also gets a baseline
//!     version when its folder is added - that baseline is the "before" of the first change.
//!     A catch-up pass at startup records what changed while PiFiles wasn't running.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

const MIN_CHUNK: usize = 16 * 1024;
const MAX_CHUNK: usize = 256 * 1024;
const MASK: u64 = (1 << 16) - 1; // ~64 KiB average

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Config {
    pub enabled: bool,
    /// Where versions are kept (ideally another drive).
    pub store: String,
    /// Folders whose files get versions.
    pub protected: Vec<String>,
    /// Files bigger than this are not versioned.
    pub max_file_mb: u64,
    /// Versions kept per file (oldest are dropped).
    pub keep: usize,
    /// Watch protected folders for changes made by other programs.
    pub watch: bool,
}

impl Default for Config {
    fn default() -> Self {
        let kf = crate::fs::known_folders();
        let protected = ["documents", "desktop"].iter().filter_map(|k| kf.get(*k).cloned()).collect();
        Config {
            enabled: false,
            store: crate::app_data_dir().join("versions").to_string_lossy().to_string(),
            protected,
            max_file_mb: 1024,
            keep: 30,
            watch: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Version {
    /// Capture time (ms since epoch) - also the version id.
    pub t: u64,
    /// File modification time (s) of the captured content.
    pub mtime: u64,
    pub size: u64,
    pub chunks: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct FileHistory {
    path: String,
    versions: Vec<Version>,
}

#[derive(Serialize, Clone, Debug)]
pub struct VersionInfo {
    pub id: u64,
    pub captured: u64,
    pub modified: u64,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Stats {
    pub files: usize,
    pub versions: usize,
    /// Sum of all version sizes (what plain copies would take).
    pub logical_bytes: u64,
    /// Bytes actually used on disk by the chunk store.
    pub stored_bytes: u64,
    pub baseline_running: bool,
}

fn config_path() -> PathBuf {
    crate::app_data_dir().join("versions.json")
}

fn config() -> &'static RwLock<Config> {
    static C: OnceLock<RwLock<Config>> = OnceLock::new();
    C.get_or_init(|| {
        let cfg = std::fs::read(config_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        RwLock::new(cfg)
    })
}

pub fn get_config() -> Config {
    config().read().unwrap().clone()
}

pub fn set_config(new: Config) -> Result<Config, String> {
    if new.enabled {
        std::fs::create_dir_all(&new.store).map_err(|e| format!("Can't use that folder for versions: {e}"))?;
    }
    let old = get_config();
    let json = serde_json::to_vec_pretty(&new).map_err(|e| e.to_string())?;
    std::fs::write(config_path(), json).map_err(|e| e.to_string())?;
    *config().write().unwrap() = new.clone();
    if new.enabled {
        // New folders (or switching on) need a baseline so their next change can be undone.
        let added: Vec<String> = if old.enabled { new.protected.iter().filter(|p| !old.protected.contains(p)).cloned().collect() } else { new.protected.clone() };
        spawn_baseline(added);
        restart_watcher();
    } else {
        stop_watcher();
    }
    Ok(new)
}

fn store() -> PathBuf {
    PathBuf::from(get_config().store)
}

fn norm(p: &Path) -> String {
    let s = p.to_string_lossy().replace('/', "\\");
    if cfg!(windows) { s.to_lowercase() } else { p.to_string_lossy().to_string() }
}

fn is_protected(p: &Path) -> bool {
    let c = get_config();
    if !c.enabled {
        return false;
    }
    let n = norm(p);
    if n.starts_with(&norm(Path::new(&c.store))) {
        return false;
    }
    c.protected.iter().any(|root| {
        let r = norm(Path::new(root));
        let r = r.trim_end_matches('\\');
        n.starts_with(&format!("{r}\\")) || n.starts_with(&format!("{r}/"))
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn index_file(p: &Path) -> PathBuf {
    let h = Sha256::digest(norm(p).as_bytes());
    store().join("index").join(format!("{}.json", &hex(&h)[..32]))
}

fn chunk_file(hash: &str) -> PathBuf {
    store().join("chunks").join(&hash[..2]).join(format!("{hash}.zst"))
}

fn gear() -> &'static [u64; 256] {
    static G: OnceLock<[u64; 256]> = OnceLock::new();
    G.get_or_init(|| {
        let mut g = [0u64; 256];
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        for v in g.iter_mut() {
            // splitmix64: fixed table so chunk boundaries are stable across runs.
            x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = x;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            *v = z ^ (z >> 31);
        }
        g
    })
}

/// Length of the next content-defined chunk at the start of `data`.
fn cut(data: &[u8]) -> usize {
    if data.len() <= MIN_CHUNK {
        return data.len();
    }
    let g = gear();
    let end = data.len().min(MAX_CHUNK);
    let mut h: u64 = 0;
    for (i, b) in data.iter().enumerate().take(end).skip(MIN_CHUNK) {
        h = (h << 1).wrapping_add(g[*b as usize]);
        if h & MASK == 0 {
            return i + 1;
        }
    }
    end
}

fn put_chunk(data: &[u8]) -> std::io::Result<String> {
    let hash = hex(&Sha256::digest(data));
    let path = chunk_file(&hash);
    if !path.exists() {
        std::fs::create_dir_all(path.parent().unwrap())?;
        let packed = zstd::encode_all(data, 3)?;
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, packed)?;
        std::fs::rename(&tmp, &path)?;
    }
    Ok(hash)
}

fn load_history(p: &Path) -> FileHistory {
    std::fs::read(index_file(p)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_history(p: &Path, h: &FileHistory) -> std::io::Result<()> {
    let f = index_file(p);
    std::fs::create_dir_all(f.parent().unwrap())?;
    let tmp = f.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(h)?)?;
    std::fs::rename(tmp, f)
}

fn secs(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

/// Records the current content of `p` as a version (no-op when unchanged since the last one).
pub fn snapshot(p: &Path) -> Result<bool, String> {
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Ok(false);
    }
    let cfg = get_config();
    if meta.len() > cfg.max_file_mb * 1024 * 1024 {
        return Ok(false);
    }
    let mt = meta.modified().map(secs).unwrap_or(0);
    let _g = lock().lock().unwrap();
    let mut hist = load_history(p);
    if let Some(last) = hist.versions.last() {
        if last.size == meta.len() && last.mtime == mt {
            return Ok(false);
        }
    }
    let mut file = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let mut chunks = Vec::new();
    let mut buf: Vec<u8> = Vec::with_capacity(2 * MAX_CHUNK);
    let mut block = vec![0u8; 1024 * 1024];
    let mut eof = false;
    loop {
        while !eof && buf.len() < MAX_CHUNK {
            let n = file.read(&mut block).map_err(|e| e.to_string())?;
            if n == 0 {
                eof = true;
            } else {
                buf.extend_from_slice(&block[..n]);
            }
        }
        if buf.is_empty() {
            break;
        }
        let n = if eof && buf.len() <= MAX_CHUNK { cut(&buf).min(buf.len()) } else { cut(&buf) };
        chunks.push(put_chunk(&buf[..n]).map_err(|e| e.to_string())?);
        buf.drain(..n);
    }
    if hist.versions.last().map(|v| v.chunks == chunks).unwrap_or(false) {
        // Same bytes, only the timestamp moved: refresh the stamp, keep one version.
        if let Some(v) = hist.versions.last_mut() {
            v.mtime = mt;
        }
        let _ = save_history(p, &hist);
        return Ok(false);
    }
    hist.path = p.to_string_lossy().to_string();
    hist.versions.push(Version { t: now_ms(), mtime: mt, size: meta.len(), chunks });
    let keep = cfg.keep.max(1);
    if hist.versions.len() > keep {
        let drop = hist.versions.len() - keep;
        hist.versions.drain(..drop);
    }
    save_history(p, &hist).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Edits made inside PiFiles (image editor, text and spreadsheet editors) always keep the
/// previous version, even when version history is turned off globally: the user changed the
/// file *here*, so they must be able to get the original back from here.
pub fn before_edit(p: &Path) {
    if let Err(e) = snapshot(p) {
        eprintln!("[versions] couldn't keep a version of {}: {e}", p.display());
    }
}

/// Hook for PiFiles' own writes: save what is about to be overwritten or deleted.
pub fn before_change(p: &Path) {
    if is_protected(p) {
        let _ = snapshot(p);
    }
}

pub fn list(p: &Path) -> Vec<VersionInfo> {
    let mut v: Vec<VersionInfo> = load_history(p)
        .versions
        .iter()
        .map(|v| VersionInfo { id: v.t, captured: v.t, modified: v.mtime, size: v.size })
        .collect();
    v.reverse();
    v
}

/// Writes version `id` of `p` to `target` (default: back over `p`, after saving the current content).
pub fn restore(p: &Path, id: u64, target: Option<&Path>) -> Result<PathBuf, String> {
    let hist = load_history(p);
    let ver = hist.versions.iter().find(|v| v.t == id).ok_or("That version no longer exists")?.clone();
    let out = target.map(Path::to_path_buf).unwrap_or_else(|| p.to_path_buf());
    if out == p && p.exists() {
        let _ = snapshot(p);
    }
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = out.with_extension("pifiles-restore");
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        for h in &ver.chunks {
            let packed = std::fs::read(chunk_file(h)).map_err(|_| "Part of that version is missing from the store".to_string())?;
            let data = zstd::decode_all(&packed[..]).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut f, &data).map_err(|e| e.to_string())?;
        }
    }
    let _ = std::fs::remove_file(&out);
    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    if let Ok(f) = std::fs::File::options().write(true).open(&out) {
        let _ = f.set_times(std::fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(ver.mtime)));
    }
    Ok(out)
}

/// Deleted files under `folder` that still have versions (so they can be brought back).
pub fn deleted_in(folder: &Path) -> Vec<(String, VersionInfo)> {
    let n = norm(folder);
    let n = n.trim_end_matches('\\').to_string();
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(store().join("index")) else { return out };
    for e in rd.flatten() {
        let Ok(b) = std::fs::read(e.path()) else { continue };
        let Ok(h) = serde_json::from_slice::<FileHistory>(&b) else { continue };
        let p = Path::new(&h.path);
        let pn = norm(p);
        if pn.starts_with(&format!("{n}\\")) && !p.exists() {
            if let Some(v) = h.versions.last() {
                out.push((h.path.clone(), VersionInfo { id: v.t, captured: v.t, modified: v.mtime, size: v.size }));
            }
        }
    }
    out
}

pub fn stats() -> Stats {
    let mut s = Stats { baseline_running: BASELINE.load(Ordering::Relaxed), ..Default::default() };
    if let Ok(rd) = std::fs::read_dir(store().join("index")) {
        for e in rd.flatten() {
            if let Ok(h) = std::fs::read(e.path()).map_err(|_| ()).and_then(|b| serde_json::from_slice::<FileHistory>(&b).map_err(|_| ())) {
                s.files += 1;
                s.versions += h.versions.len();
                s.logical_bytes += h.versions.iter().map(|v| v.size).sum::<u64>();
            }
        }
    }
    for e in WalkDir::new(store().join("chunks")).into_iter().filter_map(|e| e.ok()) {
        if e.file_type().is_file() {
            s.stored_bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    s
}

/// Deletes chunks no version refers to any more. Returns bytes freed.
pub fn cleanup() -> u64 {
    let _g = lock().lock().unwrap();
    let mut live = HashSet::new();
    if let Ok(rd) = std::fs::read_dir(store().join("index")) {
        for e in rd.flatten() {
            if let Some(h) = std::fs::read(e.path()).ok().and_then(|b| serde_json::from_slice::<FileHistory>(&b).ok()) {
                for v in h.versions {
                    live.extend(v.chunks);
                }
            }
        }
    }
    let mut freed = 0;
    for e in WalkDir::new(store().join("chunks")).into_iter().filter_map(|e| e.ok()) {
        let name = e.file_name().to_string_lossy().to_string();
        if let Some(h) = name.strip_suffix(".zst") {
            if !live.contains(h) {
                freed += e.metadata().map(|m| m.len()).unwrap_or(0);
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    freed
}

// ---------- baseline + watcher ----------

static BASELINE: AtomicBool = AtomicBool::new(false);

fn skip_dir(name: &str) -> bool {
    let l = name.to_lowercase();
    l.starts_with('.') || matches!(l.as_str(), "node_modules" | "target" | "$recycle.bin" | "__pycache__")
}

/// Versions every file under `roots` that has none yet or changed since its last version.
fn spawn_baseline(roots: Vec<String>) {
    if roots.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        BASELINE.store(true, Ordering::Relaxed);
        for root in roots {
            for e in WalkDir::new(&root)
                .into_iter()
                .filter_entry(|e| !(e.file_type().is_dir() && e.depth() > 0 && skip_dir(&e.file_name().to_string_lossy())))
                .filter_map(|e| e.ok())
            {
                if !get_config().enabled {
                    break;
                }
                if e.file_type().is_file() {
                    let _ = snapshot(e.path());
                }
            }
        }
        BASELINE.store(false, Ordering::Relaxed);
    });
}

struct Watch {
    _w: notify::RecommendedWatcher,
}

fn watcher_slot() -> &'static Mutex<Option<Watch>> {
    static W: OnceLock<Mutex<Option<Watch>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(None))
}

fn pending() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    static P: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

fn stop_watcher() {
    *watcher_slot().lock().unwrap() = None;
}

fn restart_watcher() {
    use notify::{RecursiveMode, Watcher};
    stop_watcher();
    let cfg = get_config();
    if !cfg.enabled || !cfg.watch {
        return;
    }
    let mut w = match notify::recommended_watcher(|res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if matches!(ev.kind, notify::EventKind::Modify(_) | notify::EventKind::Create(_)) {
                let mut p = pending().lock().unwrap();
                for path in ev.paths {
                    p.insert(path, Instant::now());
                }
            }
        }
    }) {
        Ok(w) => w,
        Err(_) => return,
    };
    for root in &cfg.protected {
        let _ = w.watch(Path::new(root), RecursiveMode::Recursive);
    }
    *watcher_slot().lock().unwrap() = Some(Watch { _w: w });
    static DRAIN: OnceLock<()> = OnceLock::new();
    DRAIN.get_or_init(|| {
        // Snapshot files once they've been quiet for 2 s (editors save in several writes).
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_secs(1));
            let ready: Vec<PathBuf> = {
                let mut p = pending().lock().unwrap();
                let now = Instant::now();
                let ready: Vec<PathBuf> = p.iter().filter(|(_, t)| now.duration_since(**t) > Duration::from_secs(2)).map(|(k, _)| k.clone()).collect();
                for r in &ready {
                    p.remove(r);
                }
                ready
            };
            for path in ready {
                if path.is_file() && is_protected(&path) {
                    let _ = snapshot(&path);
                }
            }
        });
    });
}

/// Called once at startup: watch protected folders and catch up on changes made while closed.
pub fn init() {
    let cfg = get_config();
    if cfg.enabled {
        restart_watcher();
        spawn_baseline(cfg.protected.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_dedupe_and_restore() {
        let root = std::env::temp_dir().join(format!("pifiles-versions-{}", now_ms()));
        let docs = root.join("docs");
        std::fs::create_dir_all(&docs).unwrap();
        *config().write().unwrap() = Config {
            enabled: true,
            store: root.join("store").to_string_lossy().to_string(),
            protected: vec![docs.to_string_lossy().to_string()],
            max_file_mb: 100,
            keep: 10,
            watch: false,
        };
        // 3 MB of pseudo-random data, then a small edit in the middle.
        let mut x: u32 = 1;
        let mut data: Vec<u8> = (0..3_000_000).map(|_| { x ^= x << 13; x ^= x >> 17; x ^= x << 5; x as u8 }).collect();
        let f = docs.join("report.bin");
        std::fs::write(&f, &data).unwrap();
        assert!(snapshot(&f).unwrap());
        assert!(!snapshot(&f).unwrap(), "unchanged file must not create a version");
        let after_first = stats().stored_bytes;
        let original = data.clone();

        data[1_500_000..1_500_010].copy_from_slice(b"EDITEDEDIT");
        std::thread::sleep(Duration::from_millis(1100)); // new mtime
        std::fs::write(&f, &data).unwrap();
        assert!(snapshot(&f).unwrap());
        let growth = stats().stored_bytes - after_first;
        assert!(growth < 600_000, "an edit should store only nearby chunks, stored {growth} bytes");

        let vs = list(&f);
        assert_eq!(vs.len(), 2);
        let out = restore(&f, vs[1].id, Some(&root.join("old.bin"))).unwrap();
        assert!(std::fs::read(out).unwrap() == original, "older version restores byte-for-byte");

        std::fs::remove_file(&f).unwrap();
        assert_eq!(deleted_in(&docs).len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }
}
