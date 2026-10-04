//! Movie playback backed by the bundled FFmpeg (LGPL build in `ffmpeg/`).
//!
//! - `probe`: container, codecs, duration, every audio track and subtitle track (embedded and
//!   external `.srt/.vtt/.ass` files next to the movie).
//! - `subtitle_vtt`: converts any text subtitle track to WebVTT for the in-app renderer.
//! - `open`/`read`/`close`: when WebView2 can't play the file directly (MKV/AVI, AC-3/DTS audio,
//!   HEVC/VC-1 video, or a non-default audio track), FFmpeg remuxes (codec copy - cheap) or
//!   transcodes with the fastest available hardware H.264 encoder into fragmented MP4, which the
//!   player pulls over IPC into a MediaSource. No network port is opened.

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();
static FFMPEG_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
static ENCODER: OnceLock<String> = OnceLock::new();

pub fn init(resource_dir: Option<PathBuf>) {
    if let Some(d) = resource_dir {
        let _ = RESOURCE_DIR.set(d);
    }
    // Checksums of the bundled FFmpeg and encoder detection take a moment; do both in the
    // background at startup so the first movie doesn't wait for them.
    std::thread::spawn(|| {
        if let Some(d) = ffmpeg_dir() {
            let _ = ffmpeg_verified(d);
        }
        let _ = encoder();
    });
}

fn ffmpeg_dir() -> Option<&'static PathBuf> {
    FFMPEG_DIR
        .get_or_init(|| {
            let mut candidates = Vec::new();
            if let Some(r) = RESOURCE_DIR.get() {
                candidates.push(r.join("ffmpeg"));
            }
            if let Some(d) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
                candidates.push(d.join("ffmpeg"));
            }
            candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("ffmpeg")); // `tauri dev`
            candidates.into_iter().find(|d| d.join(exe("ffmpeg")).exists() && d.join(exe("ffprobe")).exists())
        })
        .as_ref()
}

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

pub fn available() -> bool {
    ffmpeg_dir().is_some()
}

include!(concat!(env!("OUT_DIR"), "/ffmpeg_pins.rs"));

/// Anti-tamper: every bundled FFmpeg file must match the SHA-256 recorded at build time
/// (build.rs). Checked once per run; a replaced or patched ffmpeg.exe/DLL is never launched.
fn ffmpeg_verified(dir: &Path) -> Result<(), String> {
    static OK: OnceLock<Result<(), String>> = OnceLock::new();
    OK.get_or_init(|| {
        if FFMPEG_PINS.is_empty() {
            return Err("This build has no FFmpeg checksums; refusing to run unverified FFmpeg".into());
        }
        use sha2::{Digest, Sha256};
        for (name, want) in FFMPEG_PINS {
            let bytes = std::fs::read(dir.join(name)).map_err(|_| format!("FFmpeg file {name} is missing - reinstall PiFiles"))?;
            let got: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
            if &got != want {
                return Err(format!("FFmpeg file {name} was modified after installation - reinstall PiFiles"));
            }
        }
        Ok(())
    })
    .clone()
}

fn tool(name: &str) -> Result<Command, String> {
    let dir = ffmpeg_dir().ok_or("FFmpeg isn't installed next to PiFiles (run scripts/fetch-ffmpeg.ps1)")?;
    ffmpeg_verified(dir)?;
    let mut c = Command::new(dir.join(exe(name)));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashes
    }
    c.stdin(Stdio::null());
    Ok(c)
}

// ---------- probe ----------

