use std::collections::HashMap;
use std::path::PathBuf;
use std::fs;

// Persistent label store for People (Immich/Google Photos-like)
// Stored as JSON HashMap<cluster_key, label> in %APPDATA%\com.fileexplorer.app\people_labels.json
// Fallback: %TEMP%\file_explorer_people_labels.json
// Keys are stable deterministic centroid hashes like person_0123abcd... or legacy person_1

fn labels_path() -> PathBuf {
    // Prefer APPDATA (Roaming) on Windows
    if let Ok(appdata) = std::env::var("APPDATA") {
        let dir = PathBuf::from(appdata).join("com.fileexplorer.app");
        let _ = fs::create_dir_all(&dir);
        return dir.join("people_labels.json");
    }
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        let dir = PathBuf::from(userprofile)
            .join("AppData")
            .join("Roaming")
            .join("com.fileexplorer.app");
        let _ = fs::create_dir_all(&dir);
        return dir.join("people_labels.json");
    }
    // Fallback to temp dir (always writable)
    std::env::temp_dir().join("file_explorer_people_labels.json")
}

pub fn load_labels() -> HashMap<String, String> {
    let path = labels_path();
    if !path.exists() {
        return HashMap::new();
    }
    crate::vault::read(&path).and_then(|s| serde_json::from_slice(&s).ok()).unwrap_or_default()
}

pub fn save_labels(map: &HashMap<String, String>) -> Result<(), String> {
    let path = labels_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let json = serde_json::to_vec(map).map_err(|e| e.to_string())?;
    crate::vault::write(&path, &json).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_person_labels() -> HashMap<String, String> {
    load_labels()
}

pub fn rename_person(person_key: String, label: String) -> Result<String, String> {
    let mut map = load_labels();
    let trimmed = label.trim().to_string();
    if trimmed.is_empty() {
        // Empty label => remove (revert to default Person N)
        map.remove(&person_key);
        save_labels(&map)?;
        return Ok(String::new());
    }
    if trimmed.len() > 48 {
        return Err("label too long (max 48 chars)".into());
    }
    // Basic sanitization: disallow path separators
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("label cannot contain / or \\".into());
    }
    map.insert(person_key.clone(), trimmed.clone());
    save_labels(&map)?;
    Ok(trimmed)
}

pub fn delete_person(person_key: String) -> Result<String, String> {
    let mut map = load_labels();
    map.remove(&person_key);
    save_labels(&map)?;
    Ok(person_key)
}

