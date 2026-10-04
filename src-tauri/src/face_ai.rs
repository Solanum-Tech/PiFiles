//! Neural face pipeline - fully local, pure Rust (tract), no ONNX Runtime DLL.
//!
//!   decode (JPEG DCT-domain downscale + EXIF orientation)
//!     → YuNet detector (OpenCV Zoo 2023mar, MIT): boxes + 5 landmarks
//!     → similarity-transform alignment to the ArcFace 112x112 template
//!     → SFace recognizer (OpenCV Zoo 2021dec, Apache-2.0): 128-D L2-normalized identity embedding
//!
//! SFace embeddings are compared with cosine similarity. OpenCV's calibrated verification
//! threshold is 0.363 (same person >= 0.363); unrelated faces typically score in -0.1..0.2.

use base64::Engine as _;
use image::{DynamicImage, GrayImage, RgbImage};
use std::collections::HashMap;
use std::io::Cursor;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use tract_onnx::prelude::*;

static YUNET_BYTES: &[u8] = include_bytes!("../assets/face_detection_yunet_2023mar.onnx");
static SFACE_BYTES: &[u8] = include_bytes!("../assets/face_recognition_sface_2021dec.onnx");

/// Bump when detector/recognizer/preprocessing changes so stale embeddings are recomputed.
pub const MODEL_TAG: &str = "yunet2023mar+sface2021dec/v1";
pub const EMBEDDING_DIM: usize = 128;

/// Long side fed to the detector. 512 keeps YuNet ~75ms/image single-threaded while still
/// finding faces down to ~12px at detector scale (~2% of the image's long side).
const DET_LONG_SIDE: u32 = 512;
/// Long side the photo is decoded at; alignment crops are sampled from this, not the detector image.
const DECODE_LONG_SIDE: u32 = 800;
const DET_SCORE_THRESH: f32 = 0.80;
const NMS_IOU: f32 = 0.30;
const MAX_FACES_PER_PHOTO: usize = 12;
const MIN_FACE_PX: f32 = 36.0;

/// ArcFace/SFace 112x112 alignment template (eye R, eye L, nose, mouth R, mouth L in image order).
const ARCFACE_TEMPLATE: [[f32; 2]; 5] = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
];

type Plan = Arc<TypedRunnableModel>;

#[derive(Debug, Clone)]
pub struct Detection {
    /// x, y, w, h in decoded-image pixels
    pub bbox: [f32; 4],
    pub landmarks: [[f32; 2]; 5],
    pub score: f32,
}

#[derive(Debug, Clone)]
pub struct FaceObservation {
    pub bbox: [f32; 4],
    pub score: f32,
    /// 0..1 - combines detector confidence, face size, sharpness and frontalness
    pub quality: f32,
    pub embedding: Vec<f32>,
    pub hash: u64,
    pub thumb: String,
}

// ---------- model loading (parsed on demand; dropped by `release_models` after a scan) ----------

#[derive(Default)]
struct Models {
    proto: Option<Arc<InferenceModel>>,
    plans: HashMap<(usize, usize), Plan>,
    sface: Option<Plan>,
}

fn models() -> &'static Mutex<Models> {
    static M: OnceLock<Mutex<Models>> = OnceLock::new();
    M.get_or_init(Default::default)
}

fn yunet_plan(h: usize, w: usize) -> Result<Plan, String> {
    let mut m = models().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = m.plans.get(&(h, w)) {
        return Ok(p.clone());
    }
    if m.proto.is_none() {
        let proto = tract_onnx::onnx()
            // YuNet ships value_info pinned to 640x640; drop it so any padded size works.
            .with_ignore_output_shapes(true)
            .with_ignore_value_info(true)
            .model_for_read(&mut Cursor::new(YUNET_BYTES))
            .map_err(|e| format!("yunet parse: {e}"))?;
        m.proto = Some(Arc::new(proto));
    }
    let plan = (*m.proto.as_ref().unwrap().as_ref())
        .clone()
        .with_input_fact(0, f32::fact([1, 3, h, w]).into())
        .and_then(|m| m.into_optimized())
        .and_then(|m| m.into_runnable())
        .map_err(|e| format!("yunet plan {h}x{w}: {e}"))?;
    m.plans.insert((h, w), plan.clone());
    Ok(plan)
}