#[derive(Serialize, Clone)]
pub struct VideoStream {
    pub codec: String,
    pub profile: String,
    pub pix_fmt: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

#[derive(Serialize, Clone)]
pub struct AudioTrack {
    pub index: usize,
    pub codec: String,
    pub channels: u32,
    pub language: String,
    pub title: String,
    pub default: bool,
}

#[derive(Serialize, Clone)]
pub struct SubtitleTrack {
    pub id: String,
    pub index: Option<usize>,
    pub external: Option<String>,
    pub codec: String,
    pub language: String,
    pub title: String,
    /// Text-based tracks can be shown; image-based ones (PGS/DVD) can't be converted to text.
    pub text: bool,
    pub default: bool,
    pub forced: bool,
}

#[derive(Serialize, Clone)]
pub struct MediaInfo {
    pub duration: f64,
    pub container: String,
    pub video: Option<VideoStream>,
    pub audio: Vec<AudioTrack>,
    pub subtitles: Vec<SubtitleTrack>,
    /// WebView2 can play the file as-is (native seeking, zero CPU).
    pub direct_play: bool,
    pub encoder: String,
}

const TEXT_SUBS: &[&str] = &["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "microdvd", "subviewer", "subviewer1", "sami", "realtext", "mpl2", "jacosub", "stl"];
const WEB_VIDEO: &[&str] = &["h264", "vp8", "vp9", "av1"];
const WEB_AUDIO: &[&str] = &["aac", "mp3", "opus", "vorbis", "flac"];

fn s(v: &serde_json::Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn tag(v: &serde_json::Value, k: &str) -> String {
    v.get("tags").and_then(|t| t.get(k).or_else(|| t.get(&k.to_uppercase()))).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn disp(v: &serde_json::Value, k: &str) -> bool {
    v.get("disposition").and_then(|d| d.get(k)).and_then(|x| x.as_i64()).unwrap_or(0) == 1
}

fn external_subtitles(path: &Path) -> Vec<SubtitleTrack> {
    let (Some(dir), Some(stem)) = (path.parent(), path.file_stem().map(|s| s.to_string_lossy().to_lowercase())) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let lower = name.to_lowercase();
        let Some(ext) = p.extension().map(|x| x.to_string_lossy().to_lowercase()) else { continue };
        if !matches!(ext.as_str(), "srt" | "vtt" | "ass" | "ssa") || !lower.starts_with(&stem) {
            continue;
        }
        // "Movie.en.forced.srt" -> "en.forced"
        let middle = lower[stem.len()..lower.len() - ext.len() - 1].trim_matches('.').to_string();
        let lang = middle.split('.').next().unwrap_or("").to_string();
        out.push(SubtitleTrack {
            id: format!("ext:{}", out.len()),
            index: None,
            external: Some(p.to_string_lossy().to_string()),
            codec: ext.clone(),
            language: lang,
            title: if middle.is_empty() { name.clone() } else { format!("{middle} ({ext})") },
            text: true,
            default: false,
            forced: middle.contains("forced"),
        });
    }
    out.sort_by(|a, b| a.title.cmp(&b.title));
    out
}

/// Probe results by (path, size, modified): reopening a movie skips ffprobe entirely.
fn probe_cache() -> &'static Mutex<Vec<((PathBuf, u64, std::time::SystemTime), MediaInfo)>> {
    static C: OnceLock<Mutex<Vec<((PathBuf, u64, std::time::SystemTime), MediaInfo)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn probe(path: &Path) -> Result<MediaInfo, String> {
    let key = std::fs::metadata(path).ok().and_then(|m| Some((path.to_path_buf(), m.len(), m.modified().ok()?)));
    if let Some(k) = &key {
        if let Some((_, hit)) = probe_cache().lock().unwrap().iter().find(|(kk, _)| kk == k) {
            let mut info = hit.clone();
            info.encoder = ENCODER.get().cloned().unwrap_or_default();
            return Ok(info);
        }
    }
    let info = probe_uncached(path)?;
    if let Some(k) = key {
        let mut c = probe_cache().lock().unwrap();
        c.retain(|(kk, _)| kk.0 != k.0);
        c.push((k, info.clone()));
        if c.len() > 64 {
            c.remove(0);
        }
    }
    Ok(info)
}

fn probe_uncached(path: &Path) -> Result<MediaInfo, String> {
    let out = tool("ffprobe")?
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let j: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let format = &j["format"];
    let duration = format["duration"].as_str().and_then(|d| d.parse().ok()).unwrap_or(0.0);
    let container = s(format, "format_name");

    let mut video = None;
    let mut audio = Vec::new();
    let mut subtitles = Vec::new();
    for st in j["streams"].as_array().into_iter().flatten() {
        let index = st["index"].as_u64().unwrap_or(0) as usize;
        match st["codec_type"].as_str() {
            Some("video") if video.is_none() && !disp(st, "attached_pic") => {
                let fps = s(st, "avg_frame_rate")
                    .split_once('/')
                    .and_then(|(n, d)| Some(n.parse::<f64>().ok()? / d.parse::<f64>().ok().filter(|d| *d > 0.0)?))
                    .unwrap_or(0.0);
                video = Some(VideoStream {
                    codec: s(st, "codec_name"),
                    profile: s(st, "profile"),
                    pix_fmt: s(st, "pix_fmt"),
                    width: st["width"].as_u64().unwrap_or(0) as u32,
                    height: st["height"].as_u64().unwrap_or(0) as u32,
                    fps,
                });
            }
            Some("audio") => audio.push(AudioTrack {
                index,
                codec: s(st, "codec_name"),
                channels: st["channels"].as_u64().unwrap_or(0) as u32,
                language: tag(st, "language"),
                title: tag(st, "title"),
                default: disp(st, "default"),
            }),
            Some("subtitle") => {
                let codec = s(st, "codec_name");
                subtitles.push(SubtitleTrack {
                    id: format!("s:{index}"),
                    index: Some(index),
                    external: None,
                    text: TEXT_SUBS.contains(&codec.as_str()),
                    codec,
                    language: tag(st, "language"),
                    title: tag(st, "title"),
                    default: disp(st, "default"),
                    forced: disp(st, "forced"),
                });
            }
            _ => {}
        }
    }
    subtitles.extend(external_subtitles(path));

    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let first_audio_ok = audio.first().map_or(true, |a| WEB_AUDIO.contains(&a.codec.as_str()));
    let direct_play = match &video {
        Some(v) => matches!(ext.as_str(), "mp4" | "m4v" | "webm" | "mov") && WEB_VIDEO.contains(&v.codec.as_str()) && first_audio_ok,
        None => matches!(ext.as_str(), "mp3" | "m4a" | "aac" | "wav" | "flac" | "ogg" | "oga" | "opus" | "weba" | "webm") && first_audio_ok,
    };
    Ok(MediaInfo { duration, container, video, audio, subtitles, direct_play, encoder: ENCODER.get().cloned().unwrap_or_default() })
}

// ---------- subtitles ----------

pub fn subtitle_vtt(path: &Path, stream: Option<usize>, external: Option<&Path>) -> Result<String, String> {
    let run = |charenc: Option<&str>| -> Result<String, String> {
        let mut c = tool("ffmpeg")?;
        c.args(["-hide_banner", "-v", "error"]);
        if let Some(enc) = charenc {
            c.args(["-sub_charenc", enc]);
        }
        match (external, stream) {
            (Some(ext), _) => { c.arg("-i").arg(ext); }
            (None, Some(idx)) => { c.arg("-i").arg(path).args(["-map", &format!("0:{idx}")]); }
            _ => return Err("No subtitle selected".into()),
        }
        let out = c.args(["-f", "webvtt", "-"]).output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    };
    // External subtitle files are often saved in a legacy Windows code page rather than UTF-8.
    run(None).or_else(|e| if external.is_some() { run(Some("CP1252")) } else { Err(e) })
}

// ---------- hardware encoder ----------

/// Fastest H.264 encoder that actually works on this PC (GPU first, software last).
pub fn encoder() -> &'static str {
    ENCODER.get_or_init(|| {
        for enc in ["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", "libopenh264"] {
            let ok = tool("ffmpeg")
                .and_then(|mut c| {
                    c.args(["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=256x256:r=25:d=0.2", "-frames:v", "5", "-c:v", enc, "-f", "null", "-"])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .map_err(|e| e.to_string())
                })
                .map(|st| st.success())
                .unwrap_or(false);
            if ok {
                return enc.to_string();
            }
        }
        "libopenh264".to_string()
    })
}

fn encoder_args(enc: &str) -> Vec<&'static str> {
    match enc {
        "h264_nvenc" => vec!["-preset", "p2", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-maxrate", "20M", "-bufsize", "40M", "-pix_fmt", "yuv420p"],
        "h264_qsv" => vec!["-global_quality", "23", "-look_ahead", "0", "-pix_fmt", "nv12"],
        "h264_amf" => vec!["-quality", "speed", "-rc", "cqp", "-qp_i", "21", "-qp_p", "23", "-pix_fmt", "nv12"],
        "h264_mf" => vec!["-b:v", "10M", "-pix_fmt", "nv12"],
        _ => vec!["-b:v", "6M", "-pix_fmt", "yuv420p"],
    }
}

// ---------- playback sessions (no network) ----------
//
// FFmpeg writes fragmented MP4 into a pipe; a reader thread moves it into a small bounded buffer
// and the player pulls it over the app's own IPC (`media_read`) into a MediaSource. Nothing listens
// on a port, so no other program or web page can reach the stream. The bounded buffer gives
// natural back-pressure: when the player has enough buffered, FFmpeg simply waits.

const BUFFER_CAP: usize = 16 * 1024 * 1024;
const READ_MAX: usize = 4 * 1024 * 1024;
const MAX_SESSIONS: usize = 4;

#[derive(Default)]
struct Pipe {
    /// Whole reads from FFmpeg, moved with memcpy (never byte by byte).
    data: std::collections::VecDeque<Vec<u8>>,
    len: usize,
    eof: bool,
    closed: bool,
    error: Option<String>,
}

struct Session {
    pipe: Arc<(Mutex<Pipe>, Condvar)>,
    child: Arc<Mutex<Child>>,
    /// Text subtitle tracks written alongside the stream: (stream index, WebVTT file).
    subs: Vec<(usize, PathBuf)>,
}

impl Session {
    fn stop(&self) {
        {
            let (m, cv) = &*self.pipe;
            let mut p = m.lock().unwrap();
            p.closed = true;
            cv.notify_all();
        }
        let mut c = self.child.lock().unwrap();
        let _ = c.kill();
        let _ = c.wait();
        for (_, f) in &self.subs {
            let _ = std::fs::remove_file(f);
        }
    }
}

fn sessions() -> &'static Mutex<(u64, Vec<(u64, Session)>)> {
    static S: OnceLock<Mutex<(u64, Vec<(u64, Session)>)>> = OnceLock::new();
    S.get_or_init(|| Mutex::new((0, Vec::new())))
}

fn ffmpeg_stream_command(file: &Path, audio: Option<usize>, start: f64, mode: &str, hevc: bool, subs: &[(usize, PathBuf)]) -> Result<Command, String> {
    let mut c = tool("ffmpeg")?;
    c.args(["-hide_banner", "-v", "error", "-nostdin"]);
    // Faster start: container headers already describe the streams, so FFmpeg doesn't need to
    // analyse 5 s of data first.
    c.args(["-analyzeduration", "1500000", "-probesize", "4000000"]);
    // No `-hwaccel auto` for conversion: copying GPU-decoded frames back for scaling measured
    // slower than real time on 4K/60 10-bit HEVC (0.93x), CPU decoding runs at 2-3x.
    if start > 0.0 {
        c.args(["-ss", &format!("{start:.3}")]);
    }
    c.arg("-i").arg(file);
    let amap = audio.map(|a| format!("0:{a}")).unwrap_or_else(|| "0:a:0?".into());
    match mode {
        "audio" => {
            c.args(["-vn", "-map", &amap, "-c:a", "aac", "-b:a", "256k"]);
        }
        "encode" => {
            let enc = encoder();
            c.args(["-map", "0:v:0", "-map", &amap, "-vf", "scale='min(1920,iw)':-2:flags=bilinear,format=yuv420p", "-c:v", enc]);
            c.args(encoder_args(enc));
            c.args(["-g", "50", "-c:a", "aac", "-ac", "2", "-b:a", "192k"]);
        }
        _ => {
            c.args(["-map", "0:v:0", "-map", &amap, "-c:v", "copy", "-c:a", "aac", "-ac", "2", "-b:a", "192k"]);
            if hevc {
                c.args(["-tag:v", "hvc1"]); // the sample-entry name MediaSource expects for HEVC
            }
        }
    }
    // Short fragments so playback starts quickly even when keyframes are far apart.
    // The MP4 muxer restarts every track at 0, so the stream begins exactly at `start` (a keyframe
    // for codec copy, see `open`) and the player adds that offset; subtitles share the same clock.
    c.args(["-sn", "-dn", "-avoid_negative_ts", "make_zero", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "1000000", "-f", "mp4", "pipe:1"]);
    // Every text subtitle track is written as WebVTT while the stream is produced: reading a
    // subtitle track on its own means reading the whole movie (minutes for a large file on a
    // hard drive); here it costs nothing extra and arrives just ahead of playback.
    for (idx, out) in subs {
        c.args(["-map", &format!("0:{idx}"), "-vn", "-an", "-dn", "-c:s", "webvtt", "-flush_packets", "1", "-f", "webvtt"]).arg(out);
    }
    c.stdout(Stdio::piped()).stderr(Stdio::piped());
    Ok(c)
}

#[derive(Serialize)]
pub struct StreamInfo {
    pub id: u64,
    /// Movie time at which the stream (and its subtitle cues) start: add it to the element's
    /// currentTime and to cue times.
    pub offset: f64,
}

/// Start of the keyframe at or before `t`. A codec-copy stream can only begin on a keyframe, and
/// starting exactly there keeps audio, video, the clock and subtitles aligned. (~0.1 s: ffprobe
/// reads one packet; the disk seek it does also warms the cache for FFmpeg.)
fn keyframe_at_or_before(path: &Path, t: f64) -> f64 {
    let out = tool("ffprobe").and_then(|mut c| {
        c.args(["-v", "error", "-select_streams", "v:0", "-read_intervals", &format!("{t:.3}%+#1"), "-show_entries", "packet=pts_time", "-of", "csv=p=0"])
            .arg(path)
            .output()
            .map_err(|e| e.to_string())
    });
    out.ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).lines().next().and_then(|l| l.trim().trim_end_matches(',').parse().ok()))
        .filter(|k: &f64| *k <= t + 0.5 && *k >= 0.0)
        .unwrap_or(t)
}

