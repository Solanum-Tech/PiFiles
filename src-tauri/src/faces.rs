//! People: face scanning, persistent face index, clustering and active learning.
//!
//! Pipeline (all local, no network):
//!   1. Walk personal folders first, then drives, collecting photo candidates.
//!   2. Skip photos already in the face index with identical (mtime, size) - rescans are incremental.
//!   3. Analyse new photos on a below-normal-priority worker pool (`face_ai`: YuNet + SFace).
//!   4. Cluster all indexed faces with constrained average linkage (`face_cluster`), streaming
//!      intermediate results to the UI, and keep person keys stable across re-clusterings so
//!      names and user corrections stick.

use crate::face_ai::{self, cosine, FaceObservation, EMBEDDING_DIM};
use crate::media::MediaGroup;
use base64::Engine as _;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

// ---------- tuning ----------

/// Average-linkage stop threshold on SFace cosine similarity (before any user calibration).
/// Pairwise same-person scores sit mostly in 0.40-0.80 and different people below 0.25.
const CLUSTER_AVG_SIM: f32 = crate::face_model::DEFAULT_CLUSTER_THRESHOLD;
/// Second-phase merge on cluster centroids. Averaging removes per-photo noise, so different
/// people's centroids stay far below this while one person's sub-clusters (e.g. with/without
/// glasses) land at 0.50-0.60. Measured on a real library: 0.45 already started absorbing
/// look-alikes (continuum with no gap), 0.50 + the average-linkage floor only rejoins clear splits.
const CENTROID_MERGE_SIM: f32 = 0.50;
/// Phase-2 merges also need one strong face pair across the two groups. Measured: the same person
/// always has such a pair; two look-alikes shot in one studio session peaked at 0.53.
const BRIDGE_SIM: f32 = 0.60;
/// Cluster pairs with centroids this close (but not auto-merged) are offered as "same person?".
const SAME_PERSON_ASK_SIM: f32 = 0.42;
/// Two faces in the same photo this similar are the same person repeated (collage, mirror,
/// photo of a photo); below it they are treated as different people.
const SAME_PHOTO_SAME_PERSON_SIM: f32 = 0.55;
/// Faces beyond the clustering budget join an existing cluster only above this centroid similarity.
const ASSIGN_SIM: f32 = 0.42;
/// Max faces in the O(n²) clustering step (≈18 MB similarity triangle); best-quality faces first.
const CLUSTER_BUDGET: usize = 3000;
const MAX_CANDIDATES: usize = 20_000;
const PER_DRIVE_CAP: usize = 6_000;
const MAX_GROUPS: usize = 120;
const MIN_IMAGE_BYTES: u64 = 15_000;
const MAX_IMAGE_BYTES: u64 = 40_000_000;
/// A launch-time rescan (walk) is skipped if the last completed walk is newer than this.
const RESCAN_INTERVAL_SECS: u64 = 6 * 3600;

// ---------- global state ----------

static PEOPLE_CACHE: OnceLock<RwLock<Vec<MediaGroup>>> = OnceLock::new();
static SCANNING: AtomicBool = AtomicBool::new(false);
static SCAN_PROGRESS: AtomicUsize = AtomicUsize::new(0);
static SCAN_TOTAL: AtomicUsize = AtomicUsize::new(0);
static SCAN_NEW: AtomicUsize = AtomicUsize::new(0);
static SCAN_DRIVES: OnceLock<RwLock<String>> = OnceLock::new();
static SCAN_PHASE: OnceLock<RwLock<&'static str>> = OnceLock::new();
static FAST_SCAN_REQUESTED: AtomicBool = AtomicBool::new(false);
static INDEX: OnceLock<RwLock<FaceIndex>> = OnceLock::new();
/// Per-group centroid from the last clustering, used for suggestions and photo moves.
static CENTROIDS: OnceLock<RwLock<HashMap<String, Vec<f32>>>> = OnceLock::new();

fn get_cache() -> &'static RwLock<Vec<MediaGroup>> {
    PEOPLE_CACHE.get_or_init(|| RwLock::new(Vec::new()))
}

fn get_scan_drives_lock() -> &'static RwLock<String> {
    SCAN_DRIVES.get_or_init(|| RwLock::new(String::new()))
}

fn centroids() -> &'static RwLock<HashMap<String, Vec<f32>>> {
    CENTROIDS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn set_phase(p: &'static str) {
    *SCAN_PHASE.get_or_init(|| RwLock::new("idle")).write().unwrap() = p;
}

fn phase() -> &'static str {
    *SCAN_PHASE.get_or_init(|| RwLock::new("idle")).read().unwrap()
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn set_fast_scan_mode(fast: bool) {
    FAST_SCAN_REQUESTED.store(fast, Ordering::Relaxed);
}

pub fn is_fast_scan_mode() -> bool {
    FAST_SCAN_REQUESTED.load(Ordering::Relaxed)
}

pub fn get_cached_people() -> Vec<MediaGroup> {
    get_cache().read().unwrap().clone()
}

pub fn get_cached_people_groups() -> Option<Vec<MediaGroup>> {
    let r = get_cache().read().unwrap();
    if r.is_empty() { None } else { Some(r.clone()) }
}

pub fn set_cached_people(groups: Vec<MediaGroup>) {
    *get_cache().write().unwrap() = groups.clone();
    save_face_cache(&groups);
}

pub fn is_scanning() -> bool {
    SCANNING.load(Ordering::Relaxed)
}

pub fn get_scan_status() -> serde_json::Value {
    let progress = SCAN_PROGRESS.load(Ordering::Relaxed);
    let total = SCAN_TOTAL.load(Ordering::Relaxed);
    let cached = get_cache().read().map(|r| r.len()).unwrap_or(0);
    let drives = get_scan_drives_lock().read().map(|s| s.clone()).unwrap_or_default();
    let faces = get_index().read().map(|i| i.face_count()).unwrap_or(0);
    serde_json::json!({
        "scanning": is_scanning(),
        "phase": phase(),
        "progress": progress,
        "total": total,
        "new_images": SCAN_NEW.load(Ordering::Relaxed),
        "faces": faces,
        "cached": cached,
        "cached_count": cached,
        "drives": drives,
        "fast_mode": is_fast_scan_mode(),
        "total_images": total,
        "scanned_drives": drives
    })
}

pub fn placeholder_thumb() -> String {
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="#e5e5e5"/><circle cx="48" cy="38" r="18" fill="#bdbdbd"/><path d="M16 86c6-14 18-22 32-22s26 8 32 22" fill="#bdbdbd"/></svg>"##;
    format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(svg.as_bytes())
    )
}

// ---------- persistent storage ----------

#[cfg_attr(test, allow(dead_code))]
fn app_dir() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let dir = PathBuf::from(appdata).join("com.pifiles.app");
        let _ = std::fs::create_dir_all(&dir);
        return dir;
    }
    std::env::temp_dir()
}

fn face_cache_path() -> PathBuf {
    #[cfg(test)]
    {
        std::env::temp_dir().join("pifiles_face_groups_test.json")
    }
    #[cfg(not(test))]
    {
        app_dir().join("faces_cache_v2.json")
    }
}

fn face_index_path() -> PathBuf {
    #[cfg(test)]
    {
        std::env::temp_dir().join("pifiles_face_index_v3_test.json")
    }
    #[cfg(not(test))]
    {
        app_dir().join("faces_index_v3.json")
    }
}