fn sface_plan() -> Result<Plan, String> {
    let mut m = models().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = &m.sface {
        return Ok(p.clone());
    }
    let plan = tract_onnx::onnx()
        .model_for_read(&mut Cursor::new(SFACE_BYTES))
        .and_then(|m| m.with_input_fact(0, f32::fact([1, 3, 112, 112]).into()))
        .and_then(|m| m.into_optimized())
        .and_then(|m| m.into_runnable())
        .map_err(|e| format!("sface: {e}"))?;
    m.sface = Some(plan.clone());
    Ok(plan)
}

/// Frees the parsed networks (tens of MB) once a scan is done; the next scan reloads them.
pub fn release_models() {
    *models().lock().unwrap_or_else(|e| e.into_inner()) = Models::default();
}

/// Loads both networks eagerly (≈150ms) so the first scanned photo isn't penalized.
pub fn warm_up() -> Result<(), String> {
    sface_plan()?;
    yunet_plan(384, 512)?;
    yunet_plan(512, 384)?;
    Ok(())
}

// ---------- decoding ----------

/// Decodes an image upright at roughly `DECODE_LONG_SIDE`. JPEGs are downscaled inside the
/// IDCT (1/2, 1/4, 1/8), which is 3-10x faster than decoding full size and resizing.
pub fn load_oriented_rgb(path: &Path) -> Result<RgbImage, String> {
    let img = crate::thumbnail::decode_oriented(path, DECODE_LONG_SIDE)?;
    let (w, h) = (img.width(), img.height());
    let long = w.max(h);
    // Keep at most 2x the decode target so alignment crops stay sharp without wasting memory.
    let img = if long > DECODE_LONG_SIDE * 2 {
        let s = (DECODE_LONG_SIDE * 2) as f32 / long as f32;
        img.resize(
            ((w as f32 * s) as u32).max(1),
            ((h as f32 * s) as u32).max(1),
            image::imageops::FilterType::Triangle,
        )
    } else {
        img
    };
    Ok(img.to_rgb8())
}

// ---------- detection ----------

fn iou(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    let x0 = a[0].max(b[0]);
    let y0 = a[1].max(b[1]);
    let x1 = (a[0] + a[2]).min(b[0] + b[2]);
    let y1 = (a[1] + a[3]).min(b[1] + b[3]);
    let inter = (x1 - x0).max(0.0) * (y1 - y0).max(0.0);
    let union = a[2] * a[3] + b[2] * b[3] - inter;
    if union <= 0.0 { 0.0 } else { inter / union }
}