/// Starts FFmpeg for `path` and returns a session id the player reads from with [`read`].
pub fn open(path: &Path, audio: Option<usize>, start: f64, mode: &str, hevc: bool, subs: &[usize]) -> Result<StreamInfo, String> {
    if !path.is_file() {
        return Err("File not found".into());
    }
    let mode = if matches!(mode, "copy" | "encode" | "audio") { mode } else { "copy" };
    let id = {
        let mut g = sessions().lock().unwrap();
        g.0 += 1;
        g.0
    };
    let sub_dir = std::env::temp_dir().join("pifiles-subs");
    let sub_files: Vec<(usize, PathBuf)> = if mode == "audio" || subs.is_empty() {
        Vec::new()
    } else {
        let _ = std::fs::create_dir_all(&sub_dir);
        subs.iter().take(16).map(|&i| (i, sub_dir.join(format!("{}-{id}-{i}.vtt", std::process::id())))).collect()
    };
    // Conversion and audio-only streams start exactly at `start`; codec copy on the keyframe.
    let offset = if mode == "copy" && start > 0.0 { keyframe_at_or_before(path, start) } else { start.max(0.0) };
    let mut child = ffmpeg_stream_command(path, audio, offset, mode, hevc && mode == "copy", &sub_files)?
        .spawn()
        .map_err(|e| format!("Couldn't start FFmpeg: {e}"))?;
    let mut out = child.stdout.take().ok_or("FFmpeg has no output")?;
    let err = child.stderr.take();
    let pipe: Arc<(Mutex<Pipe>, Condvar)> = Arc::default();

    // stdout -> bounded buffer
    let p2 = pipe.clone();
    std::thread::Builder::new()
        .name("media-read".into())
        .spawn(move || {
            let mut buf = vec![0u8; 256 * 1024];
            loop {
                let n = out.read(&mut buf).unwrap_or_default(); // an error ends the stream like EOF
                let (m, cv) = &*p2;
                let mut p = m.lock().unwrap();
                if n == 0 {
                    p.eof = true;
                    cv.notify_all();
                    return;
                }
                while p.len >= BUFFER_CAP && !p.closed {
                    p = cv.wait(p).unwrap();
                }
                if p.closed {
                    return;
                }
                p.data.push_back(buf[..n].to_vec());
                p.len += n;
                cv.notify_all();
            }
        })
        .map_err(|e| e.to_string())?;
    // stderr -> last error line (shown if the stream fails)
    if let Some(mut e) = err {
        let p3 = pipe.clone();
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = e.read_to_string(&mut s);
            if let Some(line) = s.lines().map(str::trim).filter(|l| !l.is_empty()).last() {
                eprintln!("[media] ffmpeg: {line}");
                p3.0.lock().unwrap().error = Some(line.to_string());
            }
        });
    }

    let mut g = sessions().lock().unwrap();
    g.1.push((id, Session { pipe, child: Arc::new(Mutex::new(child)), subs: sub_files }));
    // A viewer only ever needs one or two live sessions; stop forgotten ones.
    while g.1.len() > MAX_SESSIONS {
        let (_, old) = g.1.remove(0);
        old.stop();
    }
    Ok(StreamInfo { id, offset })
}