/// Face data is biometric: always stored encrypted (see vault.rs).
fn write_atomic(path: &Path, data: &[u8]) {
    let _ = crate::vault::write(path, data);
}

fn load_face_cache() -> Option<Vec<MediaGroup>> {
    let data = crate::vault::read(&face_cache_path())?;
    let v: Vec<MediaGroup> = serde_json::from_slice(&data).ok()?;
    if v.is_empty() { None } else { Some(v) }
}

pub fn save_face_cache(groups: &[MediaGroup]) {
    if let Ok(json) = serde_json::to_vec(groups) {
        write_atomic(&face_cache_path(), &json);
    }
}

pub fn merge_cached_groups(keys_to_remove: &[String], merged: MediaGroup) -> bool {
    let mut w = get_cache().write().unwrap();
    let before = w.len();
    w.retain(|g| !keys_to_remove.contains(&g.key));
    let removed = before != w.len();
    w.push(merged);
    w.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.key.cmp(&b.key)));
    let snapshot = w.clone();
    drop(w);
    save_face_cache(&snapshot);
    removed
}

/// Embeddings are stored as base64 int8 (128 B/face instead of ~1.3 KB of JSON floats);
/// the quantization error is ~1e-3 in cosine, far below any decision threshold.
mod emb_b64 {
    use base64::Engine as _;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[f32], s: S) -> Result<S::Ok, S::Error> {
        let q: Vec<u8> = v.iter().map(|x| ((x * 127.0).round().clamp(-127.0, 127.0) as i8) as u8).collect();
        s.serialize_str(&base64::engine::general_purpose::STANDARD.encode(q))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<f32>, D::Error> {
        let s = String::deserialize(d)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(s)
            .map_err(serde::de::Error::custom)?;
        let mut v: Vec<f32> = bytes.into_iter().map(|b| (b as i8) as f32 / 127.0).collect();
        crate::face_ai::l2_normalize(&mut v);
        Ok(v)
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct StoredFace {
    bbox: [f32; 4],
    score: f32,
    quality: f32,
    #[serde(with = "emb_b64")]
    emb: Vec<f32>,
    hash: u64,
    thumb: String,
}

impl From<FaceObservation> for StoredFace {
    fn from(o: FaceObservation) -> Self {
        StoredFace { bbox: o.bbox, score: o.score, quality: o.quality, emb: o.embedding, hash: o.hash, thumb: o.thumb }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct FileRecord {
    mtime: u64,
    size: u64,
    /// Empty = analysed, no usable face. Photos without faces are remembered so they're never re-decoded.
    faces: Vec<StoredFace>,
    #[serde(default)]
    failed: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct FaceIndex {
    model_tag: String,
    #[serde(default)]
    last_walk: u64,
    files: HashMap<String, FileRecord>,
}

impl FaceIndex {
    fn face_count(&self) -> usize {
        self.files.values().map(|f| f.faces.len()).sum()
    }
}

fn get_index() -> &'static RwLock<FaceIndex> {
    INDEX.get_or_init(|| {
        let idx = crate::vault::read(&face_index_path())
            .and_then(|b| serde_json::from_slice::<FaceIndex>(&b).ok())
            .filter(|i| i.model_tag == face_ai::MODEL_TAG)
            .unwrap_or_else(|| FaceIndex { model_tag: face_ai::MODEL_TAG.to_string(), ..Default::default() });
        RwLock::new(idx)
    })
}

fn save_index() {
    let json = {
        let idx = get_index().read().unwrap();
        serde_json::to_vec(&*idx)
    };
    if let Ok(json) = json {
        write_atomic(&face_index_path(), &json);
    }
}

fn file_stamp(path: &Path) -> Option<(u64, u64)> {
    let md = std::fs::metadata(path).ok()?;
    let mtime = md.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some((mtime, md.len()))
}

/// All usable face embeddings for a photo, analysing (and indexing) it if it isn't indexed yet.
fn faces_for_photo(path: &str) -> Vec<StoredFace> {
    if let Some(rec) = get_index().read().unwrap().files.get(path) {
        return rec.faces.clone();
    }
    let Some((mtime, size)) = file_stamp(Path::new(path)) else { return Vec::new() };
    let faces: Vec<StoredFace> = face_ai::analyze_image(Path::new(path))
        .map(|v| v.into_iter().map(StoredFace::from).collect())
        .unwrap_or_default();
    get_index()
        .write()
        .unwrap()
        .files
        .insert(path.to_string(), FileRecord { mtime, size, faces: faces.clone(), failed: false });
    faces
}

/// Picks the face in `path` that belongs with the other photos of a group (group photos contain
/// several faces). Returns (embedding, hash, thumb).
pub fn face_embedding_for_photo_in_group(path: &str, group_paths: &[String]) -> Option<(Vec<f32>, u64, String)> {
    let faces = faces_for_photo(path);
    if faces.len() <= 1 {
        return faces.into_iter().next().map(|f| (f.emb, f.hash, f.thumb));
    }
    // Reference: the group centroid if known, else faces of up to 30 sibling photos.
    let mut refs: Vec<Vec<f32>> = Vec::new();
    {
        let idx = get_index().read().unwrap();
        for p in group_paths.iter().filter(|p| p.as_str() != path).take(30) {
            if let Some(rec) = idx.files.get(p) {
                refs.extend(rec.faces.iter().map(|f| f.emb.clone()));
            }
        }
    }
    let best = faces
        .into_iter()
        .map(|f| {
            let s = if refs.is_empty() {
                f.quality
            } else {
                refs.iter().map(|r| cosine(&f.emb, r)).sum::<f32>() / refs.len() as f32
            };
            (s, f)
        })
        .max_by(|a, b| a.0.total_cmp(&b.0))?;
    Some((best.1.emb, best.1.hash, best.1.thumb))
}

/// Legacy entry point: best face of a single photo.
#[allow(dead_code)]
pub fn extract_face_embedding_from_file(path: &str) -> Option<(Vec<f32>, u64, String)> {
    face_embedding_for_photo_in_group(path, &[])
}

// ---------- candidate discovery ----------

pub fn full_machine_roots() -> Vec<String> {
    let mut drives: Vec<String> = Vec::new();
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
        for letter in b'C'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            let wide: Vec<u16> = drive.encode_utf16().chain(Some(0)).collect();
            let dtype = unsafe { GetDriveTypeW(wide.as_ptr()) };
            // 1 = no root dir, 4 = network (slow, may hang), 5 = CD-ROM
            if dtype == 1 || dtype == 4 || dtype == 5 || !Path::new(&drive).exists() {
                continue;
            }
            drives.push(drive);
            if drives.len() >= 8 {
                break;
            }
        }
    }
    #[cfg(not(windows))]
    drives.push("/".to_string());
    drives
}

pub(crate) fn should_skip_dir(name: &str) -> bool {
    let lower = name.to_lowercase();
    (lower.starts_with('.') && lower.len() > 1)
        || lower.starts_with('$')
        || matches!(
            lower.as_str(),
            "windows" | "winnt" | "program files" | "program files (x86)" | "programdata" | "appdata"
                | "system volume information" | "recovery" | "perflogs" | "msocache" | "node_modules"
                | "target" | "cache" | "caches" | "__pycache__" | "venv" | "site-packages"
                | "steamapps" | "thumbnails" | "icons" | "windowsapps"
        )
}

fn is_media_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png" | "bmp" | "webp"))
        .unwrap_or(false)
}

struct Candidate {
    path: String,
    mtime: u64,
    size: u64,
}

fn walk_root(root: &str, depth: usize, cap: usize, seen: &mut HashSet<String>, out: &mut Vec<Candidate>) {
    let mut added = 0;
    for e in WalkDir::new(root)
        .max_depth(depth)
        .into_iter()
        .filter_entry(|e| !(e.file_type().is_dir() && e.depth() > 0 && should_skip_dir(&e.file_name().to_string_lossy())))
        .filter_map(|e| e.ok())
    {
        if added >= cap || out.len() >= MAX_CANDIDATES {
            break;
        }
        if !e.file_type().is_file() || !is_media_image(e.path()) {
            continue;
        }
        let Ok(md) = e.metadata() else { continue };
        let size = md.len();
        if !(MIN_IMAGE_BYTES..=MAX_IMAGE_BYTES).contains(&size) {
            continue;
        }
        let path = e.path().to_string_lossy().to_string();
        if !seen.insert(path.to_lowercase()) {
            continue;
        }
        let mtime = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
        out.push(Candidate { path, mtime, size });
        added += 1;
    }
}

fn collect_candidates(drives: &[String]) -> Vec<Candidate> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    if let Ok(home) = std::env::var("USERPROFILE") {
        for sub in ["Pictures", "OneDrive\\Pictures", "OneDrive", "Desktop", "Downloads", "Documents", "Videos"] {
            let p = format!("{home}\\{sub}");
            if Path::new(&p).exists() {
                walk_root(&p, 12, MAX_CANDIDATES, &mut seen, &mut out);
            }
        }
    }
    for d in drives {
        walk_root(d, 6, PER_DRIVE_CAP, &mut seen, &mut out);
    }
    out
}

