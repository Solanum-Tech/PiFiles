//! File operations engine: copy, move, recycle and delete with live progress.
//!
//! Every operation is a background job with an id that the UI gets back immediately. A reporter
//! thread publishes `fileop://update` ~8 times a second with bytes/files done, the current file,
//! a smoothed speed and an ETA, so the operations panel is genuinely real time.
//!
//! Speed: large files go through the OS copy engine (`CopyFileExW` on Windows: kernel-side copy,
//! server-side offload on SMB, unbuffered I/O for very large files) one at a time; small files are
//! copied in parallel because per-file overhead, not bandwidth, dominates them. Moves within a
//! volume are renames and finish instantly.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use walkdir::WalkDir;

/// Files at least this big are copied one at a time with byte-level progress.
const LARGE_FILE: u64 = 8 * 1024 * 1024;
/// Files at least this big skip the system cache (what Explorer does for huge copies).
const UNBUFFERED_FILE: u64 = 512 * 1024 * 1024;

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Scanning,
    Running,
    Paused,
    Done,
    Failed,
    Cancelled,
}

#[derive(Serialize, Clone, Debug)]
pub struct JobStatus {
    pub id: String,
    pub kind: String,
    pub state: JobState,
    pub sources: Vec<String>,
    pub dest: Option<String>,
    pub current: String,
    pub files_done: u64,
    pub files_total: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub speed_bps: u64,
    pub eta_secs: Option<u64>,
    pub errors: Vec<String>,
    pub skipped: u64,
    pub started_ms: u64,
    pub finished_ms: Option<u64>,
    /// Top-level items created at the destination (so the UI can select them after a paste).
    pub outputs: Vec<String>,
}

struct Job {
    status: Mutex<JobStatus>,
    cancel: AtomicBool,
    pause: AtomicBool,
    bytes: AtomicU64,
    files: AtomicU64,
    current: Mutex<String>,
}

impl Job {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
    /// Blocks while paused; returns false if the job was cancelled meanwhile.
    fn wait_if_paused(&self) -> bool {
        while self.pause.load(Ordering::Relaxed) && !self.cancelled() {
            std::thread::sleep(Duration::from_millis(80));
        }
        !self.cancelled()
    }
    fn set_current(&self, p: &Path) {
        if let Ok(mut c) = self.current.lock() {
            *c = p.to_string_lossy().to_string();
        }
    }
    fn error(&self, msg: String) {
        if let Ok(mut s) = self.status.lock() {
            if s.errors.len() < 200 {
                s.errors.push(msg);
            }
        }
    }
    fn skip(&self) {
        if let Ok(mut s) = self.status.lock() {
            s.skipped += 1;
        }
    }
}

fn jobs() -> &'static Mutex<HashMap<String, Arc<Job>>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Arc<Job>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn new_id() -> String {
    static N: AtomicU64 = AtomicU64::new(1);
    format!("job{}-{}", now_ms(), N.fetch_add(1, Ordering::Relaxed))
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Conflict {
    /// Keep both: the incoming item gets a free name such as "photo (2).jpg".
    Rename,
    Replace,
    Skip,
    /// Replace only when the incoming file is newer.
    Newer,
}

impl Conflict {
    pub fn parse(s: Option<&str>) -> Conflict {
        match s.unwrap_or("rename") {
            "replace" => Conflict::Replace,
            "skip" => Conflict::Skip,
            "newer" => Conflict::Newer,
            _ => Conflict::Rename,
        }
    }
}

// ---------- names and volumes ----------

fn split_name(name: &str) -> (String, String) {
    match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
        _ => (name.to_string(), String::new()),
    }
}