#[derive(Serialize)]
pub struct SubsChunk {
    /// Complete WebVTT cues written since `from`.
    pub text: String,
    /// Where to continue reading next time.
    pub next: u64,
    /// FFmpeg has finished (no more cues will come from this session).
    pub done: bool,
}

/// New subtitle cues for one track of a playback session (written by the stream's FFmpeg).
pub fn subs_read(id: u64, stream: usize, from: u64) -> Result<SubsChunk, String> {
    let (file, child) = {
        let g = sessions().lock().unwrap();
        let s = g.1.iter().find(|(i, _)| *i == id).map(|(_, s)| s).ok_or("This stream was closed")?;
        (s.subs.iter().find(|(i, _)| *i == stream).map(|(_, f)| f.clone()).ok_or("This subtitle track isn't part of the stream")?, s.child.clone())
    };
    let done = matches!(child.lock().unwrap().try_wait(), Ok(Some(_)));
    let bytes = std::fs::read(&file).unwrap_or_default();
    let from = (from as usize).min(bytes.len());
    let rest = &bytes[from..];
    // Only whole cues (each ends with a blank line), unless FFmpeg has finished writing.
    let take = if done {
        rest.len()
    } else {
        rest.windows(2).rposition(|w| w == b"\n\n").map(|p| p + 2).unwrap_or(0)
    };
    Ok(SubsChunk { text: String::from_utf8_lossy(&rest[..take]).into_owned(), next: (from + take) as u64, done })
}