// ---------- clustering → people groups ----------

struct FaceRef<'a> {
    path: &'a str,
    size: u64,
    face: &'a StoredFace,
}

fn is_default_label(l: &str) -> bool {
    l.strip_prefix("Person ").map(|n| n.trim().parse::<u32>().is_ok()).unwrap_or(false)
}

fn stable_key(paths: &[&str]) -> String {
    use std::hash::{Hash, Hasher};
    let mut sorted: Vec<&str> = paths.to_vec();
    sorted.sort_unstable();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    sorted.iter().take(8).for_each(|p| p.hash(&mut h));
    format!("person_{:016x}", h.finish())
}

fn centroid_of(embs: &[&[f32]]) -> Vec<f32> {
    let mut c = vec![0f32; embs.first().map(|e| e.len()).unwrap_or(EMBEDDING_DIM)];
    for e in embs {
        c.iter_mut().zip(e.iter()).for_each(|(a, b)| *a += b);
    }
    face_ai::l2_normalize(&mut c);
    c
}

/// Clusters every indexed face and builds People groups, reusing keys from `prev` groups and
/// learned prototypes so labels, merges and moves survive re-clustering.
fn build_groups(prev: &[MediaGroup]) -> (Vec<MediaGroup>, HashMap<String, Vec<f32>>) {
    let labels = crate::people::load_labels();
    // Lock order is always model → index (people/merge paths hold the model while reading faces).
    let model = crate::face_model::get_model_lock().read().unwrap();
    let index = get_index().read().unwrap();

    let mut faces: Vec<FaceRef> = index
        .files
        .iter()
        .flat_map(|(p, rec)| rec.faces.iter().map(move |f| FaceRef { path: p.as_str(), size: rec.size, face: f }))
        .filter(|f| f.face.emb.len() == EMBEDDING_DIM && !model.is_known_negative(f.face.hash, &f.face.emb))
        .collect();
    if faces.is_empty() {
        return (Vec::new(), HashMap::new());
    }
    faces.sort_by(|a, b| b.face.quality.total_cmp(&a.face.quality).then_with(|| a.path.cmp(b.path)));
    let overflow = if faces.len() > CLUSTER_BUDGET { faces.split_off(CLUSTER_BUDGET) } else { Vec::new() };

    // Faces the user confirmed (prototype exemplars) are must-linked to that person.
    let mut confirmed: Vec<Option<&str>> = vec![None; faces.len()];
    let mut by_path: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, f) in faces.iter().enumerate() {
        by_path.entry(f.path).or_default().push(i);
    }
    for proto in model.classes.values() {
        let exemplar_paths = proto.exemplars.iter().map(|e| e.photo_path.as_str());
        let paths: HashSet<&str> = proto.confirmed_paths.iter().map(|s| s.as_str()).chain(exemplar_paths).collect();
        for p in paths {
            let Some(cands) = by_path.get(p) else { continue };
            // The confirmed face is the one closest to this person (group photos have several), and
            // it must actually resemble them: a bad merge can never force strangers together.
            let hit = if proto.centroid.len() == EMBEDDING_DIM {
                cands
                    .iter()
                    .copied()
                    .map(|i| (i, cosine(&proto.centroid, &faces[i].face.emb)))
                    .filter(|(_, s)| *s >= crate::face_model::CONSISTENT_SIM)
                    .max_by(|a, b| a.1.total_cmp(&b.1))
                    .map(|x| x.0)
            } else if cands.len() == 1 {
                Some(cands[0])
            } else {
                None
            };
            if let Some(i) = hit {
                confirmed[i].get_or_insert(proto.key.as_str());
            }
        }
    }

    let mut initial: Vec<Vec<usize>> = Vec::new();
    let mut proto_slot: HashMap<&str, usize> = HashMap::new();
    for i in 0..faces.len() {
        match confirmed[i] {
            Some(k) => {
                let slot = *proto_slot.entry(k).or_insert_with(|| {
                    initial.push(Vec::new());
                    initial.len() - 1
                });
                initial[slot].push(i);
            }
            None => initial.push(vec![i]),
        }
    }
    let init_key: Vec<Option<&str>> = initial.iter().map(|c| confirmed[c[0]]).collect();
    let init_paths: Vec<HashSet<&str>> = initial.iter().map(|c| c.iter().map(|&i| faces[i].path).collect()).collect();
    let rejected: HashMap<&str, &HashSet<String>> =
        model.classes.values().map(|p| (p.key.as_str(), &p.rejected_paths)).collect();

    let initial_ref = &initial;
    let faces_ref = &faces;
    let cannot_link = |a: usize, b: usize| -> bool {
        let faces = faces_ref;
        // Two faces in one photo are normally two different people. Exception: collages, mirror
        // shots and photos-of-photos repeat the same face - if the two faces clearly match, a single
        // such photo must not forbid merging everything else.
        let (small, large) = if init_paths[a].len() <= init_paths[b].len() { (a, b) } else { (b, a) };
        for p in init_paths[small].iter().filter(|p| init_paths[large].contains(*p)) {
            for &fa in initial_ref[a].iter().filter(|&&i| faces[i].path == *p) {
                for &fb in initial_ref[b].iter().filter(|&&i| faces[i].path == *p) {
                    if cosine(&faces[fa].face.emb, &faces[fb].face.emb) < SAME_PHOTO_SAME_PERSON_SIM {
                        return true;
                    }
                }
            }
        }
        match (init_key[a], init_key[b]) {
            (Some(x), Some(y)) if x != y => return true,
            _ => {}
        }
        // Photos the user moved out of a person never rejoin them.
        for (k, other) in [(init_key[a], b), (init_key[b], a)] {
            if let Some(rej) = k.and_then(|k| rejected.get(k)) {
                if init_paths[other].iter().any(|p| rej.contains(*p)) {
                    return true;
                }
            }
        }
        false
    };
    // Cluster in the user-adapted metric space (identity until the user has given feedback).
    let adapted: Vec<Vec<f32>> = faces.par_iter().map(|f| model.adapt(&f.face.emb)).collect();
    let embs: Vec<&[f32]> = adapted.iter().map(|e| e.as_slice()).collect();
    let threshold = model.cluster_threshold();
    let mut clusters = crate::face_cluster::cluster(&embs, initial.clone(), &cannot_link, threshold, CENTROID_MERGE_SIM + (threshold - CLUSTER_AVG_SIM), BRIDGE_SIM);

    // Overflow faces: attach to the nearest centroid or become singletons.
    let all: Vec<FaceRef> = faces.into_iter().chain(overflow).collect();
    let n_overflow = all.len() - clusters.iter().map(|c| c.len()).sum::<usize>();
    if n_overflow > 0 {
        let cents: Vec<Vec<f32>> = clusters.iter().map(|c| centroid_of(&c.iter().map(|&i| all[i].face.emb.as_slice()).collect::<Vec<_>>())).collect();
        let first_overflow = all.len() - n_overflow;
        for i in first_overflow..all.len() {
            let best = cents.iter().enumerate().map(|(ci, c)| (ci, cosine(c, &all[i].face.emb))).max_by(|a, b| a.1.total_cmp(&b.1));
            match best {
                Some((ci, s)) if s >= ASSIGN_SIM && !clusters[ci].iter().any(|&j| all[j].path == all[i].path) => clusters[ci].push(i),
                _ => clusters.push(vec![i]),
            }
        }
    }

    // Eject members that don't resemble their own group (e.g. a child who slipped in through an
    // early small merge); they stand alone rather than showing up under someone else's name.
    let mut ejected: Vec<Vec<usize>> = Vec::new();
    for cl in clusters.iter_mut().filter(|c| c.len() >= 3) {
        let cent = centroid_of(&cl.iter().map(|&i| all[i].face.emb.as_slice()).collect::<Vec<_>>());
        cl.retain(|&i| {
            let keep = cosine(&all[i].face.emb, &cent) >= crate::face_model::CONSISTENT_SIM;
            if !keep {
                ejected.push(vec![i]);
            }
            keep
        });
    }
    clusters.extend(ejected);

    // ---- turn clusters into groups with stable keys ----
    struct Draft {
        key: String,
        explicit: bool,
        faces: Vec<usize>,
        centroid: Vec<f32>,
    }
    let mut used_keys: HashSet<String> = HashSet::new();
    let prev_paths: Vec<HashSet<&str>> = prev.iter().map(|g| g.paths.iter().flatten().map(|s| s.as_str()).collect()).collect();
    let mut prev_used = vec![false; prev.len()];
    let mut drafts: Vec<Draft> = Vec::new();

    for mut cl in clusters {
        cl.sort_by(|&a, &b| all[b].face.quality.total_cmp(&all[a].face.quality));
        let centroid = centroid_of(&cl.iter().map(|&i| all[i].face.emb.as_slice()).collect::<Vec<_>>());
        let paths: Vec<&str> = cl.iter().map(|&i| all[i].path).collect();

        // 1. user-confirmed identity (majority of confirmed members)
        let mut votes: HashMap<&str, usize> = HashMap::new();
        for &i in &cl {
            if let Some(k) = confirmed.get(i).copied().flatten() {
                *votes.entry(k).or_default() += 1;
            }
        }
        let mut key: Option<String> = votes.into_iter().max_by_key(|x| x.1).map(|x| x.0.to_string()).filter(|k| !used_keys.contains(k));
        let mut explicit = key.is_some();
        // 2. learned prototype recognises the cluster
        if key.is_none() {
            key = model.classify(0, &centroid, "").map(|(k, _, _)| k).filter(|k| !used_keys.contains(k));
            explicit = key.is_some();
        }
        // 3. same people as last time (photo overlap), so names survive rescans
        if key.is_none() {
            let set: HashSet<&str> = paths.iter().copied().collect();
            let best = prev_paths
                .iter()
                .enumerate()
                .filter(|(pi, _)| !prev_used[*pi] && !used_keys.contains(&prev[*pi].key))
                .map(|(pi, pp)| (pi, pp.iter().filter(|p| set.contains(*p)).count(), pp.len()))
                .filter(|(_, ov, plen)| *ov > 0 && *ov * 10 >= 3 * set.len().min(*plen))
                .max_by_key(|x| x.1);
            if let Some((pi, _, _)) = best {
                prev_used[pi] = true;
                key = Some(prev[pi].key.clone());
                explicit = labels.contains_key(&prev[pi].key);
            }
        }
        let key = key.unwrap_or_else(|| {
            let mut k = stable_key(&paths);
            while used_keys.contains(&k) {
                k.push('_');
            }
            k
        });
        used_keys.insert(key.clone());
        drafts.push(Draft { explicit: explicit || labels.contains_key(&key), key, faces: cl, centroid });
    }

    // Multi-photo and named people first, then singletons, capped.
    drafts.sort_by(|a, b| (b.faces.len() >= 2 || b.explicit).cmp(&(a.faces.len() >= 2 || a.explicit)).then(b.faces.len().cmp(&a.faces.len())));
    drafts.truncate(MAX_GROUPS);

    let mut groups = Vec::new();
    let mut cents = HashMap::new();
    let mut default_n = 0;
    for d in drafts {
        let mut seen_paths = HashSet::new();
        let mut paths = Vec::new();
        let mut total_size = 0u64;
        let mut preview = Vec::new();
        for &i in &d.faces {
            let f = &all[i];
            if seen_paths.insert(f.path) {
                paths.push(f.path.to_string());
                total_size += f.size;
                if preview.len() < 4 && f.face.thumb.starts_with("data:image/") {
                    preview.push(f.face.thumb.clone());
                }
            }
        }
        if preview.is_empty() {
            preview.push(placeholder_thumb());
        }
        let label = labels
            .get(&d.key)
            .cloned()
            .or_else(|| model.classes.get(&d.key).map(|p| p.label.clone()).filter(|l| !is_default_label(l) && l != &d.key))
            .unwrap_or_else(|| {
                default_n += 1;
                format!("Person {default_n}")
            });
        cents.insert(d.key.clone(), d.centroid);
        groups.push(MediaGroup {
            key: d.key,
            label,
            count: paths.len(),
            total_size,
            preview,
            face_count: Some(d.faces.len()),
            paths: Some(paths),
        });
    }
    (groups, cents)
}