/// "photo.jpg" -> "photo (2).jpg", "photo (3).jpg", … (or "photo - Copy.jpg" when duplicating in place).
fn free_name(dir: &Path, name: &str, is_dir: bool, copy_suffix: bool) -> PathBuf {
    let (stem, ext) = if is_dir { (name.to_string(), String::new()) } else { split_name(name) };
    let base = if copy_suffix { format!("{stem} - Copy") } else { stem.clone() };
    if copy_suffix {
        let p = dir.join(format!("{base}{ext}"));
        if !p.exists() {
            return p;
        }
    }
    for n in 2..10_000 {
        let p = dir.join(format!("{base} ({n}){ext}"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{base} ({}){ext}", now_ms()))
}

#[cfg(windows)]
fn volume_of(p: &Path) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetVolumePathNameW;
    let wide: Vec<u16> = p.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut buf = [0u16; 512];
    let ok = unsafe { GetVolumePathNameW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
    if ok == 0 {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(0);
    Some(String::from_utf16_lossy(&buf[..len]).to_lowercase())
}

#[cfg(unix)]
fn volume_of(p: &Path) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let mut cur = Some(p);
    while let Some(c) = cur {
        if let Ok(m) = std::fs::metadata(c) {
            return Some(m.dev().to_string());
        }
        cur = c.parent();
    }
    None
}

fn same_volume(a: &Path, b: &Path) -> bool {
    match (volume_of(a), volume_of(b)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

// ---------- planning ----------

struct FileTask {
    src: PathBuf,
    dst: PathBuf,
    size: u64,
}

struct TopItem {
    src: PathBuf,
    dst: PathBuf,
    is_dir: bool,
    /// Destination already existed and is being merged into / replaced.
    merge: bool,
}

#[derive(Default)]
struct Plan {
    items: Vec<TopItem>,
    files: Vec<FileTask>,
    dirs: Vec<PathBuf>,
    bytes: u64,
}

fn is_inside(child: &Path, parent: &Path) -> bool {
    let c = child.to_string_lossy().to_lowercase().replace('/', "\\");
    let p = parent.to_string_lossy().to_lowercase().replace('/', "\\");
    let p = p.trim_end_matches('\\');
    c == p || c.starts_with(&format!("{p}\\"))
}

fn plan(job: &Job, sources: &[String], dest: &Path, policy: Conflict, is_move: bool) -> Result<Plan, String> {
    if !dest.is_dir() {
        return Err(format!("The destination folder doesn't exist: {}", dest.display()));
    }
    let mut plan = Plan::default();
    for s in sources {
        if job.cancelled() {
            break;
        }
        let src = PathBuf::from(s);
        let meta = std::fs::symlink_metadata(&src).map_err(|e| format!("{}: {e}", src.display()))?;
        let is_dir = meta.is_dir();
        let name = src.file_name().ok_or_else(|| format!("Invalid source: {s}"))?.to_string_lossy().to_string();
        if is_dir && is_inside(dest, &src) {
            if is_move && src.parent().map(|p| is_inside(p, dest) && is_inside(dest, p)).unwrap_or(false) {
                continue; // moving into its own parent: nothing to do
            }
            return Err(format!("“{name}” can't be copied into itself."));
        }
        let mut dst = dest.join(&name);
        let in_place = src.parent().map(|p| is_inside(p, dest) && is_inside(dest, p)).unwrap_or(false);
        let mut merge = false;
        if in_place {
            if is_move {
                continue; // moving into the folder it is already in
            }
            dst = free_name(dest, &name, is_dir, true);
        } else if dst.exists() {
            match policy {
                Conflict::Rename => dst = free_name(dest, &name, is_dir, false),
                Conflict::Skip if !is_dir => {
                    job.skip();
                    continue;
                }
                Conflict::Newer if !is_dir && mtime(&src) <= mtime(&dst) => {
                    job.skip();
                    continue;
                }
                _ => merge = true,
            }
        }
        if is_dir {
            plan.dirs.push(dst.clone());
            for e in WalkDir::new(&src).min_depth(1).follow_links(false) {
                let e = match e {
                    Ok(e) => e,
                    Err(err) => {
                        job.error(err.to_string());
                        continue;
                    }
                };
                let rel = e.path().strip_prefix(&src).unwrap_or(e.path());
                let d = dst.join(rel);
                if e.file_type().is_dir() {
                    plan.dirs.push(d);
                    continue;
                }
                if merge && d.exists() {
                    let keep_existing = match policy {
                        Conflict::Skip => true,
                        Conflict::Newer => mtime(e.path()) <= mtime(&d),
                        _ => false,
                    };
                    if keep_existing {
                        job.skip();
                        continue;
                    }
                }
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                plan.bytes += size;
                plan.files.push(FileTask { src: e.path().to_path_buf(), dst: d, size });
            }
        } else {
            let size = meta.len();
            plan.bytes += size;
            plan.files.push(FileTask { src: src.clone(), dst: dst.clone(), size });
        }
        plan.items.push(TopItem { src, dst, is_dir, merge });
    }
    Ok(plan)
}

// ---------- copying one file ----------

#[cfg(windows)]
mod oscopy {
    use super::Job;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        CopyFileExW, COPY_FILE_NO_BUFFERING, PROGRESS_CANCEL, PROGRESS_CONTINUE,
    };

    struct Ctx<'a> {
        job: &'a Job,
        last: i64,
    }

    unsafe extern "system" fn progress(
        _total: i64,
        transferred: i64,
        _stream_size: i64,
        _stream_transferred: i64,
        _stream: u32,
        _reason: u32,
        _src: HANDLE,
        _dst: HANDLE,
        data: *const core::ffi::c_void,
    ) -> u32 {
        let ctx = &mut *(data as *mut Ctx);
        let delta = transferred - ctx.last;
        if delta > 0 {
            ctx.job.bytes.fetch_add(delta as u64, Ordering::Relaxed);
            ctx.last = transferred;
        }
        if !ctx.job.wait_if_paused() {
            return PROGRESS_CANCEL;
        }
        PROGRESS_CONTINUE
    }

    fn wide(p: &Path) -> Vec<u16> {
        // Long-path prefix so deep trees (>260 chars) copy too.
        let s = p.to_string_lossy();
        let s = if s.len() > 240 && !s.starts_with(r"\\?\") {
            if let Some(unc) = s.strip_prefix(r"\\") { format!(r"\\?\UNC\{unc}") } else { format!(r"\\?\{s}") }
        } else {
            s.to_string()
        };
        std::ffi::OsStr::new(&s).encode_wide().chain(Some(0)).collect()
    }

    /// Copies with the OS engine; bytes are reported to the job as they move.
    pub fn copy(job: &Job, src: &Path, dst: &Path, size: u64, track: bool) -> std::io::Result<()> {
        let (s, d) = (wide(src), wide(dst));
        let flags = if size >= super::UNBUFFERED_FILE { COPY_FILE_NO_BUFFERING } else { 0 };
        let mut ctx = Ctx { job, last: 0 };
        let ok = unsafe {
            CopyFileExW(
                s.as_ptr(),
                d.as_ptr(),
                if track { Some(progress) } else { None },
                &mut ctx as *mut Ctx as *const core::ffi::c_void,
                std::ptr::null_mut(),
                flags,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if !track {
            job.bytes.fetch_add(size, Ordering::Relaxed);
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod oscopy {
    use super::Job;
    use std::io::{Read, Write};
    use std::path::Path;
    use std::sync::atomic::Ordering;

    pub fn copy(job: &Job, src: &Path, dst: &Path, size: u64, track: bool) -> std::io::Result<()> {
        if !track {
            // std::fs::copy uses clonefile/fcopyfile (macOS) and copy_file_range (Linux).
            std::fs::copy(src, dst)?;
            job.bytes.fetch_add(size, Ordering::Relaxed);
            return Ok(());
        }
        let mut input = std::fs::File::open(src)?;
        let mut output = std::fs::File::create(dst)?;
        let mut buf = vec![0u8; 8 * 1024 * 1024];
        loop {
            if !job.wait_if_paused() {
                drop(output);
                let _ = std::fs::remove_file(dst);
                return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled"));
            }
            let n = input.read(&mut buf)?;
            if n == 0 {
                break;
            }
            output.write_all(&buf[..n])?;
            job.bytes.fetch_add(n as u64, Ordering::Relaxed);
        }
        output.flush()?;
        drop(output);
        if let Ok(m) = std::fs::metadata(src) {
            let _ = std::fs::set_permissions(dst, m.permissions());
            if let Ok(t) = m.modified() {
                if let Ok(f) = std::fs::File::options().write(true).open(dst) {
                    let _ = f.set_times(std::fs::FileTimes::new().set_modified(t));
                }
            }
        }
        Ok(())
    }
}

/// Copies one file, replacing the destination (after saving a restorable version of it).
fn copy_one(job: &Job, t: &FileTask, track: bool) -> bool {
    if !job.wait_if_paused() {
        return false;
    }
    job.set_current(&t.src);
    if let Some(parent) = t.dst.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if t.dst.exists() {
        crate::versions::before_change(&t.dst);
        let _ = std::fs::remove_file(&t.dst);
    }
    let before = job.bytes.load(Ordering::Relaxed);
    match oscopy::copy(job, &t.src, &t.dst, t.size, track) {
        Ok(()) => {
            job.files.fetch_add(1, Ordering::Relaxed);
            true
        }
        Err(e) => {
            // Undo partial byte counts so the bar doesn't overshoot.
            let now = job.bytes.load(Ordering::Relaxed);
            if now > before {
                job.bytes.fetch_sub(now - before, Ordering::Relaxed);
            }
            if !job.cancelled() {
                job.error(format!("{}: {}", t.src.display(), friendly_io(&e)));
            }
            false
        }
    }
}

fn friendly_io(e: &std::io::Error) -> String {
    match e.raw_os_error() {
        Some(5) => "access denied".into(),
        Some(32) | Some(33) => "the file is in use by another program".into(),
        Some(39) | Some(112) => "there isn't enough space on the disk".into(),
        Some(1235) => "cancelled".into(),
        _ => e.to_string(),
    }
}

/// Copies all planned files: small ones in parallel, large ones in order with byte progress.
/// Returns the set of sources that failed.
fn run_copy(job: &Job, plan: &Plan) -> Vec<PathBuf> {
    for d in &plan.dirs {
        let _ = std::fs::create_dir_all(d);
    }
    let failed = Mutex::new(Vec::new());
    let (small, large): (Vec<&FileTask>, Vec<&FileTask>) = plan.files.iter().partition(|t| t.size < LARGE_FILE);
    if !small.is_empty() {
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8);
        if let Ok(pool) = rayon::ThreadPoolBuilder::new().num_threads(threads).build() {
            pool.install(|| {
                use rayon::prelude::*;
                small.par_iter().for_each(|t| {
                    if job.cancelled() {
                        return;
                    }
                    if !copy_one(job, t, false) {
                        failed.lock().unwrap().push(t.src.clone());
                    }
                });
            });
        }
    }
    for t in large {
        if job.cancelled() {
            break;
        }
        if !copy_one(job, t, true) {
            failed.lock().unwrap().push(t.src.clone());
        }
    }
    failed.into_inner().unwrap_or_default()
}

// ---------- delete ----------

#[cfg(windows)]
pub fn recycle(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW,
    };
    let mut from: Vec<u16> = path.as_os_str().encode_wide().collect();
    from.extend([0, 0]); // double-NUL-terminated list
    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT).0 as u16,
        ..Default::default()
    };
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 || op.fAnyOperationsAborted.as_bool() {
        return Err(format!("couldn't move it to the Recycle Bin (error {code:#x})"));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn recycle(path: &Path) -> Result<(), String> {
    trash::delete(path).map_err(|e| e.to_string())
}

fn run_delete(job: &Job, sources: &[String], permanent: bool) {
    if !permanent {
        for s in sources {
            if !job.wait_if_paused() {
                return;
            }
            let p = Path::new(s);
            job.set_current(p);
            if p.exists() {
                if let Err(e) = recycle(p) {
                    job.error(format!("{s}: {e}"));
                    continue;
                }
            }
            job.files.fetch_add(1, Ordering::Relaxed);
        }
        return;
    }
    // Permanent: remove file by file so progress is real, then the emptied folders.
    for s in sources {
        let p = Path::new(s);
        let Ok(meta) = std::fs::symlink_metadata(p) else {
            continue;
        };
        if !meta.is_dir() {
            if !job.wait_if_paused() {
                return;
            }
            job.set_current(p);
            crate::versions::before_change(p);
            match std::fs::remove_file(p) {
                Ok(()) => {
                    job.files.fetch_add(1, Ordering::Relaxed);
                    job.bytes.fetch_add(meta.len(), Ordering::Relaxed);
                }
                Err(e) => job.error(format!("{s}: {}", friendly_io(&e))),
            }
            continue;
        }
        let mut dirs = Vec::new();
        for e in WalkDir::new(p).follow_links(false).into_iter().filter_map(|e| e.ok()) {
            if e.file_type().is_dir() {
                dirs.push(e.path().to_path_buf());
                continue;
            }
            if !job.wait_if_paused() {
                return;
            }
            job.set_current(e.path());
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            crate::versions::before_change(e.path());
            match std::fs::remove_file(e.path()) {
                Ok(()) => {
                    job.files.fetch_add(1, Ordering::Relaxed);
                    job.bytes.fetch_add(size, Ordering::Relaxed);
                }
                Err(err) => job.error(format!("{}: {}", e.path().display(), friendly_io(&err))),
            }
        }
        for d in dirs.iter().rev() {
            let _ = std::fs::remove_dir(d);
        }
        if p.exists() {
            job.error(format!("{s}: some items couldn't be removed"));
        }
    }
}

fn count_tree(job: &Job, sources: &[String]) -> (u64, u64) {
    let (mut files, mut bytes) = (0u64, 0u64);
    for s in sources {
        for e in WalkDir::new(s).follow_links(false).into_iter().filter_map(|e| e.ok()) {
            if job.cancelled() {
                return (files, bytes);
            }
            if !e.file_type().is_dir() {
                files += 1;
                bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    (files, bytes)
}

// ---------- job lifecycle ----------

fn snapshot(job: &Job, speed: u64) -> JobStatus {
    let mut s = job.status.lock().unwrap().clone();
    s.bytes_done = job.bytes.load(Ordering::Relaxed);
    s.files_done = job.files.load(Ordering::Relaxed);
    s.current = job.current.lock().map(|c| c.clone()).unwrap_or_default();
    if s.state == JobState::Running && job.pause.load(Ordering::Relaxed) {
        s.state = JobState::Paused;
    }
    s.speed_bps = speed;
    s.eta_secs = if speed > 0 && s.bytes_total > s.bytes_done && s.state == JobState::Running {
        Some((s.bytes_total - s.bytes_done) / speed)
    } else {
        None
    };
    s
}

fn set_state(job: &Job, st: JobState) {
    if let Ok(mut s) = job.status.lock() {
        s.state = st;
        if matches!(st, JobState::Done | JobState::Failed | JobState::Cancelled) {
            s.finished_ms = Some(now_ms());
        }
    }
}

/// Publishes progress until the job finishes. Speed is averaged over the last ~3 seconds.
fn spawn_reporter(app: tauri::AppHandle, job: Arc<Job>) {
    std::thread::spawn(move || {
        let mut samples: std::collections::VecDeque<(Instant, u64)> = Default::default();
        loop {
            let bytes = job.bytes.load(Ordering::Relaxed);
            let now = Instant::now();
            samples.push_back((now, bytes));
            while samples.len() > 2 && now.duration_since(samples[0].0) > Duration::from_secs(3) {
                samples.pop_front();
            }
            let speed = match (samples.front(), samples.back()) {
                (Some(a), Some(b)) if b.0 > a.0 => ((b.1 - a.1) as f64 / b.0.duration_since(a.0).as_secs_f64()) as u64,
                _ => 0,
            };
            let st = snapshot(&job, speed);
            let finished = matches!(st.state, JobState::Done | JobState::Failed | JobState::Cancelled);
            let _ = app.emit("fileop://update", &st);
            if finished {
                break;
            }
            std::thread::sleep(Duration::from_millis(120));
        }
    });
}

pub fn start(app: tauri::AppHandle, kind: String, sources: Vec<String>, dest: Option<String>, policy: Conflict) -> Result<String, String> {
    if sources.is_empty() {
        return Err("Nothing selected".into());
    }
    if matches!(kind.as_str(), "copy" | "move") && dest.as_deref().unwrap_or("").is_empty() {
        return Err("No destination folder".into());
    }
    let id = new_id();
    let job = Arc::new(Job {
        status: Mutex::new(JobStatus {
            id: id.clone(),
            kind: kind.clone(),
            state: JobState::Scanning,
            sources: sources.clone(),
            dest: dest.clone(),
            current: String::new(),
            files_done: 0,
            files_total: 0,
            bytes_done: 0,
            bytes_total: 0,
            speed_bps: 0,
            eta_secs: None,
            errors: vec![],
            skipped: 0,
            started_ms: now_ms(),
            finished_ms: None,
            outputs: vec![],
        }),
        cancel: AtomicBool::new(false),
        pause: AtomicBool::new(false),
        bytes: AtomicU64::new(0),
        files: AtomicU64::new(0),
        current: Mutex::new(String::new()),
    });
    jobs().lock().unwrap().insert(id.clone(), job.clone());
    spawn_reporter(app, job.clone());

    std::thread::spawn(move || {
        let result = run_job(&job, &kind, &sources, dest.as_deref(), policy);
        if let Err(e) = result {
            job.error(e);
            set_state(&job, JobState::Failed);
        } else if job.cancelled() {
            set_state(&job, JobState::Cancelled);
        } else {
            set_state(&job, JobState::Done);
        }
        for s in &sources {
            crate::fs::invalidate_folder_cache(s);
            if let Some(p) = Path::new(s).parent() {
                crate::fs::invalidate_folder_cache(&p.to_string_lossy());
            }
        }
        if let Some(d) = dest {
            crate::fs::invalidate_folder_cache(&d);
        }
    });
    Ok(id)
}

fn set_totals(job: &Job, files: u64, bytes: u64) {
    if let Ok(mut s) = job.status.lock() {
        s.files_total = files;
        s.bytes_total = bytes;
        s.state = JobState::Running;
    }
}

fn run_job(job: &Job, kind: &str, sources: &[String], dest: Option<&str>, policy: Conflict) -> Result<(), String> {
    match kind {
        "copy" => {
            let plan = plan(job, sources, Path::new(dest.unwrap_or_default()), policy, false)?;
            set_totals(job, plan.files.len() as u64, plan.bytes);
            job.status.lock().unwrap().outputs = plan.items.iter().map(|i| i.dst.to_string_lossy().to_string()).collect();
            run_copy(job, &plan);
            Ok(())
        }
        "move" => run_move(job, sources, Path::new(dest.unwrap_or_default()), policy),
        "recycle" => {
            set_totals(job, sources.len() as u64, 0);
            run_delete(job, sources, false);
            Ok(())
        }
        "delete" => {
            let (files, bytes) = count_tree(job, sources);
            set_totals(job, files, bytes);
            run_delete(job, sources, true);
            Ok(())
        }
        other => Err(format!("unknown operation {other}")),
    }
}

fn run_move(job: &Job, sources: &[String], dest: &Path, policy: Conflict) -> Result<(), String> {
    let plan = plan(job, sources, dest, policy, true)?;
    job.status.lock().unwrap().outputs = plan.items.iter().map(|i| i.dst.to_string_lossy().to_string()).collect();
    let fast = plan.items.iter().all(|i| same_volume(&i.src, dest));
    if fast {
        // Same volume: renames. Merges into existing folders move file by file.
        set_totals(job, plan.files.len().max(plan.items.len()) as u64, plan.bytes);
        for item in &plan.items {
            if !job.wait_if_paused() {
                break;
            }
            job.set_current(&item.src);
            if !item.merge {
                match std::fs::rename(&item.src, &item.dst) {
                    Ok(()) => {
                        let n = plan.files.iter().filter(|f| f.src.starts_with(&item.src)).count().max(1) as u64;
                        let b: u64 = plan.files.iter().filter(|f| f.src.starts_with(&item.src)).map(|f| f.size).sum();
                        job.files.fetch_add(n, Ordering::Relaxed);
                        job.bytes.fetch_add(b, Ordering::Relaxed);
                    }
                    Err(e) => job.error(format!("{}: {}", item.src.display(), friendly_io(&e))),
                }
                continue;
            }
            for t in plan.files.iter().filter(|f| f.src.starts_with(&item.src)) {
                if !job.wait_if_paused() {
                    break;
                }
                if let Some(p) = t.dst.parent() {
                    let _ = std::fs::create_dir_all(p);
                }
                if t.dst.exists() {
                    crate::versions::before_change(&t.dst);
                    let _ = std::fs::remove_file(&t.dst);
                }
                match std::fs::rename(&t.src, &t.dst) {
                    Ok(()) => {
                        job.files.fetch_add(1, Ordering::Relaxed);
                        job.bytes.fetch_add(t.size, Ordering::Relaxed);
                    }
                    Err(e) => job.error(format!("{}: {}", t.src.display(), friendly_io(&e))),
                }
            }
            if item.is_dir {
                remove_empty_dirs(&item.src);
            }
        }
        return Ok(());
    }
    // Across volumes: copy, then remove each source item whose files all arrived.
    set_totals(job, plan.files.len() as u64, plan.bytes);
    let failed = run_copy(job, &plan);
    if job.cancelled() {
        return Ok(());
    }
    for item in &plan.items {
        if failed.iter().any(|f| f.starts_with(&item.src)) {
            continue;
        }
        let r = if item.is_dir { std::fs::remove_dir_all(&item.src) } else { std::fs::remove_file(&item.src) };
        if let Err(e) = r {
            job.error(format!("Copied, but couldn't remove the original {}: {}", item.src.display(), friendly_io(&e)));
        }
    }
    Ok(())
}

fn remove_empty_dirs(root: &Path) {
    let mut dirs: Vec<PathBuf> = WalkDir::new(root).into_iter().filter_map(|e| e.ok()).filter(|e| e.file_type().is_dir()).map(|e| e.path().to_path_buf()).collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for d in dirs {
        let _ = std::fs::remove_dir(d);
    }
}

/// Names of the top-level items that already exist at the destination.
pub fn conflicts(sources: &[String], dest: &str) -> Vec<String> {
    let d = Path::new(dest);
    sources
        .iter()
        .filter_map(|s| {
            let src = Path::new(s);
            let name = src.file_name()?;
            let in_place = src.parent().map(|p| is_inside(p, d) && is_inside(d, p)).unwrap_or(false);
            (!in_place && d.join(name).exists()).then(|| name.to_string_lossy().to_string())
        })
        .collect()
}

pub fn pause(id: &str, paused: bool) -> bool {
    match jobs().lock().unwrap().get(id) {
        Some(j) => {
            j.pause.store(paused, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

pub fn cancel(id: &str) -> bool {
    match jobs().lock().unwrap().get(id) {
        Some(j) => {
            j.cancel.store(true, Ordering::Relaxed);
            j.pause.store(false, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

pub fn list() -> Vec<JobStatus> {
    let mut v: Vec<JobStatus> = jobs().lock().unwrap().values().map(|j| snapshot(j, 0)).collect();
    v.sort_by_key(|s| s.started_ms);
    v
}

/// Forgets finished jobs (all of them when `id` is None).
pub fn dismiss(id: Option<String>) {
    let mut m = jobs().lock().unwrap();
    m.retain(|k, j| {
        let st = j.status.lock().map(|s| s.state).unwrap_or(JobState::Done);
        let finished = matches!(st, JobState::Done | JobState::Failed | JobState::Cancelled);
        !(finished && id.as_deref().map(|i| i == k).unwrap_or(true))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job() -> Job {
        Job {
            status: Mutex::new(JobStatus {
                id: "t".into(),
                kind: "copy".into(),
                state: JobState::Running,
                sources: vec![],
                dest: None,
                current: String::new(),
                files_done: 0,
                files_total: 0,
                bytes_done: 0,
                bytes_total: 0,
                speed_bps: 0,
                eta_secs: None,
                errors: vec![],
                skipped: 0,
                started_ms: 0,
                finished_ms: None,
                outputs: vec![],
            }),
            cancel: AtomicBool::new(false),
            pause: AtomicBool::new(false),
            bytes: AtomicU64::new(0),
            files: AtomicU64::new(0),
            current: Mutex::new(String::new()),
        }
    }

    #[test]
    fn copy_move_conflicts_and_delete() {
        let root = std::env::temp_dir().join(format!("pifiles-fileops-{}", now_ms()));
        let src = root.join("src");
        let dst = root.join("dst");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("a.txt"), b"hello").unwrap();
        std::fs::write(src.join("sub").join("big.bin"), vec![7u8; (LARGE_FILE + 123) as usize]).unwrap();
        std::fs::write(dst.join("a.txt"), b"old").unwrap();

        let j = job();
        let sources = vec![src.join("a.txt").to_string_lossy().to_string(), src.join("sub").to_string_lossy().to_string()];
        // Keep both: a.txt arrives as "a (2).txt"; the folder is copied with byte progress.
        run_job(&j, "copy", &sources, Some(&dst.to_string_lossy()), Conflict::Rename).unwrap();
        assert_eq!(std::fs::read(dst.join("a (2).txt")).unwrap(), b"hello");
        assert_eq!(std::fs::read(dst.join("a.txt")).unwrap(), b"old");
        assert_eq!(std::fs::metadata(dst.join("sub").join("big.bin")).unwrap().len(), LARGE_FILE + 123);
        assert_eq!(j.files.load(Ordering::Relaxed), 2);
        assert_eq!(j.bytes.load(Ordering::Relaxed), 5 + LARGE_FILE + 123);

        // Duplicating in place gets " - Copy".
        let j = job();
        run_job(&j, "copy", &[dst.join("a.txt").to_string_lossy().to_string()], Some(&dst.to_string_lossy()), Conflict::Rename).unwrap();
        assert!(dst.join("a - Copy.txt").exists());

        // Replace overwrites; move within a volume is a rename.
        let j = job();
        run_job(&j, "move", &[src.join("a.txt").to_string_lossy().to_string()], Some(&dst.to_string_lossy()), Conflict::Replace).unwrap();
        assert_eq!(std::fs::read(dst.join("a.txt")).unwrap(), b"hello");
        assert!(!src.join("a.txt").exists());

        // Copying a folder into itself is refused.
        let j = job();
        assert!(run_job(&j, "copy", &[src.to_string_lossy().to_string()], Some(&src.join("sub").to_string_lossy()), Conflict::Rename).is_err());

        let j = job();
        run_job(&j, "delete", &[root.to_string_lossy().to_string()], None, Conflict::Rename).unwrap();
        assert!(!root.exists());
        assert!(j.status.lock().unwrap().errors.is_empty());
    }
}

/// Runs a copy synchronously (benchmarks / tests).
#[cfg(test)]
pub fn bench_copy(sources: &[String], dest: &str) {
    let j = tests_support::job();
    run_job(&j, "copy", sources, Some(dest), Conflict::Replace).unwrap();
    assert!(j.status.lock().unwrap().errors.is_empty());
}

#[cfg(test)]
mod tests_support {
    use super::*;
    pub fn job() -> Job {
        Job {
            status: Mutex::new(JobStatus {
                id: "bench".into(), kind: "copy".into(), state: JobState::Running, sources: vec![], dest: None, current: String::new(),
                files_done: 0, files_total: 0, bytes_done: 0, bytes_total: 0, speed_bps: 0, eta_secs: None, errors: vec![], skipped: 0,
                started_ms: 0, finished_ms: None, outputs: vec![],
            }),
            cancel: AtomicBool::new(false),
            pause: AtomicBool::new(false),
            bytes: AtomicU64::new(0),
            files: AtomicU64::new(0),
            current: Mutex::new(String::new()),
        }
    }
}