/// Next chunk of the stream (waits until data is available). An empty result means the stream
/// ended normally; an error means FFmpeg failed or the session is gone.
pub fn read(id: u64) -> Result<Vec<u8>, String> {
    let (pipe, child) = {
        let g = sessions().lock().unwrap();
        g.1.iter().find(|(i, _)| *i == id).map(|(_, s)| (s.pipe.clone(), s.child.clone())).ok_or("This stream was closed")?
    };
    let (m, cv) = &*pipe;
    let mut p = m.lock().unwrap();
    while p.data.is_empty() && !p.eof && !p.closed {
        p = cv.wait(p).unwrap();
    }
    if p.closed {
        return Err("This stream was closed".into());
    }
    if p.data.is_empty() {
        // End of output: a clean exit ends the stream, anything else is reported with FFmpeg's
        // last message (warnings on a successful run are ignored).
        drop(p);
        let ok = child.lock().unwrap().wait().map(|st| st.success()).unwrap_or(false);
        if ok {
            return Ok(Vec::new());
        }
        std::thread::sleep(std::time::Duration::from_millis(50)); // let the stderr reader finish
        let e = m.lock().unwrap().error.clone().unwrap_or_else(|| "conversion stopped".into());
        return Err(format!("FFmpeg: {e}"));
    }
    let mut chunk: Vec<u8> = Vec::with_capacity(p.len.min(READ_MAX));
    while let Some(front) = p.data.front() {
        if !chunk.is_empty() && chunk.len() + front.len() > READ_MAX {
            break;
        }
        let part = p.data.pop_front().unwrap();
        p.len -= part.len();
        chunk.extend_from_slice(&part);
    }
    cv.notify_all();
    Ok(chunk)
}