/// Re-clusters the whole index and publishes the result to the UI cache.
fn recluster_and_publish(persist: bool) -> usize {
    let prev = get_cached_people();
    let (groups, cents) = build_groups(&prev);
    let n = groups.len();
    *centroids().write().unwrap() = cents;
    *get_cache().write().unwrap() = groups.clone();
    if persist {
        save_face_cache(&groups);
    }
    n
}

/// Background re-cluster after user feedback (confirm / not-a-face) so the People view updates.
pub fn spawn_recluster() {
    std::thread::spawn(|| {
        lower_thread_priority();
        crate::face_model::get_model_lock().write().unwrap().retrain_adapter();
        if !is_scanning() {
            recluster_and_publish(true);
        }
    });
}

// ---------- scanning ----------

#[cfg(windows)]
pub(crate) fn lower_thread_priority() {
    use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL};
    unsafe {
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
}
#[cfg(not(windows))]
pub(crate) fn lower_thread_priority() {}

fn analyze_candidate(c: &Candidate) -> FileRecord {
    match face_ai::analyze_image(Path::new(&c.path)) {
        Ok(faces) => FileRecord { mtime: c.mtime, size: c.size, faces: faces.into_iter().map(StoredFace::from).collect(), failed: false },
        Err(_) => FileRecord { mtime: c.mtime, size: c.size, faces: Vec::new(), failed: true },
    }
}

