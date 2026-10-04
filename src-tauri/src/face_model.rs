use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

use crate::face_ai::cosine as cosine_similarity;
use crate::face_ai::l2_normalize;

/// Model format. v1 stored handcrafted edge features; v2 stores SFace identity embeddings.
const MODEL_VERSION: &str = "2.1-sface128";
/// A confirmed face must be at least this similar to its person's robust centroid to be trusted.
/// Genuine SFace same-person faces almost never fall below it; faces glued in by a bad (e.g. legacy
/// v1) merge sit around 0.1-0.2.
pub const CONSISTENT_SIM: f32 = 0.28;
/// Min similarity (mean of centroid and best exemplars) for a prototype to claim a face.
/// A bit above SFace's 0.363 pair threshold because a prototype match auto-names a person.
const DEFAULT_THRESHOLD: f32 = 0.42;
const MAX_THRESHOLD: f32 = 0.55;
const MAX_EXEMPLARS: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaceExemplar {
    pub hash: u64,
    pub embedding: Vec<f32>,
    pub photo_path: String,
    pub thumb_url: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NegativeExemplar {
    pub hash: u64,
    pub embedding: Vec<f32>,
    pub photo_path: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonPrototype {
    pub key: String,
    pub label: String,
    pub centroid: Vec<f32>,
    pub exemplars: Vec<FaceExemplar>,
    #[serde(default)]
    pub rejected_paths: HashSet<String>,
    #[serde(default)]
    pub negative_exemplars: Vec<NegativeExemplar>,
    /// Every photo the user placed in this person (confirm/move/merge). Unlike the capped
    /// exemplar bank this is complete, so re-clustering can must-link all of them.
    #[serde(default)]
    pub confirmed_paths: HashSet<String>,
    pub threshold: f32,
    pub training_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelStats {
    pub total_classes: usize,
    pub total_exemplars: usize,
    pub negative_exemplars: usize,
    pub user_confirmations: usize,
    pub user_corrections: usize,
    pub non_faces_filtered: usize,
    pub last_trained: u64,
    pub accuracy_score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaceSuggestion {
    pub id: String,
    pub photo_path: String,
    pub face_thumb: String,
    pub rect: (u32, u32, u32, u32),
    pub hash: u64,
    pub embedding: Vec<f32>,
    pub suggested_person_key: Option<String>,
    pub suggested_label: Option<String>,
    pub confidence: f32,
    pub question_type: String, // "confirm_person" | "identify_person" | "verify_face"
    pub reason: String,
    pub existing_persons: Vec<(String, String)>, // (key, label)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaceFeedbackPayload {
    pub action: String, // "confirm" | "reassign" | "not_a_face" | "new_person"
    pub suggestion_id: String,
    pub photo_path: String,
    pub target_person_key: Option<String>,
    pub target_label: Option<String>,
    pub hash: Option<u64>,
    pub embedding: Option<Vec<f32>>,
    pub thumb_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LearnedFaceModel {
    pub version: String,
    pub classes: HashMap<String, PersonPrototype>,
    pub negative_exemplars: Vec<NegativeExemplar>,
    pub user_confirmations: usize,
    pub user_corrections: usize,
    pub non_faces_filtered: usize,
    pub last_trained: u64,
    /// Learned 128x128 metric adapter (row-major); empty = identity (no feedback yet).
    #[serde(default)]
    pub adapter: Vec<f32>,
    #[serde(default)]
    pub cluster_threshold: Option<f32>,
    #[serde(default)]
    pub adapter_version: u64,
}

impl Default for LearnedFaceModel {
    fn default() -> Self {
        Self {
            version: MODEL_VERSION.to_string(),
            classes: HashMap::new(),
            negative_exemplars: Vec::new(),
            user_confirmations: 0,
            user_corrections: 0,
            non_faces_filtered: 0,
            last_trained: now_secs(),
            adapter: Vec::new(),
            cluster_threshold: None,
            adapter_version: 0,
        }
    }
}

static MODEL_STORE: OnceLock<RwLock<LearnedFaceModel>> = OnceLock::new();
static SUGGESTIONS_STORE: OnceLock<RwLock<Vec<FaceSuggestion>>> = OnceLock::new();

pub fn get_model_lock() -> &'static RwLock<LearnedFaceModel> {
    MODEL_STORE.get_or_init(|| {
        let model = load_model_from_disk();
        RwLock::new(model)
    })
}

pub fn get_suggestions_lock() -> &'static RwLock<Vec<FaceSuggestion>> {
    SUGGESTIONS_STORE.get_or_init(|| RwLock::new(Vec::new()))
}

fn model_file_path() -> PathBuf {
    #[cfg(test)]
    {
        std::env::temp_dir().join("pifiles_face_model_test.json")
    }
    #[cfg(not(test))]
    {
        #[cfg(windows)]
        {
            if let Ok(appdata) = std::env::var("APPDATA") {
                let dir = PathBuf::from(appdata).join("com.pifiles.app");
                let _ = fs::create_dir_all(&dir);
                return dir.join("face_model.json");
            }
            if let Ok(userprofile) = std::env::var("USERPROFILE") {
                let dir = PathBuf::from(userprofile)
                    .join("AppData")
                    .join("Roaming")
                    .join("com.pifiles.app");
                let _ = fs::create_dir_all(&dir);
                return dir.join("face_model.json");
            }
        }
        std::env::temp_dir().join("pifiles_face_model.json")
    }
}

fn load_model_from_disk() -> LearnedFaceModel {
    let mut model: LearnedFaceModel = crate::vault::read(&model_file_path())
        .and_then(|s| serde_json::from_slice(&s).ok())
        .unwrap_or_default();
    if model.version != MODEL_VERSION {
        model.migrate();
        let _ = save_model_to_disk(&model);
    }
    model
}

pub fn save_model_to_disk(model: &LearnedFaceModel) -> Result<(), String> {
    let path = model_file_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let json = serde_json::to_vec(model).map_err(|e| e.to_string())?;
    crate::vault::write(&path, &json).map_err(|e| e.to_string())
}

fn new_prototype(key: &str, label: Option<&str>) -> PersonPrototype {
    PersonPrototype {
        key: key.to_string(),
        label: label.unwrap_or(key).to_string(),
        centroid: Vec::new(),
        exemplars: Vec::new(),
        rejected_paths: HashSet::new(),
        negative_exemplars: Vec::new(),
        confirmed_paths: HashSet::new(),
        threshold: DEFAULT_THRESHOLD,
        training_count: 0,
    }
}

impl PersonPrototype {
    fn recompute_centroid(&mut self) {
        let dim = self.exemplars.iter().map(|e| e.embedding.len()).max().unwrap_or(0);
        let mut c = vec![0f32; dim];
        for e in self.exemplars.iter().filter(|e| e.embedding.len() == dim) {
            c.iter_mut().zip(&e.embedding).for_each(|(a, b)| *a += b);
        }
        l2_normalize(&mut c);
        self.centroid = c;
    }

    /// Adds an exemplar; when the bank is full, evicts the most redundant one (highest similarity
    /// to another exemplar) so the bank keeps covering distinct poses, ages and lighting.
    fn push_exemplar(&mut self, ex: FaceExemplar) {
        self.exemplars.retain(|e| e.photo_path != ex.photo_path);
        self.exemplars.push(ex);
        if self.exemplars.len() > MAX_EXEMPLARS {
            let n = self.exemplars.len();
            let mut worst = (0, f32::MIN);
            for i in 0..n {
                let redundancy = (0..n)
                    .filter(|&j| j != i)
                    .map(|j| cosine_similarity(&self.exemplars[i].embedding, &self.exemplars[j].embedding))
                    .fold(f32::MIN, f32::max);
                if redundancy > worst.1 {
                    worst = (i, redundancy);
                }
            }
            self.exemplars.remove(worst.0);
        }
        self.recompute_centroid();
    }

    /// Mean of the exemplars that agree with the majority (iteratively trimmed), so a few wrong
    /// faces can't drag the person's centre toward someone else.
    fn robust_centroid(&self) -> Vec<f32> {
        let embs: Vec<&Vec<f32>> = self.exemplars.iter().map(|e| &e.embedding).filter(|e| !e.is_empty()).collect();
        let Some(dim) = embs.first().map(|e| e.len()) else { return Vec::new() };
        let mut keep: Vec<&Vec<f32>> = embs.clone();
        let mut c = vec![0f32; dim];
        for _ in 0..4 {
            c = vec![0f32; dim];
            for e in &keep {
                c.iter_mut().zip(e.iter()).for_each(|(a, b)| *a += b);
            }
            l2_normalize(&mut c);
            let next: Vec<&Vec<f32>> = embs.iter().copied().filter(|e| cosine_similarity(e, &c) >= CONSISTENT_SIM).collect();
            if next.len() * 2 < embs.len() || next.len() == keep.len() {
                break;
            }
            keep = next;
        }
        c
    }

    /// Drops exemplars (and their confirmed photos) that don't look like the rest of this person.
    /// Returns how many were removed. Needs >= 3 exemplars to have a majority to compare against.
    fn prune_outliers(&mut self) -> usize {
        if self.exemplars.iter().filter(|e| !e.embedding.is_empty()).count() < 3 {
            return 0;
        }
        let c = self.robust_centroid();
        let bad: Vec<String> = self
            .exemplars
            .iter()
            .filter(|e| !e.embedding.is_empty() && cosine_similarity(&e.embedding, &c) < CONSISTENT_SIM)
            .map(|e| e.photo_path.clone())
            .collect();
        if bad.is_empty() {
            return 0;
        }
        self.exemplars.retain(|e| !bad.contains(&e.photo_path));
        for p in &bad {
            self.confirmed_paths.remove(p);
        }
        self.recompute_centroid();
        bad.len()
    }

    /// Similarity of a face to this person: mean of centroid match and the two best exemplar matches.
    fn score(&self, emb: &[f32]) -> Option<f32> {
        let mut ex: Vec<f32> = self
            .exemplars
            .iter()
            .filter(|e| e.embedding.len() == emb.len())
            .map(|e| cosine_similarity(emb, &e.embedding))
            .collect();
        if ex.is_empty() || self.centroid.len() != emb.len() {
            return None;
        }
        ex.sort_by(|a, b| b.total_cmp(a));
        let top = ex.iter().take(2).sum::<f32>() / ex.len().min(2) as f32;
        Some(0.5 * cosine_similarity(emb, &self.centroid) + 0.5 * top)
    }
}

impl LearnedFaceModel {
    /// Drops v1 handcrafted vectors (incompatible with SFace) but keeps identities, names,
    /// confirmed photos and rejections; `rehydrate` refills embeddings from the face index.
    fn migrate(&mut self) {
        for p in self.classes.values_mut() {
            p.centroid.clear();
            p.exemplars.iter_mut().for_each(|e| e.embedding.clear());
            p.negative_exemplars.clear();
            p.threshold = DEFAULT_THRESHOLD;
        }
        self.negative_exemplars.clear();
        self.adapter.clear();
        self.cluster_threshold = None;
        self.version = MODEL_VERSION.to_string();
    }

    /// Fills exemplars that lack an embedding using the indexed faces of their photo
    /// (`faces_of(path)`), choosing the face most consistent with the person's other exemplars.
    pub fn rehydrate(&mut self, faces_of: impl Fn(&str) -> Vec<Vec<f32>>) {
        let mut changed = false;
        for proto in self.classes.values_mut() {
            let pruned = proto.prune_outliers();
            if pruned > 0 {
                eprintln!("[face_model] {}: dropped {} inconsistent exemplars", proto.label, pruned);
                changed = true;
            }
            if proto.exemplars.iter().all(|e| !e.embedding.is_empty()) {
                continue;
            }
            // Pass 0: unambiguous single-face photos. Pass 1: group photos, best-matching face.
            for pass in 0..2 {
                let known: Vec<Vec<f32>> = proto
                    .exemplars
                    .iter()
                    .filter(|e| !e.embedding.is_empty())
                    .map(|e| e.embedding.clone())
                    .collect();
                for ex in proto.exemplars.iter_mut().filter(|e| e.embedding.is_empty()) {
                    let faces = faces_of(&ex.photo_path);
                    let pick = match (pass, faces.len()) {
                        (_, 0) => None,
                        (_, 1) => faces.into_iter().next(),
                        (1, _) if !known.is_empty() => faces.into_iter().max_by(|a, b| {
                            let sa: f32 = known.iter().map(|k| cosine_similarity(a, k)).sum();
                            let sb: f32 = known.iter().map(|k| cosine_similarity(b, k)).sum();
                            sa.total_cmp(&sb)
                        }),
                        _ => None,
                    };
                    if let Some(e) = pick {
                        ex.embedding = e;
                        changed = true;
                    }
                }
            }
            proto.recompute_centroid();
            changed |= proto.prune_outliers() > 0;
        }
        if changed {
            let _ = save_model_to_disk(self);
        }
    }

    /// Checks if a face matches a patch the user flagged as "not a face".
    pub fn is_known_negative(&self, _hash: u64, emb: &[f32]) -> bool {
        self.negative_exemplars
            .iter()
            .any(|n| n.embedding.len() == emb.len() && cosine_similarity(emb, &n.embedding) > 0.75)
    }

    /// Best matching person for a face, or None if nobody passes their threshold. A face that is
    /// closer to a person's rejected examples than to the person is never assigned to them.
    pub fn classify(&self, _hash: u64, emb: &[f32], photo_path: &str) -> Option<(String, String, f32)> {
        let mut best: Option<(&PersonPrototype, f32)> = None;
        for proto in self.classes.values() {
            if proto.rejected_paths.contains(photo_path) {
                continue;
            }
            let Some(s) = proto.score(emb) else { continue };
            let neg = proto
                .negative_exemplars
                .iter()
                .filter(|n| n.embedding.len() == emb.len())
                .map(|n| cosine_similarity(emb, &n.embedding))
                .fold(f32::MIN, f32::max);
            if neg > s {
                continue;
            }
            if s >= proto.threshold && best.map_or(true, |b| s > b.1) {
                best = Some((proto, s));
            }
        }
        best.map(|(p, s)| (p.key.clone(), p.label.clone(), s))
    }

    /// User confirms a face belongs to a person
    pub fn learn_confirm(
        &mut self,
        person_key: &str,
        label: Option<&str>,
        hash: u64,
        emb: &[f32],
        photo_path: &str,
        thumb_url: &str,
    ) {
        let now = now_secs();
        let proto = self
            .classes
            .entry(person_key.to_string())
            .or_insert_with(|| new_prototype(person_key, label));
        if let Some(lbl) = label.map(str::trim).filter(|l| !l.is_empty()) {
            proto.label = lbl.to_string();
        }
        proto.rejected_paths.remove(photo_path);
        proto.confirmed_paths.insert(photo_path.to_string());
        if !emb.is_empty() {
            proto.push_exemplar(FaceExemplar {
                hash,
                embedding: emb.to_vec(),
                photo_path: photo_path.to_string(),
                thumb_url: thumb_url.to_string(),
                timestamp: now,
            });
        }
        proto.training_count += 1;
        self.user_confirmations += 1;
        self.last_trained = now;
        let _ = save_model_to_disk(self);
    }

    /// Seeds a prototype from faces the user implicitly accepted (e.g. the photos left in a person
    /// after moving others out) so later re-clustering honours the correction.
    pub fn ensure_prototype(&mut self, key: &str, label: &str, seeds: Vec<(Vec<f32>, u64, String, String)>) {
        let proto = self
            .classes
            .entry(key.to_string())
            .or_insert_with(|| new_prototype(key, Some(label)));
        if !proto.exemplars.is_empty() {
            return;
        }
        for (emb, hash, thumb, path) in seeds {
            proto.confirmed_paths.insert(path.clone());
            if !emb.is_empty() {
                proto.push_exemplar(FaceExemplar {
                    hash,
                    embedding: emb,
                    photo_path: path,
                    thumb_url: thumb,
                    timestamp: now_secs(),
                });
            }
        }
    }

    /// User moved a photo from wrong_key to target_key:
    /// - wrong_key: the photo is rejected for good and the face becomes a hard negative
    /// - target_key: the face becomes a positive exemplar
    pub fn apply_photo_move_training(
        &mut self,
        wrong_key: &str,
        target_key: &str,
        target_label: Option<&str>,
        hash: u64,
        emb: &[f32],
        photo_path: &str,
        thumb_url: &str,
    ) {
        let now = now_secs();
        if let Some(wp) = self.classes.get_mut(wrong_key) {
            wp.rejected_paths.insert(photo_path.to_string());
            wp.confirmed_paths.remove(photo_path);
            wp.exemplars.retain(|e| e.photo_path != photo_path);
            if !emb.is_empty() {
                wp.negative_exemplars.retain(|n| n.photo_path != photo_path);
                wp.negative_exemplars.push(NegativeExemplar {
                    hash,
                    embedding: emb.to_vec(),
                    photo_path: photo_path.to_string(),
                    timestamp: now,
                });
                if wp.negative_exemplars.len() > 30 {
                    wp.negative_exemplars.remove(0);
                }
            }
            wp.recompute_centroid();
            wp.threshold = (wp.threshold + 0.02).min(MAX_THRESHOLD);
            self.user_corrections += 1;
        }

        let proto = self
            .classes
            .entry(target_key.to_string())
            .or_insert_with(|| new_prototype(target_key, target_label));
        if let Some(lbl) = target_label.map(str::trim).filter(|l| !l.is_empty()) {
            proto.label = lbl.to_string();
        }
        proto.rejected_paths.remove(photo_path);
        proto.confirmed_paths.insert(photo_path.to_string());
        proto.negative_exemplars.retain(|n| n.photo_path != photo_path);
        if !emb.is_empty() {
            proto.push_exemplar(FaceExemplar {
                hash,
                embedding: emb.to_vec(),
                photo_path: photo_path.to_string(),
                thumb_url: thumb_url.to_string(),
                timestamp: now,
            });
        }
        proto.training_count += 1;
        self.user_confirmations += 1;
        self.last_trained = now;
        let _ = save_model_to_disk(self);
    }

    /// User reassigns or corrects a person
    pub fn learn_reassign(
        &mut self,
        wrong_key: Option<&str>,
        correct_key: &str,
        correct_label: &str,
        hash: u64,
        emb: &[f32],
        photo_path: &str,
        thumb_url: &str,
    ) {
        if let Some(wk) = wrong_key {
            self.apply_photo_move_training(wk, correct_key, Some(correct_label), hash, emb, photo_path, thumb_url);
        } else {
            self.learn_confirm(correct_key, Some(correct_label), hash, emb, photo_path, thumb_url);
        }
    }

    /// Fuse two or more person prototypes into a single unified prototype (Immich/Google Photos merge model)
    /// Combines all positive exemplars from all sources, recomputes the unified centroid,
    /// consolidates negative rejection constraints, removes old classes, registers the merged key,
    /// and saves to disk.
    pub fn merge_classes(
        &mut self,
        source_keys: &[String],
        target_key: &str,
        target_label: Option<&str>,
        all_paths: &[String],
    ) {
        let now = now_secs();
        let mut combined_exemplars: Vec<FaceExemplar> = Vec::new();
        let mut combined_negatives: Vec<NegativeExemplar> = Vec::new();
        let mut combined_rejected: HashSet<String> = HashSet::new();
        let mut combined_confirmed: HashSet<String> = all_paths.iter().cloned().collect();
        let mut embeddings_for_centroid: Vec<Vec<f32>> = Vec::new();
        let mut best_label: Option<String> = None;

        for key in source_keys {
            if let Some(proto) = self.classes.remove(key) {
                if best_label.is_none() && !proto.label.to_lowercase().starts_with("person ") {
                    best_label = Some(proto.label.clone());
                }
                for ex in proto.exemplars {
                    if !combined_exemplars.iter().any(|e| e.photo_path == ex.photo_path) {
                        if !ex.embedding.is_empty() {
                            embeddings_for_centroid.push(ex.embedding.clone());
                        }
                        combined_exemplars.push(ex);
                    }
                }
                for neg in proto.negative_exemplars {
                    if !combined_negatives.iter().any(|n| n.hash == neg.hash) {
                        combined_negatives.push(neg);
                    }
                }
                combined_confirmed.extend(proto.confirmed_paths);
                for r in proto.rejected_paths {
                    combined_rejected.insert(r);
                }
            }
        }

        // Also ensure any path in all_paths has an exemplar if not present
        for p in all_paths {
            if !combined_exemplars.iter().any(|e| &e.photo_path == p) {
                if let Some((emb, hash, thumb)) = crate::faces::face_embedding_for_photo_in_group(p, all_paths) {
                    if !emb.is_empty() {
                        embeddings_for_centroid.push(emb.clone());
                    }
                    combined_exemplars.push(FaceExemplar {
                        hash,
                        embedding: emb,
                        photo_path: p.clone(),
                        thumb_url: thumb,
                        timestamp: now,
                    });
                }
            }
        }

        let final_label = target_label
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or(best_label)
            .unwrap_or_else(|| "Merged Person".to_string());

        let mut unified_proto = new_prototype(target_key, Some(&final_label));
        combined_rejected.retain(|p| !combined_confirmed.contains(p));
        unified_proto.rejected_paths = combined_rejected;
        unified_proto.confirmed_paths = combined_confirmed;
        unified_proto.negative_exemplars = combined_negatives;
        unified_proto.training_count = embeddings_for_centroid.len();
        for ex in combined_exemplars {
            unified_proto.push_exemplar(ex);
        }

        self.classes.insert(target_key.to_string(), unified_proto);
        self.user_confirmations += 1;
        self.last_trained = now;
        let _ = save_model_to_disk(self);
    }

    /// User states this detection is not a face: similar patches are suppressed from People.
    /// Only exemplars matching this exact patch are removed; other faces in the photo are kept.
    pub fn learn_not_a_face(&mut self, hash: u64, emb: &[f32], photo_path: &str) {
        for proto in self.classes.values_mut() {
            let before = proto.exemplars.len();
            proto.exemplars.retain(|e| {
                e.photo_path != photo_path || (!emb.is_empty() && cosine_similarity(&e.embedding, emb) < 0.9)
            });
            if proto.exemplars.len() != before {
                proto.recompute_centroid();
            }
        }
        self.negative_exemplars.push(NegativeExemplar {
            hash,
            embedding: emb.to_vec(),
            photo_path: photo_path.to_string(),
            timestamp: now_secs(),
        });
        if self.negative_exemplars.len() > 100 {
            self.negative_exemplars.remove(0);
        }
        self.non_faces_filtered += 1;
        self.last_trained = now_secs();
        let _ = save_model_to_disk(self);
    }

    pub fn get_stats(&self) -> ModelStats {
        let total_exemplars: usize = self.classes.values().map(|c| c.exemplars.len()).sum();
        let total_feedback = self.user_confirmations + self.user_corrections;
        let accuracy_score = if total_feedback > 0 {
            (self.user_confirmations as f32 / total_feedback as f32) * 100.0
        } else {
            95.0
        };

        ModelStats {
            total_classes: self.classes.len(),
            total_exemplars,
            negative_exemplars: self.negative_exemplars.len(),
            user_confirmations: self.user_confirmations,
            user_corrections: self.user_corrections,
            non_faces_filtered: self.non_faces_filtered,
            last_trained: self.last_trained,
            accuracy_score,
        }
    }

    pub fn reset_model(&mut self) {
        self.classes.clear();
        self.negative_exemplars.clear();
        self.user_confirmations = 0;
        self.user_corrections = 0;
        self.non_faces_filtered = 0;
        self.adapter.clear();
        self.cluster_threshold = None;
        self.last_trained = now_secs();
        let _ = save_model_to_disk(self);
    }
}

// ---------- personal metric adaptation ----------
//
// SFace is a fixed, pretrained network. What adapts to the user's library is a linear projection
// W (128x128, initialised to identity) applied before clustering. It is trained on the user's own
// feedback: faces confirmed/merged into one person are pulled together, faces moved out of a person
// (hard negatives) and different confirmed people are pushed apart. A penalty on ||W - I||² keeps
// it close to the pretrained metric, so a handful of corrections can't wreck it.

const ADAPT_POS_MARGIN: f32 = 0.55;
const ADAPT_NEG_MARGIN: f32 = 0.20;
const ADAPT_L2: f32 = 0.02;
const ADAPT_LR: f32 = 0.05;
const ADAPT_EPOCHS: usize = 40;
const ADAPT_MAX_PAIRS: usize = 3000;
pub const DEFAULT_CLUSTER_THRESHOLD: f32 = 0.38;

fn norm(v: &[f32]) -> f32 {
    v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6)
}

fn matvec(w: &[f32], d: usize, x: &[f32]) -> Vec<f32> {
    (0..d).map(|r| w[r * d..(r + 1) * d].iter().zip(x).map(|(a, b)| a * b).sum()).collect()
}

impl LearnedFaceModel {
    /// Projects a raw SFace embedding into the user-adapted space (L2-normalized).
    pub fn adapt(&self, emb: &[f32]) -> Vec<f32> {
        let d = emb.len();
        let mut out = if self.adapter.len() == d * d { matvec(&self.adapter, d, emb) } else { emb.to_vec() };
        l2_normalize(&mut out);
        out
    }

    /// Clustering cutoff calibrated on the user's labelled pairs (falls back to the default).
    pub fn cluster_threshold(&self) -> f32 {
        self.cluster_threshold.unwrap_or(DEFAULT_CLUSTER_THRESHOLD)
    }

    /// Labelled pairs from feedback: (a, b, same_person).
    fn training_pairs(&self) -> Vec<(Vec<f32>, Vec<f32>, bool)> {
        let protos: Vec<(&PersonPrototype, Vec<&Vec<f32>>)> = self
            .classes
            .values()
            .map(|p| (p, p.exemplars.iter().map(|e| &e.embedding).filter(|e| !e.is_empty()).collect()))
            .collect();
        let mut pos = Vec::new();
        let mut neg = Vec::new();
        for (pi, (proto, ex)) in protos.iter().enumerate() {
            for i in 0..ex.len() {
                for j in (i + 1)..ex.len() {
                    pos.push((ex[i].clone(), ex[j].clone(), true));
                }
                // Hard negatives: faces the user moved out of this person.
                for n in proto.negative_exemplars.iter().filter(|n| n.embedding.len() == ex[i].len()) {
                    neg.push((ex[i].clone(), n.embedding.clone(), false));
                }
                // Different confirmed people.
                for (_, other) in protos.iter().skip(pi + 1) {
                    for o in other.iter().take(4) {
                        neg.push((ex[i].clone(), (*o).clone(), false));
                    }
                }
            }
        }
        // Balance and cap deterministically.
        let step = |n: usize| (n / (ADAPT_MAX_PAIRS / 2)).max(1);
        let (sp, sn) = (step(pos.len()), step(neg.len()));
        pos.into_iter().step_by(sp).chain(neg.into_iter().step_by(sn)).collect()
    }

    /// Re-fits the adapter and the clustering threshold from all feedback so far.
    /// Needs at least a few same-person and different-person examples; otherwise stays at identity.
    pub fn retrain_adapter(&mut self) {
        let pairs = self.training_pairs();
        let n_pos = pairs.iter().filter(|p| p.2).count();
        let n_neg = pairs.len() - n_pos;
        let d = pairs.first().map(|p| p.0.len()).unwrap_or(0);
        if n_pos < 3 || n_neg < 3 || d == 0 {
            self.adapter.clear();
            self.cluster_threshold = None;
            return;
        }
        let mut w = vec![0f32; d * d];
        (0..d).for_each(|i| w[i * d + i] = 1.0);

        for _ in 0..ADAPT_EPOCHS {
            let mut grad = vec![0f32; d * d];
            let mut active = 0usize;
            for (a, b, same) in &pairs {
                let (u, v) = (matvec(&w, d, a), matvec(&w, d, b));
                let (nu, nv) = (norm(&u), norm(&v));
                let s = u.iter().zip(&v).map(|(x, y)| x * y).sum::<f32>() / (nu * nv);
                // Hinge: pull same-person pairs above the positive margin, push others below the negative.
                let coef = match same {
                    true if s < ADAPT_POS_MARGIN => -1.0,
                    false if s > ADAPT_NEG_MARGIN => 1.0,
                    _ => continue,
                };
                active += 1;
                // d s / d u = v/(|u||v|) - s u/|u|² ; dL/dW = coef * (ds/du aᵀ + ds/dv bᵀ)
                for r in 0..d {
                    let du = v[r] / (nu * nv) - s * u[r] / (nu * nu);
                    let dv = u[r] / (nu * nv) - s * v[r] / (nv * nv);
                    let row = &mut grad[r * d..(r + 1) * d];
                    for c in 0..d {
                        row[c] += coef * (du * a[c] + dv * b[c]);
                    }
                }
            }
            if active == 0 {
                break;
            }
            let scale = ADAPT_LR / active as f32;
            for r in 0..d {
                for c in 0..d {
                    let reg = ADAPT_L2 * (w[r * d + c] - if r == c { 1.0 } else { 0.0 });
                    w[r * d + c] -= scale * grad[r * d + c] + ADAPT_LR * reg;
                }
            }
        }
        self.adapter = w;

        // Calibrate: the cutoff that best separates labelled pairs in the adapted space,
        // kept in a sane band around SFace's published 0.363 operating point.
        let scored: Vec<(f32, bool)> = pairs
            .iter()
            .map(|(a, b, same)| (cosine_similarity(&self.adapt(a), &self.adapt(b)), *same))
            .collect();
        let mut best = (DEFAULT_CLUSTER_THRESHOLD, usize::MAX);
        for step in 0..=20 {
            let t = 0.30 + step as f32 * 0.01;
            let errors = scored.iter().filter(|(s, same)| (*s >= t) != *same).count();
            if errors < best.1 {
                best = (t, errors);
            }
        }
        self.cluster_threshold = Some(best.0);
        self.adapter_version += 1;
        let _ = save_model_to_disk(self);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_learns_from_feedback() {
        let mut model = LearnedFaceModel::default();
        // Two people whose raw embeddings overlap heavily on a shared "nuisance" direction (e.g. lighting).
        let mk = |id: usize, nuisance: f32, jitter: usize| {
            let mut v = vec![0.0f32; 128];
            v[id] = 0.6;
            v[100] = nuisance;
            v[50 + jitter] = 0.35;
            l2_normalize(&mut v);
            v
        };
        for j in 0..4 {
            model.learn_confirm("alice", Some("Alice"), 0, &mk(0, 0.9, j), &format!("a{j}.jpg"), "");
            model.learn_confirm("bob", Some("Bob"), 0, &mk(1, 0.9, j + 4), &format!("b{j}.jpg"), "");
        }
        let (a1, a2, b1) = (mk(0, 0.9, 20), mk(0, 0.9, 21), mk(1, 0.9, 22));
        let raw_same = cosine_similarity(&a1, &a2);
        let raw_diff = cosine_similarity(&a1, &b1);

        model.retrain_adapter();
        assert_eq!(model.adapter.len(), 128 * 128);
        let same = cosine_similarity(&model.adapt(&a1), &model.adapt(&a2));
        let diff = cosine_similarity(&model.adapt(&a1), &model.adapt(&b1));
        assert!(same - diff > raw_same - raw_diff, "adapter must widen the same/different margin");
        let t = model.cluster_threshold();
        assert!((0.30..=0.50).contains(&t));
    }

    #[test]
    fn test_merge_classes_unifies_exemplars_and_centroid() {
        let mut model = LearnedFaceModel::default();

        let mut emb1 = vec![0.0f32; 128];
        emb1[0] = 1.0;
        let mut emb2 = vec![0.0f32; 128];
        emb2[1] = 1.0;

        model.learn_confirm("p1", Some("Person 1"), 100, &emb1, "C:\\smile.jpg", "thumb1");
        model.learn_confirm("p2", Some("Person 2"), 200, &emb2, "C:\\serious.jpg", "thumb2");

        assert_eq!(model.classes.len(), 2);

        // Merge p1 and p2 into unified person
        model.merge_classes(&["p1".to_string(), "p2".to_string()], "p_merged", Some("John Doe"), &[]);

        assert_eq!(model.classes.len(), 1);
        let merged = model.classes.get("p_merged").expect("p_merged should exist");
        assert_eq!(merged.label, "John Doe");
        assert_eq!(merged.exemplars.len(), 2);

        // Verify both smiling and serious vectors now classify as p_merged
        let (k1, l1, conf1) = model.classify(100, &emb1, "C:\\new_smile.jpg").unwrap();
        assert_eq!(k1, "p_merged");
        assert_eq!(l1, "John Doe");
        assert!(conf1 >= DEFAULT_THRESHOLD);

        let (k2, l2, conf2) = model.classify(200, &emb2, "C:\\new_serious.jpg").unwrap();
        assert_eq!(k2, "p_merged");
        assert_eq!(l2, "John Doe");
        assert!(conf2 >= DEFAULT_THRESHOLD);
    }
}