pub fn detect_faces(img: &RgbImage) -> Result<Vec<Detection>, String> {
    let (w, h) = (img.width(), img.height());
    if w < 16 || h < 16 {
        return Ok(Vec::new());
    }
    let scale = (DET_LONG_SIDE as f32 / w.max(h) as f32).min(1.0);
    let (nw, nh) = (
        ((w as f32 * scale).round() as u32).max(1),
        ((h as f32 * scale).round() as u32).max(1),
    );
    let small;
    let det_img = if scale < 1.0 {
        small = image::imageops::resize(img, nw, nh, image::imageops::FilterType::Triangle);
        &small
    } else {
        img
    };
    // YuNet needs dimensions divisible by 32; pad bottom/right with black like OpenCV does.
    let pw = ((nw + 31) / 32 * 32) as usize;
    let ph = ((nh + 31) / 32 * 32) as usize;
    let plan = yunet_plan(ph, pw)?;

    // Planar BGR, raw 0..255 (OpenCV blobFromImage without swapRB), zero padding.
    let plane = ph * pw;
    let mut buf = vec![0f32; 3 * plane];
    let row = nw as usize;
    for (y, line) in det_img.as_raw().chunks_exact(row * 3).enumerate() {
        let base = y * pw;
        for (x, px) in line.chunks_exact(3).enumerate() {
            buf[base + x] = px[2] as f32;
            buf[plane + base + x] = px[1] as f32;
            buf[2 * plane + base + x] = px[0] as f32;
        }
    }
    let input = tract_ndarray::Array4::from_shape_vec((1, 3, ph, pw), buf).map_err(|e| e.to_string())?;
    let outputs = plan
        .run(tvec!(Tensor::from(input).into()))
        .map_err(|e| format!("yunet run: {e}"))?;
    if outputs.len() < 12 {
        return Err(format!("yunet: expected 12 outputs, got {}", outputs.len()));
    }

    let mut dets: Vec<Detection> = Vec::new();
    for (si, stride) in [8usize, 16, 32].into_iter().enumerate() {
        let view = |k: usize| -> Result<&[f32], String> {
            outputs[k].try_as_plain_ram().and_then(|v| v.as_slice::<f32>()).map_err(|e| e.to_string())
        };
        let (cls, obj, bbox, kps) = (view(si)?, view(3 + si)?, view(6 + si)?, view(9 + si)?);
        let cols = pw / stride;
        let rows = ph / stride;
        let s = stride as f32;
        for idx in 0..(rows * cols).min(cls.len()) {
            let score = (cls[idx].clamp(0.0, 1.0) * obj[idx].clamp(0.0, 1.0)).sqrt();
            if score < DET_SCORE_THRESH {
                continue;
            }
            let (r, c) = ((idx / cols) as f32, (idx % cols) as f32);
            let cx = (c + bbox[idx * 4]) * s;
            let cy = (r + bbox[idx * 4 + 1]) * s;
            let bw = bbox[idx * 4 + 2].exp() * s;
            let bh = bbox[idx * 4 + 3].exp() * s;
            let mut landmarks = [[0f32; 2]; 5];
            for (n, lm) in landmarks.iter_mut().enumerate() {
                lm[0] = (kps[idx * 10 + 2 * n] + c) * s / scale;
                lm[1] = (kps[idx * 10 + 2 * n + 1] + r) * s / scale;
            }
            dets.push(Detection {
                bbox: [(cx - bw / 2.0) / scale, (cy - bh / 2.0) / scale, bw / scale, bh / scale],
                landmarks,
                score,
            });
        }
    }

    dets.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Detection> = Vec::new();
    for d in dets {
        if kept.iter().all(|k| iou(&k.bbox, &d.bbox) < NMS_IOU) {
            kept.push(d);
        }
    }
    Ok(kept)
}

// ---------- alignment ----------

/// Least-squares similarity transform (rotation + uniform scale + translation) src -> dst.
/// Returns (a, b, tx, ty) with dst = [a -b; b a] * src + t.
fn estimate_similarity(src: &[[f32; 2]; 5], dst: &[[f32; 2]; 5]) -> (f32, f32, f32, f32) {
    let n = src.len() as f32;
    let (mut msx, mut msy, mut mdx, mut mdy) = (0f32, 0f32, 0f32, 0f32);
    for i in 0..5 {
        msx += src[i][0];
        msy += src[i][1];
        mdx += dst[i][0];
        mdy += dst[i][1];
    }
    msx /= n;
    msy /= n;
    mdx /= n;
    mdy /= n;
    let (mut num_a, mut num_b, mut den) = (0f32, 0f32, 0f32);
    for i in 0..5 {
        let (sx, sy) = (src[i][0] - msx, src[i][1] - msy);
        let (dx, dy) = (dst[i][0] - mdx, dst[i][1] - mdy);
        num_a += sx * dx + sy * dy;
        num_b += sx * dy - sy * dx;
        den += sx * sx + sy * sy;
    }
    let den = den.max(1e-6);
    let (a, b) = (num_a / den, num_b / den);
    (a, b, mdx - (a * msx - b * msy), mdy - (b * msx + a * msy))
}