/// Manual merge (Immich/Google Photos-like): user selects 2+ person keys and merges them.
/// Merges face clusters in PEOPLE_CACHE + face index JSON and updates people_labels.json.
/// `keys` are stable keys like `person_{:016x}` or legacy `person_4`. `new_label` is optional display name.
/// Returns the new merged MediaGroup.
pub fn merge_persons(keys: Vec<String>, new_label: Option<String>) -> Result<crate::media::MediaGroup, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::time::{SystemTime, UNIX_EPOCH};

    if keys.len() < 2 {
        return Err("select at least 2 persons to merge".into());
    }
    // dedup + trim
    let mut uniq: Vec<String> = Vec::new();
    for k in keys {
        let t = k.trim().to_string();
        if t.is_empty() {
            continue;
        }
        if !uniq.contains(&t) {
            uniq.push(t);
        }
    }
    if uniq.len() < 2 {
        return Err("select at least 2 distinct persons".into());
    }

    // Load cached groups and find matches
    let cached = crate::faces::get_cached_people();
    let mut matched: Vec<crate::media::MediaGroup> = Vec::new();
    for k in &uniq {
        if let Some(g) = cached.iter().find(|x| &x.key == k) {
            matched.push(g.clone());
        }
    }
    // Allow merging even if cache miss for 1 entry (label-only merge) but require at least 2 found
    if matched.len() < 2 {
        // Try label-only fallback: create synthetic groups from labels map if cache empty
        // But require at least 2 valid keys to proceed; if cache empty, synthesize minimal groups
        let labels = load_labels();
        let mut synthetic: Vec<crate::media::MediaGroup> = Vec::new();
        for k in &uniq {
            // synthesize from label or default
            let lbl = labels.get(k).cloned().unwrap_or_else(|| k.clone());
            synthetic.push(crate::media::MediaGroup {
                key: k.clone(),
                label: lbl,
                count: 1,
                total_size: 0,
                preview: Vec::new(),
                face_count: Some(1),
                paths: Some(Vec::new()),
            });
        }
        if cached.is_empty() {
            matched = synthetic;
        } else {
            return Err(format!(
                "only {}/{} persons found in cache (try Refresh): {:?}",
                matched.len(),
                uniq.len(),
                uniq
            ));
        }
    }

    // Merge fields
    let count: usize = matched.iter().map(|g| g.count).sum();
    let total_size: u64 = matched.iter().map(|g| g.total_size).sum();
    let face_count: usize = matched
        .iter()
        .map(|g| g.face_count.unwrap_or(g.count))
        .sum();

    // preview: first 4 unique face thumbs (data URLs) in order
    let mut preview: Vec<String> = Vec::new();
    let mut seen_prev = std::collections::HashSet::new();
    for g in &matched {
        for p in &g.preview {
            if seen_prev.insert(p.clone()) {
                preview.push(p.clone());
                if preview.len() >= 4 {
                    break;
                }
            }
        }
        if preview.len() >= 4 {
            break;
        }
    }
    if preview.is_empty() {
        // fallback placeholder if no thumbs (should not happen)
        preview.push("data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"96\" height=\"96\" viewBox=\"0 0 96 96\"><rect width=\"96\" height=\"96\" rx=\"48\" fill=\"#e5e5e5\"/><circle cx=\"48\" cy=\"38\" r=\"18\" fill=\"#bdbdbd\"/><path d=\"M16 86c6-14 18-22 32-22s26 8 32 22\" fill=\"#bdbdbd\"/></svg>".to_string());
    }

    // paths: combine all file paths, dedup, cap 50
    let mut paths: Vec<String> = Vec::new();
    let mut seen_path = std::collections::HashSet::new();
    for g in &matched {
        if let Some(ps) = &g.paths {
            for p in ps {
                if seen_path.insert(p.clone()) {
                    paths.push(p.clone());
                    if paths.len() >= 50 {
                        break;
                    }
                }
            }
        }
        if paths.len() >= 50 {
            break;
        }
    }

    // label: explicit new_label > first non-default > first matched label
    let trimmed_new = new_label
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let label = if let Some(t) = trimmed_new {
        if t.len() > 48 {
            return Err("label too long (max 48 chars)".into());
        }
        if t.contains('/') || t.contains('\\') {
            return Err("label cannot contain / or \\".into());
        }
        t
    } else {
        // prefer first labeled (non Person N) among matched
        let first_labeled = matched
            .iter()
            .find(|g| !g.label.trim().is_empty() && !is_default_person_label(&g.label))
            .map(|g| g.label.clone());
        first_labeled
            .or_else(|| matched.first().map(|g| g.label.clone()))
            .unwrap_or_else(|| "Merged Person".to_string())
    };

    // new stable key: person_merged_{16hex} from hash of sorted uniq + timestamp
    let mut sorted = uniq.clone();
    sorted.sort();
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut hasher = DefaultHasher::new();
    sorted.hash(&mut hasher);
    millis.hash(&mut hasher);
    let h = hasher.finish();
    let new_key = format!("person_merged_{:016x}", h);

    let merged = crate::media::MediaGroup {
        key: new_key.clone(),
        label: label.clone(),
        count,
        total_size,
        preview,
        face_count: Some(face_count),
        paths: Some(paths.clone()),
    };

    // Update labels JSON: remove old keys, insert new_key
    {
        let mut map = load_labels();
        for k in &uniq {
            map.remove(k);
        }
        map.insert(new_key.clone(), label.clone());
        save_labels(&map)?;
    }

    // Update PEOPLE_CACHE + face index JSON (if cached was used)
    // Even if matched was synthetic (cache empty), still push to cache so UI shows merged group
    let _ = crate::faces::merge_cached_groups(&uniq, merged.clone());

    // Train the AI Face Model (Prototype Fusion): combine all exemplars, recompute unified centroid, save to disk
    {
        let mut model = crate::face_model::get_model_lock().write().unwrap();
        model.merge_classes(&uniq, &new_key, Some(&label), &paths);
    }

    eprintln!(
        "[people] merge_persons {} -> {} count={} label={:?}",
        uniq.join(","),
        new_key,
        count,
        label
    );
    Ok(merged)
}