fn run_scan(walk: bool) {
    lower_thread_priority();
    if let Err(e) = face_ai::warm_up() {
        eprintln!("[faces] model load failed: {e}");
        return;
    }

    // Show what's already indexed straight away (also covers the first launch after a model upgrade
    // that migrated user-confirmed prototypes).
    {
        let mut model = crate::face_model::get_model_lock().write().unwrap();
        let idx = get_index().read().unwrap();
        model.rehydrate(|p| idx.files.get(p).map(|r| r.faces.iter().map(|f| f.emb.clone()).collect()).unwrap_or_default());
    }
    set_phase("clustering");
    if get_index().read().unwrap().face_count() > 0 {
        // Persist when no disk walk follows, so grouping improvements reach the saved people list.
        recluster_and_publish(!walk);
    }
    if !walk {
        set_phase("idle");
        return;
    }

    set_phase("walking");
    let drives = full_machine_roots();
    *get_scan_drives_lock().write().unwrap() =
        drives.iter().map(|d| d.chars().next().unwrap_or('?').to_string()).collect::<Vec<_>>().join(",");
    let candidates = collect_candidates(&drives);

    let (mut todo, done): (Vec<Candidate>, Vec<Candidate>) = {
        let idx = get_index().read().unwrap();
        candidates.into_iter().partition(|c| match idx.files.get(&c.path) {
            Some(r) => r.mtime != c.mtime || r.size != c.size,
            None => true,
        })
    };
    // Forget photos that were deleted.
    {
        let keep: HashSet<&str> = todo.iter().chain(done.iter()).map(|c| c.path.as_str()).collect();
        get_index().write().unwrap().files.retain(|p, _| keep.contains(p.as_str()) || Path::new(p).exists());
    }
    todo.sort_by(|a, b| b.mtime.cmp(&a.mtime)); // newest photos first
    SCAN_TOTAL.store(todo.len() + done.len(), Ordering::Relaxed);
    SCAN_PROGRESS.store(done.len(), Ordering::Relaxed);
    SCAN_NEW.store(todo.len(), Ordering::Relaxed);
    eprintln!("[faces] {} photos: {} indexed, {} to analyse", todo.len() + done.len(), done.len(), todo.len());

    set_phase("analyzing");
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).saturating_sub(1).clamp(1, 8);
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|i| format!("face-scan-{i}"))
        .start_handler(|_| lower_thread_priority())
        .build()
        .expect("face scan pool");

    let started = Instant::now();
    let mut last_publish = Instant::now();
    let mut last_save = Instant::now();
    let mut new_faces = 0usize;
    let mut i = 0;
    while i < todo.len() {
        // Eco: one core with a pause between photos. Fast: every core but one.
        let fast = is_fast_scan_mode();
        let end = (i + if fast { threads * 2 } else { 1 }).min(todo.len());
        let results: Vec<FileRecord> = pool.install(|| todo[i..end].par_iter().map(analyze_candidate).collect());
        {
            let mut idx = get_index().write().unwrap();
            for (c, rec) in todo[i..end].iter().zip(results) {
                new_faces += rec.faces.len();
                idx.files.insert(c.path.clone(), rec);
            }
        }
        SCAN_PROGRESS.fetch_add(end - i, Ordering::Relaxed);
        i = end;
        if !fast {
            std::thread::sleep(Duration::from_millis(60));
        }
        // Stream results; re-cluster less often as the library grows.
        let total_faces = get_index().read().unwrap().face_count();
        let interval = Duration::from_millis(1500 + total_faces as u64);
        if new_faces > 0 && last_publish.elapsed() >= interval {
            set_phase("clustering");
            recluster_and_publish(false);
            set_phase("analyzing");
            new_faces = 0;
            last_publish = Instant::now();
        }
        if last_save.elapsed() >= Duration::from_secs(20) {
            save_index();
            last_save = Instant::now();
        }
    }
    eprintln!("[faces] analysed {} photos in {:?} ({} threads)", todo.len(), started.elapsed(), threads);

    get_index().write().unwrap().last_walk = now_secs();
    save_index();
    {
        let mut model = crate::face_model::get_model_lock().write().unwrap();
        let idx = get_index().read().unwrap();
        model.rehydrate(|p| idx.files.get(p).map(|r| r.faces.iter().map(|f| f.emb.clone()).collect()).unwrap_or_default());
        drop(idx);
        model.retrain_adapter();
    }
    set_phase("clustering");
    let n = recluster_and_publish(true);
    let _ = crate::face_model::get_suggestions_lock().write().map(|mut s| s.clear());
    eprintln!("[faces] {} people from {} faces", n, get_index().read().unwrap().face_count());
    set_phase("idle");
}

/// Starts the background scan. `force` (Redetect) always walks the disks and runs at full speed;
/// otherwise cached people are shown instantly and the disks are re-walked only if the last walk
/// is stale. Either way only new or modified photos are analysed.
pub fn spawn_full_machine_scan(force: bool) {
    if get_cache().read().unwrap().is_empty() {
        if let Some(cached) = load_face_cache() {
            *get_cache().write().unwrap() = cached;
        }
    }
    if SCANNING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return;
    }
    if force {
        set_fast_scan_mode(true);
    }
    SCAN_NEW.store(0, Ordering::Relaxed);
    std::thread::Builder::new()
        .name("face-scan".into())
        .spawn(move || {
            let walk = force || now_secs().saturating_sub(get_index().read().unwrap().last_walk) > RESCAN_INTERVAL_SECS;
            let result = std::panic::catch_unwind(|| run_scan(walk));
            if result.is_err() {
                eprintln!("[faces] scan panicked");
                set_phase("idle");
            }
            SCANNING.store(false, Ordering::Relaxed);
            if force {
                set_fast_scan_mode(false);
            }
            crate::face_ai::release_models();
            crate::perf::trim_memory();
        })
        .ok();
}

// ---------- active learning ----------