/// Stops FFmpeg for a session (seek, track switch, viewer closed).
pub fn close(id: u64) {
    let s = {
        let mut g = sessions().lock().unwrap();
        g.1.iter().position(|(i, _)| *i == id).map(|k| g.1.remove(k).1)
    };
    if let Some(s) = s {
        s.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a small MKV with H.264 video, two AC-3 audio tracks (eng/jpn) and an embedded SRT track.
    fn sample_mkv() -> Option<PathBuf> {
        if !available() {
            eprintln!("FFmpeg not present - skipping");
            return None;
        }
        let dir = std::env::temp_dir().join("pifiles-media-test");
        std::fs::create_dir_all(&dir).unwrap();
        let srt = dir.join("subs.srt");
        std::fs::write(&srt, "1\n00:00:01,000 --> 00:00:02,500\nHello subtitles\n").unwrap();
        let out = dir.join("movie.mkv");
        let st = tool("ffmpeg")
            .unwrap()
            .args([
                "-y", "-v", "error",
                "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=4",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
                "-f", "lavfi", "-i", "sine=frequency=880:duration=4",
            ])
            .arg("-i")
            .arg(&srt)
            .args([
                "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s",
                "-c:v", encoder(), "-g", "25", "-c:a", "ac3", "-c:s", "srt",
                "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=jpn", "-metadata:s:s:0", "language=eng",
            ])
            .arg(&out)
            .status()
            .unwrap();
        assert!(st.success(), "sample creation failed");
        Some(out)
    }

    fn read_all(id: u64) -> Vec<u8> {
        let mut all = Vec::new();
        loop {
            let c = read(id).unwrap();
            if c.is_empty() {
                return all;
            }
            all.extend(c);
        }
    }

    #[test]
    fn probe_subtitles_and_streams() {
        let Some(mkv) = sample_mkv() else { return };
        let info = probe(&mkv).unwrap();
        assert!(!info.direct_play, "MKV with AC-3 needs the stream path");
        assert_eq!(info.video.as_ref().unwrap().codec, "h264");
        assert_eq!(info.audio.len(), 2);
        assert_eq!(info.audio[1].language, "jpn");
        let sub = info.subtitles.iter().find(|s| s.index.is_some()).expect("embedded subtitle");
        assert!(sub.text);

        let vtt = subtitle_vtt(&mkv, sub.index, None).unwrap();
        assert!(vtt.starts_with("WEBVTT") && vtt.contains("Hello subtitles"), "{vtt}");

        // Remux with the second audio track, then a transcode: both must produce fragmented MP4.
        for (mode, audio) in [("copy", Some(info.audio[1].index)), ("encode", None), ("audio", None)] {
            let s = open(&mkv, audio, 1.0, mode, false, &[]).unwrap();
            assert!(s.offset <= 1.0 + 1e-6, "{mode}: offset {}", s.offset);
            let body = read_all(s.id);
            assert!(body.len() > 1000, "{mode}: only {} bytes", body.len());
            assert_eq!(&body[4..8], b"ftyp", "{mode}: no MP4 header");
            assert!(body.windows(4).any(|w| w == b"moof"), "{mode}: not fragmented");
            close(s.id);
        }
        eprintln!("encoder in use: {}", encoder());
    }

    /// Subtitles come out of the same FFmpeg run as the video, with the movie's own timestamps.
    #[test]
    fn live_subtitles_from_the_stream() {
        let Some(mkv) = sample_mkv() else { return };
        let info = probe(&mkv).unwrap();
        let sub = info.subtitles.iter().find(|s| s.index.is_some()).unwrap().index.unwrap();
        let s = open(&mkv, None, 0.0, "copy", false, &[sub]).unwrap();
        let _ = read_all(s.id); // drain the video so FFmpeg runs to the end
        let mut text = String::new();
        let mut from = 0;
        for _ in 0..50 {
            let c = subs_read(s.id, sub, from).unwrap();
            text.push_str(&c.text);
            from = c.next;
            if c.done && c.text.is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(text.contains("Hello subtitles"), "{text:?}");
        assert!(text.contains("00:00:01.000 -->") || text.contains("00:01.000 -->"), "cue times relative to the stream start: {text:?}");
        close(s.id);
    }

    #[test]
    fn closed_sessions_stop() {
        let Some(mkv) = sample_mkv() else { return };
        let s = open(&mkv, None, 0.0, "encode", false, &[]).unwrap();
        close(s.id);
        assert!(read(s.id).is_err(), "a closed stream must not be readable");
        assert!(read(987_654_321).is_err(), "unknown ids are refused");
    }

    /// Real movie, seek + live subtitles: PF_VIDEO=path cargo test --lib seek_real_file -- --ignored --nocapture
    #[test]
    #[ignore]
    fn seek_real_file() {
        let path = std::env::var("PF_VIDEO").unwrap();
        let t = std::time::Instant::now();
        let info = probe(Path::new(&path)).unwrap();
        println!("probe {:?}", t.elapsed());
        let t = std::time::Instant::now();
        let _ = probe(Path::new(&path)).unwrap();
        println!("probe again (cached) {:?}", t.elapsed());
        let subs: Vec<usize> = info.subtitles.iter().filter(|s| s.text).filter_map(|s| s.index).collect();
        println!("text subtitle tracks: {subs:?}");
        let hevc = info.video.as_ref().map_or(false, |v| v.codec == "hevc");
        let t = std::time::Instant::now();
        let s = open(Path::new(&path), None, 600.0, "copy", hevc, &subs).unwrap();
        println!("open at 600 s {:?} (stream starts at {:.3} s)", t.elapsed(), s.offset);
        let c = read(s.id).unwrap();
        println!("first video bytes {:?} ({} bytes)", t.elapsed(), c.len());
        let mut got = 0;
        let mut from = 0;
        while t.elapsed().as_secs() < 20 {
            let _ = read(s.id);
            if let Some(&first) = subs.first() {
                let ch = subs_read(s.id, first, from).unwrap();
                from = ch.next;
                got += ch.text.matches("-->").count();
                if got > 0 {
                    println!("first subtitle cues after {:?}: {}", t.elapsed(), ch.text.lines().find(|l| l.contains("-->")).unwrap_or(""));
                    break;
                }
            } else {
                break;
            }
        }
        close(s.id);
    }

    /// Real movie: PF_VIDEO=path cargo test --lib stream_real_file -- --ignored --nocapture
    #[test]
    #[ignore]
    fn stream_real_file() {
        let path = std::env::var("PF_VIDEO").unwrap();
        let info = probe(Path::new(&path)).unwrap();
        let hevc = info.video.as_ref().map_or(false, |v| v.codec == "hevc");
        println!("video {:?}", info.video.as_ref().map(|v| (&v.codec, &v.profile, &v.pix_fmt, v.width, v.height)));
        for mode in ["copy", "encode"] {
            let t = std::time::Instant::now();
            let s = open(Path::new(&path), None, 0.0, mode, hevc, &[]).unwrap();
            let mut total = 0;
            let mut first = None;
            while total < 64 * 1024 * 1024 && t.elapsed().as_secs() < 30 {
                let c = read(s.id).unwrap();
                if c.is_empty() {
                    break;
                }
                first.get_or_insert(t.elapsed());
                total += c.len();
            }
            println!("{mode}: first bytes after {first:?}, {total} bytes in {:?} = {:.1} MB/s", t.elapsed(), total as f64 / 1048576.0 / t.elapsed().as_secs_f64());
            close(s.id);
        }
    }
}