/// Warps the face to the canonical 112x112 ArcFace crop (bilinear, black border).
pub fn align_face(img: &RgbImage, landmarks: &[[f32; 2]; 5]) -> RgbImage {
    let (a, b, tx, ty) = estimate_similarity(landmarks, &ARCFACE_TEMPLATE);
    let det = (a * a + b * b).max(1e-9);
    let (w, h) = (img.width() as i32, img.height() as i32);
    let mut out = RgbImage::new(112, 112);
    for v in 0..112u32 {
        for u in 0..112u32 {
            let (du, dv) = (u as f32 - tx, v as f32 - ty);
            let sx = (a * du + b * dv) / det;
            let sy = (-b * du + a * dv) / det;
            let (x0, y0) = (sx.floor() as i32, sy.floor() as i32);
            let (fx, fy) = (sx - x0 as f32, sy - y0 as f32);
            let mut px = [0f32; 3];
            for (dy, wy) in [(0, 1.0 - fy), (1, fy)] {
                for (dx, wx) in [(0, 1.0 - fx), (1, fx)] {
                    let (x, y) = (x0 + dx, y0 + dy);
                    if x >= 0 && y >= 0 && x < w && y < h {
                        let p = img.get_pixel(x as u32, y as u32);
                        let wgt = wx * wy;
                        px[0] += p[0] as f32 * wgt;
                        px[1] += p[1] as f32 * wgt;
                        px[2] += p[2] as f32 * wgt;
                    }
                }
            }
            out.put_pixel(u, v, image::Rgb([px[0] as u8, px[1] as u8, px[2] as u8]));
        }
    }
    out
}

// ---------- recognition ----------

pub fn l2_normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 1e-6 {
        v.iter_mut().for_each(|x| *x /= norm);
    }
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>().clamp(-1.0, 1.0)
}

pub fn embed_aligned(aligned: &RgbImage) -> Result<Vec<f32>, String> {
    let plan = sface_plan()?;
    // RGB, raw 0..255 (OpenCV FaceRecognizerSF: blobFromImage swapRB=true, scale 1, mean 0)
    let plane = 112 * 112;
    let mut buf = vec![0f32; 3 * plane];
    for (i, px) in aligned.as_raw().chunks_exact(3).enumerate() {
        buf[i] = px[0] as f32;
        buf[plane + i] = px[1] as f32;
        buf[2 * plane + i] = px[2] as f32;
    }
    let input = tract_ndarray::Array4::from_shape_vec((1, 3, 112, 112), buf).map_err(|e| e.to_string())?;
    let out = plan
        .run(tvec!(Tensor::from(input).into()))
        .map_err(|e| format!("sface run: {e}"))?;
    let mut emb = out[0].try_as_plain_ram().and_then(|v| v.as_slice::<f32>()).map_err(|e| e.to_string())?.to_vec();
    l2_normalize(&mut emb);
    Ok(emb)
}

// ---------- quality / thumbnails ----------

fn laplacian_variance(gray: &GrayImage) -> f32 {
    let (w, h) = (gray.width(), gray.height());
    if w < 3 || h < 3 {
        return 0.0;
    }
    let (mut sum, mut sum2, mut n) = (0f64, 0f64, 0f64);
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let c = gray.get_pixel(x, y)[0] as f64;
            let l = 4.0 * c
               - gray.get_pixel(x - 1, y)[0] as f64
               - gray.get_pixel(x + 1, y)[0] as f64
               - gray.get_pixel(x, y - 1)[0] as f64
               - gray.get_pixel(x, y + 1)[0] as f64;
            sum += l;
            sum2 += l * l;
            n += 1.0;
        }
    }
    let mean = sum / n;
    (sum2 / n - mean * mean) as f32
}

fn dhash(gray: &GrayImage) -> u64 {
    let r = image::imageops::resize(gray, 9, 8, image::imageops::FilterType::Triangle);
    let mut hash = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            if r.get_pixel(x, y)[0] > r.get_pixel(x + 1, y)[0] {
                hash |= 1 << (y * 8 + x);
            }
        }
    }
    hash
}

/// Horizontal head-turn proxy from landmarks: 0 = frontal, ~1 = full profile.
fn yaw_ratio(lm: &[[f32; 2]; 5]) -> f32 {
    let eye_mid = (lm[0][0] + lm[1][0]) / 2.0;
    let eye_dist = ((lm[1][0] - lm[0][0]).powi(2) + (lm[1][1] - lm[0][1]).powi(2)).sqrt();
    if eye_dist < 1.0 {
        return 1.0;
    }
    ((lm[2][0] - eye_mid) / eye_dist).abs()
}

pub fn encode_jpeg_data_url(img: &RgbImage, quality: u8) -> Option<String> {
    let mut buf = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality)
        .encode_image(&DynamicImage::ImageRgb8(img.clone()))
        .ok()?;
    Some(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&buf)
    ))
}