fn is_default_person_label(s: &str) -> bool {
    let t = s.trim();
    if !t.to_lowercase().starts_with("person ") {
        return false;
    }
    t[7..].trim().parse::<u32>().is_ok()
}

#[allow(dead_code)]
pub fn get_labels_path_debug() -> String {
    labels_path().to_string_lossy().to_string()
}

/// Move one or more photos from a person to another person (or split into a new person).
/// Updates PEOPLE_CACHE, recomputes sizes/counts, establishes hard-negative rejection
/// on the source prototype, and saves to disk.
pub fn move_person_photos(
    source_key: &str,
    photo_paths: Vec<String>,
    target_key: Option<String>,
    target_label: Option<String>,
) -> Result<crate::media::PeopleGroups, String> {
    if photo_paths.is_empty() {
        return Err("No photos specified to move".into());
    }
    let mut groups = crate::faces::get_cached_people();
    if groups.is_empty() {
        return Err("No people loaded in cache".into());
    }

    // 1. Find source group
    let source_idx = groups
        .iter()
        .position(|g| g.key == source_key)
        .ok_or_else(|| format!("Source person '{}' not found", source_key))?;

    let source_paths_before = groups[source_idx].paths.clone().unwrap_or_default();
    let source_label = groups[source_idx].label.clone();
    // Resolve the moved faces once (index lookup; group photos pick the face matching this person).
    let moved_faces: Vec<(String, Option<(Vec<f32>, u64, String)>)> = photo_paths
        .iter()
        .map(|p| (p.clone(), crate::faces::face_embedding_for_photo_in_group(p, &source_paths_before)))
        .collect();

    // 2. Remove photo_paths from source group
    let paths_set: std::collections::HashSet<&str> = photo_paths.iter().map(|s| s.as_str()).collect();

    let remaining_count = if let Some(paths) = &mut groups[source_idx].paths {
        paths.retain(|p| !paths_set.contains(p.as_str()));
        paths.len()
    } else {
        0
    };
    groups[source_idx].count = remaining_count;
    groups[source_idx].face_count = Some(remaining_count);

    // Recompute source total size
    let remaining_paths = groups[source_idx].paths.clone().unwrap_or_default();
    let source_files = crate::fs::get_files_info(&remaining_paths);
    groups[source_idx].total_size = source_files.iter().map(|f| f.size).sum();

    // 3. Target group handling
    let mut target_key_final = target_key.clone();
    let mut new_key_final = String::new();
    if let Some(tk) = &target_key {
        if let Some(target_idx) = groups.iter().position(|g| &g.key == tk) {
            let mut current_paths = groups[target_idx].paths.clone().unwrap_or_default();
            for p in &photo_paths {
                if !current_paths.contains(p) {
                    current_paths.push(p.clone());
                }
            }
            let target_files = crate::fs::get_files_info(&current_paths);
            groups[target_idx].total_size = target_files.iter().map(|f| f.size).sum();
            groups[target_idx].count = current_paths.len();
            groups[target_idx].face_count = Some(current_paths.len());
            groups[target_idx].paths = Some(current_paths);
            if let Some(lbl) = &target_label {
                if !lbl.trim().is_empty() {
                    groups[target_idx].label = lbl.trim().to_string();
                }
            }
        } else {
            target_key_final = None; // create new
        }
    }

    if target_key_final.is_none() {
        // Create new person group for moved photos
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        photo_paths.hash(&mut hasher);
        let h = hasher.finish();
        let new_key = format!("person_split_{:016x}", h);
        new_key_final = new_key.clone();
        let new_label = target_label.clone().unwrap_or_else(|| format!("Person {}", groups.len() + 1));
        let target_files = crate::fs::get_files_info(&photo_paths);
        let total_size = target_files.iter().map(|f| f.size).sum();
        let mut preview: Vec<String> = moved_faces
            .iter()
            .filter_map(|(_, f)| f.as_ref().map(|f| f.2.clone()))
            .take(4)
            .collect();
        if preview.is_empty() {
            preview.push(crate::faces::placeholder_thumb());
        }

        groups.push(crate::media::MediaGroup {
            key: new_key.clone(),
            label: new_label,
            count: photo_paths.len(),
            total_size,
            preview,
            face_count: Some(photo_paths.len()),
            paths: Some(photo_paths.clone()),
        });
    }

    // Remove source group if empty
    if groups[source_idx].count == 0 {
        groups.remove(source_idx);
    }

    let target_key_to_train = if let Some(tk) = &target_key_final {
        tk.clone()
    } else {
        new_key_final
    };

    // 4. Train the model: the photos left in the source are implicitly accepted (seed its prototype
    //    so the correction survives re-clustering), moved faces become hard negatives for the
    //    source and positives for the target.
    {
        let remaining: Vec<String> = source_paths_before
            .iter()
            .filter(|p| !paths_set.contains(p.as_str()))
            .take(8)
            .cloned()
            .collect();
        let seeds: Vec<(Vec<f32>, u64, String, String)> = remaining
            .iter()
            .filter_map(|p| {
                crate::faces::face_embedding_for_photo_in_group(p, &remaining).map(|(e, h, t)| (e, h, t, p.clone()))
            })
            .collect();
        let mut model = crate::face_model::get_model_lock().write().unwrap();
        model.ensure_prototype(source_key, &source_label, seeds);
        for (p, face) in &moved_faces {
            let (emb, hash, thumb) = face.clone().unwrap_or_else(|| (Vec::new(), 0, crate::faces::placeholder_thumb()));
            model.apply_photo_move_training(
                source_key,
                &target_key_to_train,
                target_label.as_deref(),
                hash,
                &emb,
                p,
                &thumb,
            );
        }
    }

    // Sort and persist
    groups.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.key.cmp(&b.key)));
    crate::faces::set_cached_people(groups.clone());

    Ok(crate::media::PeopleGroups { groups })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_move_person_photos_to_existing_and_new() {
        // Setup mock cache with 2 people
        let p1 = crate::media::MediaGroup {
            key: "test_p1".to_string(),
            label: "Person 1".to_string(),
            count: 3,
            total_size: 300,
            preview: vec![],
            face_count: Some(3),
            paths: Some(vec!["C:\\pic1.jpg".to_string(), "C:\\pic2.jpg".to_string(), "C:\\pic3.jpg".to_string()]),
        };
        let p2 = crate::media::MediaGroup {
            key: "test_p2".to_string(),
            label: "Person 2".to_string(),
            count: 1,
            total_size: 100,
            preview: vec![],
            face_count: Some(1),
            paths: Some(vec!["C:\\pic4.jpg".to_string()]),
        };
        crate::faces::set_cached_people(vec![p1, p2]);

        // Move pic2 from p1 to p2
        let res = move_person_photos("test_p1", vec!["C:\\pic2.jpg".to_string()], Some("test_p2".to_string()), None).unwrap();
        
        let p1_after = res.groups.iter().find(|g| g.key == "test_p1").unwrap();
        let p2_after = res.groups.iter().find(|g| g.key == "test_p2").unwrap();

        assert_eq!(p1_after.count, 2);
        assert!(!p1_after.paths.as_ref().unwrap().contains(&"C:\\pic2.jpg".to_string()));
        assert_eq!(p2_after.count, 2);
        assert!(p2_after.paths.as_ref().unwrap().contains(&"C:\\pic2.jpg".to_string()));

        // Split pic1 from p1 into a brand new person "Person 3"
        let res2 = move_person_photos("test_p1", vec!["C:\\pic1.jpg".to_string()], None, Some("Charlie".to_string())).unwrap();
        assert_eq!(res2.groups.len(), 3);
        let charlie = res2.groups.iter().find(|g| g.label == "Charlie").unwrap();
        assert_eq!(charlie.count, 1);
        assert!(charlie.paths.as_ref().unwrap().contains(&"C:\\pic1.jpg".to_string()));
    }
}