/// Builds review questions from real model uncertainty:
/// - large unnamed people → "who is this?"
/// - members far from their person's centroid → "is this really X?"
/// - low-confidence detections → "is this a face?"
pub fn generate_initial_suggestions() -> Vec<crate::face_model::FaceSuggestion> {
    use crate::face_model::FaceSuggestion;
    let groups = get_cached_people();
    let cents = centroids().read().unwrap().clone();
    let existing_persons: Vec<(String, String)> = groups.iter().map(|g| (g.key.clone(), g.label.clone())).collect();
    let index = get_index().read().unwrap();

    let mut identify = Vec::new();
    let mut borderline: Vec<(f32, FaceSuggestion)> = Vec::new();
    let mut verify: Vec<(f32, FaceSuggestion)> = Vec::new();

    for g in &groups {
        let Some(c) = cents.get(&g.key) else { continue };
        let paths = g.paths.clone().unwrap_or_default();
        let mut members: Vec<(f32, &str, &StoredFace)> = Vec::new();
        for p in &paths {
            if let Some(best) = index.files.get(p).and_then(|r| r.faces.iter().max_by(|a, b| cosine(&a.emb, c).total_cmp(&cosine(&b.emb, c)))) {
                members.push((cosine(&best.emb, c), p.as_str(), best));
            }
        }
        let mk = |sim: f32, p: &str, f: &StoredFace, qt: &str, reason: String| FaceSuggestion {
            id: format!("sug_{}_{:016x}", g.key, f.hash ^ (p.len() as u64)),
            photo_path: p.to_string(),
            face_thumb: f.thumb.clone(),
            rect: (f.bbox[0].max(0.0) as u32, f.bbox[1].max(0.0) as u32, f.bbox[2] as u32, f.bbox[3] as u32),
            hash: f.hash,
            embedding: f.emb.clone(),
            suggested_person_key: Some(g.key.clone()),
            suggested_label: Some(g.label.clone()),
            confidence: sim.clamp(0.0, 1.0),
            question_type: qt.to_string(),
            reason,
            existing_persons: existing_persons.clone(),
        };
        if is_default_label(&g.label) && g.count >= 3 {
            if let Some(&(sim, p, f)) = members.iter().max_by(|a, b| (a.0 * a.2.quality).total_cmp(&(b.0 * b.2.quality))) {
                identify.push(mk(sim, p, f, "identify_person", format!("{} photos of this person - add a name so they're recognised everywhere", g.count)));
            }
        }
        if g.count >= 3 {
            for &(sim, p, f) in &members {
                if sim < CLUSTER_AVG_SIM + 0.05 {
                    borderline.push((sim, mk(sim, p, f, "confirm_person", format!("Low match to {} ({:.0}% similar to their other photos)", g.label, sim * 100.0))));
                }
            }
        }
        for &(sim, p, f) in &members {
            if f.score < 0.88 || f.quality < 0.35 {
                verify.push((f.quality, mk(sim, p, f, "verify_face", format!("Uncertain detection ({:.0}% detector confidence)", f.score * 100.0))));
            }
        }
    }
    borderline.sort_by(|a, b| a.0.total_cmp(&b.0));
    verify.sort_by(|a, b| a.0.total_cmp(&b.0));

    // Possibly the same person split in two: centroids close, but not close enough to merge
    // automatically. Confirming merges them (and trains must-links + the metric adapter).
    let dismissed = dismissed_merges().read().unwrap().clone();
    let mut pairs: Vec<(f32, &MediaGroup, &MediaGroup)> = Vec::new();
    for (a, ga) in groups.iter().enumerate() {
        for gb in groups.iter().skip(a + 1) {
            if let (Some(ca), Some(cb)) = (cents.get(&ga.key), cents.get(&gb.key)) {
                let s = cosine(ca, cb);
                if s >= SAME_PERSON_ASK_SIM {
                    pairs.push((s, ga, gb));
                }
            }
        }
    }
    pairs.sort_by(|x, y| y.0.total_cmp(&x.0));
    let mut same_person = Vec::new();
    for (sim, ga, gb) in pairs {
        let (big, small) = if ga.count >= gb.count { (ga, gb) } else { (gb, ga) };
        let id = format!("merge|{}|{}", small.key, big.key);
        if dismissed.contains(&id) || same_person.len() >= 4 {
            continue;
        }
        let c = &cents[&small.key];
        let best = small
            .paths
            .iter()
            .flatten()
            .filter_map(|p| index.files.get(p).map(|r| (p, r)))
            .flat_map(|(p, r)| r.faces.iter().map(move |f| (p, f)))
            .max_by(|a, b| cosine(&a.1.emb, c).total_cmp(&cosine(&b.1.emb, c)));
        if let Some((p, f)) = best {
            same_person.push(FaceSuggestion {
                id,
                photo_path: p.clone(),
                face_thumb: f.thumb.clone(),
                rect: (f.bbox[0].max(0.0) as u32, f.bbox[1].max(0.0) as u32, f.bbox[2] as u32, f.bbox[3] as u32),
                hash: f.hash,
                embedding: f.emb.clone(),
                suggested_person_key: Some(big.key.clone()),
                suggested_label: Some(big.label.clone()),
                confidence: sim.clamp(0.0, 1.0),
                question_type: "confirm_person".to_string(),
                reason: format!(
                    "{} ({} photos) looks like {} ({:.0}% similar). Confirm to merge them.",
                    small.label, small.count, big.label, sim * 100.0
                ),
                existing_persons: existing_persons.clone(),
            });
        }
    }

    // Interleave the kinds so the review queue stays varied; likely duplicates first.
    let mut suggestions = Vec::new();
    let mut its = (identify.into_iter(), borderline.into_iter().map(|x| x.1), verify.into_iter().map(|x| x.1));
    let mut same_it = same_person.into_iter();
    while suggestions.len() < 12 {
        let before = suggestions.len();
        suggestions.extend(same_it.next());
        suggestions.extend(its.0.next());
        suggestions.extend(its.1.next());
        suggestions.extend(its.2.next());
        if suggestions.len() == before {
            break;
        }
    }
    suggestions.truncate(12);
    *crate::face_model::get_suggestions_lock().write().unwrap() = suggestions.clone();
    suggestions
}

pub fn get_face_learning_suggestions() -> Vec<crate::face_model::FaceSuggestion> {
    let s = crate::face_model::get_suggestions_lock().read().unwrap();
    if !s.is_empty() {
        return s.clone();
    }
    drop(s);
    generate_initial_suggestions()
}

fn dismissed_merges() -> &'static RwLock<HashSet<String>> {
    static D: OnceLock<RwLock<HashSet<String>>> = OnceLock::new();
    D.get_or_init(|| RwLock::new(HashSet::new()))
}