/// 96x96 color avatar centered on the face with some context around it.
fn face_thumb(img: &RgbImage, bbox: &[f32; 4]) -> Option<String> {
    let side = (bbox[2].max(bbox[3]) * 1.35).min(img.width().min(img.height()) as f32);
    let cx = bbox[0] + bbox[2] / 2.0;
    let cy = bbox[1] + bbox[3] / 2.0;
    let x0 = (cx - side / 2.0).clamp(0.0, img.width() as f32 - side) as u32;
    let y0 = (cy - side / 2.0).clamp(0.0, img.height() as f32 - side) as u32;
    let side = (side as u32).max(1);
    let crop = image::imageops::crop_imm(img, x0, y0, side, side).to_image();
    let thumb = image::imageops::resize(&crop, 96, 96, image::imageops::FilterType::Triangle);
    encode_jpeg_data_url(&thumb, 82)
}

// ---------- full pipeline ----------

/// Detects, filters, aligns and embeds every usable face in a photo.
/// `Ok(vec![])` means the photo was analysed and contains no usable face.
pub fn analyze_image(path: &Path) -> Result<Vec<FaceObservation>, String> {
    let img = load_oriented_rgb(path)?;
    let mut dets = detect_faces(&img)?;
    // Largest faces first; tiny background faces are the least useful for identity.
    dets.sort_by(|a, b| (b.bbox[2] * b.bbox[3]).total_cmp(&(a.bbox[2] * a.bbox[3])));
    let mut out = Vec::new();
    for d in dets.into_iter().take(MAX_FACES_PER_PHOTO) {
        let short_side = d.bbox[2].min(d.bbox[3]);
        if short_side < MIN_FACE_PX {
            continue;
        }
        let yaw = yaw_ratio(&d.landmarks);
        if yaw > 0.9 {
            continue; // near-full profile: SFace embeddings are unreliable
        }
        let aligned = align_face(&img, &d.landmarks);
        let gray = DynamicImage::ImageRgb8(aligned.clone()).to_luma8();
        let sharpness = laplacian_variance(&gray);
        if sharpness < 12.0 {
            continue; // motion blur / out of focus
        }
        let embedding = embed_aligned(&aligned)?;
        let size_q = (short_side / 112.0).min(1.0).sqrt();
        let sharp_q = (sharpness / 200.0).min(1.0);
        let pose_q = (1.0 - yaw).clamp(0.0, 1.0);
        let quality = d.score * (0.4 * size_q + 0.3 * sharp_q + 0.3 * pose_q);
        out.push(FaceObservation {
            thumb: face_thumb(&img, &d.bbox).unwrap_or_else(crate::faces::placeholder_thumb),
            hash: dhash(&gray),
            bbox: d.bbox,
            score: d.score,
            quality,
            embedding,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn similarity_transform_recovers_known_mapping() {
        // dst = 2 * R(30deg) * src + (5, -3)
        let (c, s) = (30f32.to_radians().cos() * 2.0, 30f32.to_radians().sin() * 2.0);
        let src = [[1.0, 2.0], [5.0, 2.5], [3.0, 4.0], [1.5, 6.0], [4.5, 6.2]];
        let mut dst = [[0f32; 2]; 5];
        for i in 0..5 {
            dst[i] = [c * src[i][0] - s * src[i][1] + 5.0, s * src[i][0] + c * src[i][1] - 3.0];
        }
        let (a, b, tx, ty) = estimate_similarity(&src, &dst);
        assert!((a - c).abs() < 1e-4 && (b - s).abs() < 1e-4);
        assert!((tx - 5.0).abs() < 1e-3 && (ty + 3.0).abs() < 1e-3);
    }

    #[test]
    fn models_load_and_embed() {
        warm_up().expect("models load");
        let face = RgbImage::from_fn(112, 112, |x, y| image::Rgb([(x * 2) as u8, (y * 2) as u8, 128]));
        let e = embed_aligned(&face).unwrap();
        assert_eq!(e.len(), EMBEDDING_DIM);
        assert!((e.iter().map(|x| x * x).sum::<f32>() - 1.0).abs() < 1e-3);
        // A blank image must not produce detections.
        let blank = RgbImage::new(640, 480);
        assert!(detect_faces(&blank).unwrap().is_empty());
    }
}