pub fn submit_face_feedback(payload: crate::face_model::FaceFeedbackPayload) -> Result<crate::face_model::ModelStats, String> {
    // "Same person?" suggestions: yes merges the two people, anything else dismisses the pair.
    if let Some(rest) = payload.suggestion_id.strip_prefix("merge|") {
        if payload.action != "not_a_face" {
            let mut keys = rest.splitn(2, '|');
            let (small, big) = (keys.next().unwrap_or_default().to_string(), keys.next().unwrap_or_default().to_string());
            if payload.action == "confirm" {
                // merge_persons trains the model itself (takes the model lock - don't hold it here).
                crate::people::merge_persons(vec![big, small], payload.target_label.clone())?;
            } else {
                // "Not the same person": give both people a prototype seeded from their own faces.
                // Different confirmed people are a permanent cannot-link, and the pair becomes a
                // negative example for the metric adapter.
                dismissed_merges().write().unwrap().insert(payload.suggestion_id.clone());
                let groups = get_cached_people();
                let seeds = |key: &str| -> (String, Vec<(Vec<f32>, u64, String, String)>) {
                    let g = groups.iter().find(|g| g.key == key);
                    let paths = g.and_then(|g| g.paths.clone()).unwrap_or_default();
                    let seeds = paths
                        .iter()
                        .take(8)
                        .filter_map(|p| face_embedding_for_photo_in_group(p, &paths).map(|(e, h, t)| (e, h, t, p.clone())))
                        .collect();
                    (g.map(|g| g.label.clone()).unwrap_or_else(|| key.to_string()), seeds)
                };
                let (small_label, small_seeds) = seeds(&small);
                let (big_label, big_seeds) = seeds(&big);
                let mut model = crate::face_model::get_model_lock().write().unwrap();
                model.ensure_prototype(&small, &small_label, small_seeds);
                model.ensure_prototype(&big, &big_label, big_seeds);
                model.user_corrections += 1;
                let _ = crate::face_model::save_model_to_disk(&model);
            }
            crate::face_model::get_suggestions_lock().write().unwrap().retain(|s| s.id != payload.suggestion_id);
            spawn_recluster();
            return Ok(get_face_model_stats());
        }
    }
    let hash = payload.hash.unwrap_or(0);
    let emb = payload.embedding.clone().unwrap_or_default();
    let thumb = payload.thumb_url.clone().unwrap_or_default();
    let stats = {
        let mut model = crate::face_model::get_model_lock().write().unwrap();
        match payload.action.as_str() {
            "confirm" => {
                let key = payload.target_person_key.clone().ok_or("confirm needs a person")?;
                let label = payload.target_label.as_deref();
                model.learn_confirm(&key, label, hash, &emb, &payload.photo_path, &thumb);
                if let Some(lbl) = label {
                    let _ = crate::people::rename_person(key, lbl.to_string());
                }
            }
            "reassign" | "new_person" => {
                let target_key = payload.target_person_key.clone().unwrap_or_else(|| stable_key(&[payload.photo_path.as_str(), "manual"]));
                let target_label = payload.target_label.clone().unwrap_or_else(|| "Learned Person".to_string());
                // The suggestion's person (if any) was wrong for this face.
                let wrong = crate::face_model::get_suggestions_lock()
                    .read()
                    .unwrap()
                    .iter()
                    .find(|s| s.id == payload.suggestion_id)
                    .and_then(|s| s.suggested_person_key.clone())
                    .filter(|k| k != &target_key);
                model.learn_reassign(wrong.as_deref(), &target_key, &target_label, hash, &emb, &payload.photo_path, &thumb);
                let _ = crate::people::rename_person(target_key, target_label);
            }
            "not_a_face" => model.learn_not_a_face(hash, &emb, &payload.photo_path),
            other => return Err(format!("Unknown feedback action: {other}")),
        }
        model.get_stats()
    };
    crate::face_model::get_suggestions_lock().write().unwrap().retain(|s| s.id != payload.suggestion_id);
    spawn_recluster();
    Ok(stats)
}

pub fn get_face_model_stats() -> crate::face_model::ModelStats {
    crate::face_model::get_model_lock().read().unwrap().get_stats()
}

pub fn reset_face_model() -> crate::face_model::ModelStats {
    let mut model = crate::face_model::get_model_lock().write().unwrap();
    model.reset_model();
    model.get_stats()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn face(emb: Vec<f32>, hash: u64) -> StoredFace {
        let mut emb = emb;
        face_ai::l2_normalize(&mut emb);
        StoredFace { bbox: [0.0, 0.0, 80.0, 80.0], score: 0.95, quality: 0.8, emb, hash, thumb: "data:image/jpeg;base64,AA==".into() }
    }

    fn axis(i: usize, noise: f32) -> Vec<f32> {
        let mut v = vec![0.01f32; EMBEDDING_DIM];
        v[i] = 1.0;
        v[(i + 7) % EMBEDDING_DIM] = noise;
        v
    }

    fn with_index(files: Vec<(&str, Vec<StoredFace>)>) {
        let mut idx = get_index().write().unwrap();
        idx.files.clear();
        for (p, faces) in files {
            idx.files.insert(p.to_string(), FileRecord { mtime: 1, size: 1000, faces, failed: false });
        }
    }

    /// Re-groups this machine's real face index + model (copied into the test sandbox, originals
    /// untouched) and reports how coherent each person is. Prints numbers and labels only.
    /// Run: cargo test --lib eval_real_grouping -- --ignored --nocapture
    #[test]
    #[ignore]
    fn eval_real_grouping() {
        let app = PathBuf::from(std::env::var("APPDATA").unwrap()).join("com.pifiles.app");
        std::fs::copy(app.join("faces_index_v3.json"), face_index_path()).unwrap();
        std::fs::copy(app.join("face_model.json"), std::env::temp_dir().join("pifiles_face_model_test.json")).unwrap();
        let prev: Vec<MediaGroup> =
            serde_json::from_slice(&std::fs::read(app.join("faces_cache_v2.json")).unwrap()).unwrap();
        {
            let mut model = crate::face_model::get_model_lock().write().unwrap();
            let idx = get_index().read().unwrap();
            model.rehydrate(|p| idx.files.get(p).map(|r| r.faces.iter().map(|f| f.emb.clone()).collect()).unwrap_or_default());
            drop(idx);
            model.retrain_adapter();
        }
        let (groups, cents) = build_groups(&prev);
        let idx = get_index().read().unwrap();
        println!("{} people", groups.len());
        for g in groups.iter().take(12) {
            let c = &cents[&g.key];
            let mut s: Vec<f32> = g
                .paths
                .iter()
                .flatten()
                .filter_map(|p| idx.files.get(p))
                .filter_map(|r| r.faces.iter().map(|f| cosine(&f.emb, c)).max_by(|a, b| a.total_cmp(b)))
                .collect();
            s.sort_by(|a, b| a.total_cmp(b));
            println!(
                "  {:<14} photos={:<3} to-centroid min/p10/median = {:.2}/{:.2}/{:.2}",
                g.label, g.count, s[0], s[s.len() / 10], s[s.len() / 2]
            );
        }
        // Composition of each of the top groups relative to the top 3 centroids.
        for g in groups.iter().take(4) {
            let tops: Vec<String> = groups
                .iter()
                .take(4)
                .map(|o| {
                    let n = g
                        .paths
                        .iter()
                        .flatten()
                        .filter_map(|p| idx.files.get(p))
                        .filter(|r| r.faces.iter().any(|f| cosine(&f.emb, &cents[&o.key]) >= 0.45))
                        .count();
                    format!("{}~{}:{}", o.label, cosine(&cents[&g.key], &cents[&o.key]) as f32, n)
                })
                .collect();
            println!("  {} -> {:?}", g.label, tops);
        }
        if groups.len() > 1 {
            let (a, b) = (&groups[0], &groups[1]);
            let pa: HashSet<&String> = a.paths.iter().flatten().collect();
            for p in b.paths.iter().flatten().filter(|p| pa.contains(p)) {
                let sims: Vec<(f32, f32)> = idx.files[p].faces.iter().map(|f| (cosine(&f.emb, &cents[&a.key]), cosine(&f.emb, &cents[&b.key]))).collect();
                println!("  shared photo between {} and {}: faces (simA, simB) = {:?}", a.label, b.label, sims);
            }
        }
        // Studio shoot check: ZEM_1140+ is one man (glasses), ZEM_1108-1134 another (maroon shirt).
        for g in &groups {
            let (mut a, mut b) = (0, 0);
            for p in g.paths.iter().flatten() {
                let name = Path::new(p).file_name().unwrap().to_string_lossy().to_uppercase();
                if let Some(n) = name.strip_prefix("ZEM_").and_then(|r| r.get(..4)).and_then(|d| d.parse::<u32>().ok()) {
                    if n >= 1140 { a += 1 } else { b += 1 }
                }
            }
            if a + b > 0 {
                println!("  ZEM in {:<12} glasses={a:<3} maroon={b}", g.label);
            }
        }
        let names: Vec<String> = groups.iter().map(|g| g.label.clone()).collect();
        let dup = names.iter().filter(|n| !is_default_label(n)).count();
        println!("named people: {dup}");
    }

    /// Benchmarks the real pipeline on this machine's photos. Prints numbers only.
    /// Run: cargo test --lib eval_real_photos -- --ignored --nocapture
    #[test]
    #[ignore]
    fn eval_real_photos() {
        face_ai::warm_up().unwrap();
        let t = Instant::now();
        let mut cands = collect_candidates(&full_machine_roots());
        cands.truncate(400);
        println!("walk: {} candidates in {:?}", cands.len(), t.elapsed());

        let t = Instant::now();
        let recs: Vec<FileRecord> = cands.iter().map(analyze_candidate).collect();
        let dt = t.elapsed();
        let faces: Vec<&StoredFace> = recs.iter().flat_map(|r| r.faces.iter()).collect();
        let failed = recs.iter().filter(|r| r.failed).count();
        println!(
            "analyse (1 thread): {} photos, {} faces, {} unreadable, {:?}/photo",
            recs.len(), faces.len(), failed, dt / recs.len().max(1) as u32
        );

        // Similarity distribution: a good embedding is bimodal (strangers ~0, same person >0.4).
        let mut hist = [0usize; 10];
        let mut nn = Vec::new();
        for i in 0..faces.len() {
            let mut best = -1f32;
            for j in 0..faces.len() {
                if i != j {
                    let s = cosine(&faces[i].emb, &faces[j].emb);
                    if j > i {
                        hist[((s.clamp(-0.199, 0.799) + 0.2) * 10.0) as usize] += 1;
                    }
                    best = best.max(s);
                }
            }
            nn.push(best);
        }
        println!("pairwise cosine histogram (bins of 0.1 from -0.2): {hist:?}");
        nn.sort_by(|a, b| a.total_cmp(b));
        if !nn.is_empty() {
            println!("nearest-neighbour cosine p10/p50/p90: {:.2}/{:.2}/{:.2}", nn[nn.len() / 10], nn[nn.len() / 2], nn[nn.len() * 9 / 10]);
        }

        let embs: Vec<&[f32]> = faces.iter().map(|f| f.emb.as_slice()).collect();
        let t = Instant::now();
        let cl = crate::face_cluster::cluster(&embs, (0..embs.len()).map(|i| vec![i]).collect(), &|_, _| false, CLUSTER_AVG_SIM, CENTROID_MERGE_SIM, BRIDGE_SIM);
        let sizes: Vec<usize> = cl.iter().map(|c| c.len()).collect();
        println!("clusters in {:?}: {} (sizes {:?})", t.elapsed(), cl.len(), sizes);
        for c in cl.iter().take(5) {
            let cent = centroid_of(&c.iter().map(|&i| embs[i]).collect::<Vec<_>>());
            let mut s: Vec<f32> = c.iter().map(|&i| cosine(embs[i], &cent)).collect();
            s.sort_by(|a, b| a.total_cmp(b));
            let photos: HashSet<&str> = c.iter().map(|&i| faces[i].thumb.as_str()).collect();
            println!(
                "  cluster n={} distinct_thumbs={} to-centroid min/p10/median = {:.2}/{:.2}/{:.2}",
                c.len(), photos.len(), s[0], s[s.len() / 10], s[s.len() / 2]
            );
        }

        // Are some clusters the same person split in two? Compare centroids of multi-face clusters.
        let cents: Vec<Vec<f32>> = cl.iter().map(|c| centroid_of(&c.iter().map(|&i| embs[i]).collect::<Vec<_>>())).collect();
        let mut pairs = Vec::new();
        for a in 0..cl.len() {
            for b in (a + 1)..cl.len() {
                pairs.push((cosine(&cents[a], &cents[b]), cl[a].len(), cl[b].len()));
            }
        }
        pairs.sort_by(|x, y| y.0.total_cmp(&x.0));
        println!("closest cluster pairs (centroid cos, sizes): {:?}", &pairs[..pairs.len().min(12)]);

        // Per-stage timing on a sample.
        let (mut t_dec, mut t_det, mut t_emb, mut n_emb) = (Duration::ZERO, Duration::ZERO, Duration::ZERO, 0u32);
        for c in cands.iter().take(40) {
            let t = Instant::now();
            let Ok(img) = face_ai::load_oriented_rgb(Path::new(&c.path)) else { continue };
            t_dec += t.elapsed();
            let t = Instant::now();
            let dets = face_ai::detect_faces(&img).unwrap();
            t_det += t.elapsed();
            for d in dets.iter().take(2) {
                let t = Instant::now();
                let _ = face_ai::embed_aligned(&face_ai::align_face(&img, &d.landmarks));
                t_emb += t.elapsed();
                n_emb += 1;
            }
        }
        println!("stage avg: decode {:?}, detect {:?}, align+embed {:?}/face", t_dec / 40, t_det / 40, t_emb / n_emb.max(1));
    }

    // Both scenarios share the global index, so they run sequentially in one test.
    #[test]
    fn clustering_identities_constraints_and_embedding_roundtrip() {
        reset_face_model();
        with_index(vec![
            ("C:\\a1.jpg", vec![face(axis(0, 0.2), 1)]),
            ("C:\\a2.jpg", vec![face(axis(0, 0.3), 2)]),
            ("D:\\b1.jpg", vec![face(axis(20, 0.2), 3)]),
            ("D:\\b2.jpg", vec![face(axis(20, 0.1), 4)]),
        ]);
        let (groups, _) = build_groups(&[]);
        assert_eq!(groups.len(), 2, "two identities expected");
        assert!(groups.iter().all(|g| g.count == 2 && g.total_size == 2000));

        // Keys are reused when the same photos cluster again, so labels survive rescans.
        let (again, _) = build_groups(&groups);
        let mut k1: Vec<_> = groups.iter().map(|g| g.key.clone()).collect();
        let mut k2: Vec<_> = again.iter().map(|g| g.key.clone()).collect();
        k1.sort();
        k2.sort();
        assert_eq!(k1, k2);

        // Two moderately similar faces (0.45: would merge on similarity alone) in one photo are two
        // people; the same face repeated in one photo (collage/mirror) is one person.
        let mut other = vec![0f32; EMBEDDING_DIM];
        other[3] = 0.45;
        other[4] = 0.893;
        with_index(vec![("C:\\family.jpg", vec![face(axis(3, 0.0), 10), face(other, 11)])]);
        let (groups, _) = build_groups(&[]);
        assert_eq!(groups.len(), 2, "different people in one photo must stay apart");
        with_index(vec![("C:\\collage.jpg", vec![face(axis(3, 0.0), 12), face(axis(3, 0.05), 13)])]);
        let (groups, _) = build_groups(&[]);
        assert_eq!(groups.len(), 1, "the same face repeated in one photo is one person");

        // int8 storage keeps embeddings essentially intact.
        let f = face(axis(5, 0.4), 1);
        let json = serde_json::to_string(&f).unwrap();
        let back: StoredFace = serde_json::from_str(&json).unwrap();
        assert!(cosine(&f.emb, &back.emb) > 0.999);
    }
}
