//! Document previews: Word (.docx/.docm/.dotx), OpenDocument text (.odt), PowerPoint
//! (.pptx/.ppsx), OpenDocument presentation (.odp) and RTF are converted to simple, safe HTML
//! for the viewer. All text is HTML-escaped here and only a fixed set of tags is produced (no
//! scripts, no external links or images - embedded pictures become data: URLs), and the page
//! shows the result in a sandboxed frame.

use base64::Engine;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

const MAX_XML: u64 = 64 * 1024 * 1024;
const MAX_IMAGES_BYTES: usize = 40 * 1024 * 1024;

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            _ => o.push(c),
        }
    }
    o
}

struct Zip {
    z: zip::ZipArchive<std::fs::File>,
}
impl Zip {
    fn open(p: &Path) -> Result<Self, String> {
        let f = std::fs::File::open(p).map_err(|e| e.to_string())?;
        Ok(Zip { z: zip::ZipArchive::new(f).map_err(|_| "This file is damaged or not a document".to_string())? })
    }
    fn text(&mut self, name: &str) -> Option<String> {
        let mut e = self.z.by_name(name).ok()?;
        if e.size() > MAX_XML {
            return None;
        }
        let mut s = String::new();
        e.read_to_string(&mut s).ok()?;
        Some(s)
    }
    fn bytes(&mut self, name: &str) -> Option<Vec<u8>> {
        let mut e = self.z.by_name(name).ok()?;
        if e.size() > MAX_IMAGES_BYTES as u64 {
            return None;
        }
        let mut v = Vec::new();
        e.read_to_end(&mut v).ok()?;
        Some(v)
    }
    fn names(&self) -> Vec<String> {
        self.z.file_names().map(String::from).collect()
    }
}

/// Relationship id -> target path (resolved against `base_dir`) from a .rels part.
fn rels(z: &mut Zip, rels_path: &str, base_dir: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    let Some(x) = z.text(rels_path) else { return m };
    let Ok(doc) = roxmltree::Document::parse(&x) else { return m };
    for r in doc.descendants().filter(|n| n.has_tag_name("Relationship")) {
        if let (Some(id), Some(t)) = (r.attribute("Id"), r.attribute("Target")) {
            if r.attribute("TargetMode") == Some("External") {
                continue;
            }
            let mut parts: Vec<&str> = base_dir.split('/').filter(|s| !s.is_empty()).collect();
            for seg in t.trim_start_matches('/').split('/') {
                if seg == ".." {
                    parts.pop();
                } else if !seg.is_empty() && seg != "." {
                    parts.push(seg);
                }
            }
            m.insert(id.to_string(), if t.starts_with('/') { t.trim_start_matches('/').to_string() } else { parts.join("/") });
        }
    }
    m
}

fn image_data_url(z: &mut Zip, path: &str, budget: &mut usize) -> Option<String> {
    let mime = match Path::new(path).extension()?.to_string_lossy().to_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "svg" => return None, // could carry script; skipped
        _ => return None,
    };
    let b = z.bytes(path)?;
    if b.len() > *budget {
        return None;
    }
    *budget -= b.len();
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(b)))
}

// ------------------------------------------------------------------ Word (.docx)
fn docx(p: &Path) -> Result<String, String> {
    let mut z = Zip::open(p)?;
    let xml = z.text("word/document.xml").ok_or("This doesn't look like a Word document")?;
    let rel = rels(&mut z, "word/_rels/document.xml.rels", "word");
    let doc = roxmltree::Document::parse(&xml).map_err(|e| format!("Couldn't read the document: {e}"))?;
    let body = doc.descendants().find(|n| n.has_tag_name("body")).ok_or("Empty document")?;
    let mut out = String::new();
    let mut budget = MAX_IMAGES_BYTES;
    let mut in_list = false;
    for block in body.children().filter(|n| n.is_element()) {
        match block.tag_name().name() {
            "p" => {
                let (html, tag, list) = docx_para(&mut z, &rel, block, &mut budget);
                if list && !in_list {
                    out.push_str("<ul>");
                    in_list = true;
                } else if !list && in_list {
                    out.push_str("</ul>");
                    in_list = false;
                }
                if list {
                    out.push_str(&format!("<li>{html}</li>"));
                } else if html.trim().is_empty() {
                    out.push_str("<p class=\"gap\"></p>");
                } else {
                    out.push_str(&format!("<{tag}>{html}</{tag}>"));
                }
            }
            "tbl" => {
                if in_list {
                    out.push_str("</ul>");
                    in_list = false;
                }
                out.push_str("<table>");
                for tr in block.children().filter(|n| n.has_tag_name("tr")) {
                    out.push_str("<tr>");
                    for tc in tr.children().filter(|n| n.has_tag_name("tc")) {
                        let cell: Vec<String> = tc.children().filter(|n| n.has_tag_name("p")).map(|pp| docx_para(&mut z, &rel, pp, &mut budget).0).collect();
                        out.push_str(&format!("<td>{}</td>", cell.join("<br>")));
                    }
                    out.push_str("</tr>");
                }
                out.push_str("</table>");
            }
            _ => {}
        }
    }
    if in_list {
        out.push_str("</ul>");
    }
    Ok(out)
}

fn docx_para(z: &mut Zip, rel: &HashMap<String, String>, p: roxmltree::Node, budget: &mut usize) -> (String, &'static str, bool) {
    let ppr = p.children().find(|n| n.has_tag_name("pPr"));
    let style = ppr.and_then(|n| n.children().find(|c| c.has_tag_name("pStyle"))).and_then(|s| s.attributes().find(|a| a.name() == "val").map(|a| a.value().to_lowercase())).unwrap_or_default();
    let list = ppr.map(|n| n.children().any(|c| c.has_tag_name("numPr"))).unwrap_or(false) || style.contains("list");
    let tag = match style.as_str() {
        "title" => "h1",
        s if s.starts_with("heading1") || s == "heading 1" => "h1",
        s if s.starts_with("heading2") => "h2",
        s if s.starts_with("heading3") => "h3",
        s if s.starts_with("heading") => "h4",
        "subtitle" => "h3",
        "quote" | "intensequote" => "blockquote",
        _ => "p",
    };
    let align = ppr.and_then(|n| n.children().find(|c| c.has_tag_name("jc"))).and_then(|j| j.attributes().find(|a| a.name() == "val").map(|a| a.value().to_string()));
    let mut html = String::new();
    for r in p.descendants().filter(|n| n.has_tag_name("r")) {
        let rpr = r.children().find(|n| n.has_tag_name("rPr"));
        let on = |name: &str| rpr.and_then(|x| x.children().find(|c| c.has_tag_name(name))).map(|c| c.attributes().find(|a| a.name() == "val").map(|a| a.value() != "0" && a.value() != "false").unwrap_or(true)).unwrap_or(false);
        let mut seg = String::new();
        for c in r.children() {
            match c.tag_name().name() {
                "t" => seg.push_str(&esc(c.text().unwrap_or(""))),
                "tab" => seg.push_str("&emsp;"),
                "br" | "cr" => seg.push_str("<br>"),
                "drawing" | "pict" => {
                    if let Some(id) = c.descendants().find(|n| n.has_tag_name("blip") || n.has_tag_name("imagedata")).and_then(|b| b.attributes().find(|a| a.name() == "embed" || a.name() == "id").map(|a| a.value().to_string())) {
                        if let Some(target) = rel.get(&id) {
                            if let Some(url) = image_data_url(z, target, budget) {
                                seg.push_str(&format!("<img src=\"{url}\" alt=\"\">"));
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        if seg.is_empty() {
            continue;
        }
        if on("b") {
            seg = format!("<b>{seg}</b>");
        }
        if on("i") {
            seg = format!("<i>{seg}</i>");
        }
        if on("u") {
            seg = format!("<u>{seg}</u>");
        }
        if on("strike") {
            seg = format!("<s>{seg}</s>");
        }
        html.push_str(&seg);
    }
    if let Some(a) = align.filter(|a| matches!(a.as_str(), "center" | "right" | "both")) {
        html = format!("<span class=\"al-{a}\">{html}</span>");
    }
    (html, tag, list)
}

// ------------------------------------------------------------------ OpenDocument (.odt/.odp)
fn odf(p: &Path) -> Result<String, String> {
    let mut z = Zip::open(p)?;
    let xml = z.text("content.xml").ok_or("This doesn't look like an OpenDocument file")?;
    let doc = roxmltree::Document::parse(&xml).map_err(|e| format!("Couldn't read the document: {e}"))?;
    let mut budget = MAX_IMAGES_BYTES;
    let mut out = String::new();
    fn text_of(n: roxmltree::Node) -> String {
        let mut s = String::new();
        for d in n.descendants() {
            if d.is_text() {
                s.push_str(&esc(d.text().unwrap_or("")));
            } else if d.has_tag_name("tab") {
                s.push_str("&emsp;");
            } else if d.has_tag_name("line-break") {
                s.push_str("<br>");
            } else if d.has_tag_name("s") {
                s.push(' ');
            }
        }
        s
    }
    let office_body = doc.descendants().find(|n| n.has_tag_name("body")).ok_or("Empty document")?;
    for n in office_body.descendants().filter(|n| n.is_element()) {
        match n.tag_name().name() {
            "h" => {
                let lvl = n.attributes().find(|a| a.name() == "outline-level").and_then(|a| a.value().parse::<u8>().ok()).unwrap_or(1).clamp(1, 4);
                out.push_str(&format!("<h{lvl}>{}</h{lvl}>", text_of(n)));
            }
            "p" if !n.ancestors().skip(1).any(|a| a.has_tag_name("p") || a.has_tag_name("h") || a.has_tag_name("table-cell")) => {
                let t = text_of(n);
                if n.ancestors().any(|a| a.has_tag_name("list-item")) {
                    out.push_str(&format!("<ul><li>{t}</li></ul>"));
                } else if t.trim().is_empty() {
                    out.push_str("<p class=\"gap\"></p>");
                } else {
                    out.push_str(&format!("<p>{t}</p>"));
                }
            }
            "page" => out.push_str("<hr class=\"slide\">"), // presentation slide boundary
            "table" => {
                out.push_str("<table>");
                for row in n.descendants().filter(|r| r.has_tag_name("table-row")) {
                    out.push_str("<tr>");
                    for c in row.children().filter(|c| c.has_tag_name("table-cell")) {
                        out.push_str(&format!("<td>{}</td>", text_of(c)));
                    }
                    out.push_str("</tr>");
                }
                out.push_str("</table>");
            }
            "image" => {
                if let Some(h) = n.attributes().find(|a| a.name() == "href").map(|a| a.value().to_string()) {
                    if let Some(url) = image_data_url(&mut z, &h, &mut budget) {
                        out.push_str(&format!("<img src=\"{url}\" alt=\"\">"));
                    }
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------ PowerPoint (.pptx)
fn pptx(p: &Path) -> Result<String, String> {
    let mut z = Zip::open(p)?;
    let mut slides: Vec<(u32, String)> = z
        .names()
        .into_iter()
        .filter_map(|n| n.strip_prefix("ppt/slides/slide").and_then(|r| r.strip_suffix(".xml")).and_then(|num| num.parse().ok()).map(|k| (k, n.clone())))
        .collect();
    if slides.is_empty() {
        return Err("This doesn't look like a PowerPoint file".into());
    }
    slides.sort();
    let mut budget = MAX_IMAGES_BYTES;
    let mut out = String::new();
    for (k, name) in slides {
        let Some(xml) = z.text(&name) else { continue };
        let rel = rels(&mut z, &format!("ppt/slides/_rels/slide{k}.xml.rels"), "ppt/slides");
        let Ok(doc) = roxmltree::Document::parse(&xml) else { continue };
        out.push_str(&format!("<section class=\"slide\"><div class=\"slide-no\">Slide {k}</div>"));
        for n in doc.descendants().filter(|n| n.is_element()) {
            match n.tag_name().name() {
                "txBody" => {
                    for para in n.children().filter(|c| c.has_tag_name("p")) {
                        let t: String = para.descendants().filter(|d| d.has_tag_name("t")).map(|d| esc(d.text().unwrap_or(""))).collect();
                        if !t.trim().is_empty() {
                            let title = n.ancestors().any(|a| a.has_tag_name("sp") && a.descendants().any(|d| d.has_tag_name("ph") && d.attributes().any(|x| x.name() == "type" && (x.value() == "title" || x.value() == "ctrTitle"))));
                            out.push_str(&if title { format!("<h2>{t}</h2>") } else { format!("<p>{t}</p>") });
                        }
                    }
                }
                "blip" => {
                    if let Some(id) = n.attributes().find(|a| a.name() == "embed").map(|a| a.value().to_string()) {
                        if let Some(target) = rel.get(&id) {
                            if let Some(url) = image_data_url(&mut z, target, &mut budget) {
                                out.push_str(&format!("<img src=\"{url}\" alt=\"\">"));
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        out.push_str("</section>");
    }
    Ok(out)
}

// ------------------------------------------------------------------ RTF
fn rtf(p: &Path) -> Result<String, String> {
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("Too large to preview".into());
    }
    let s = String::from_utf8_lossy(&bytes);
    let c: Vec<char> = s.chars().collect();
    let (mut i, mut depth, mut skip_depth) = (0usize, 0i32, i32::MAX);
    let mut text = String::new();
    let mut uc_skip = 0usize;
    while i < c.len() {
        match c[i] {
            '{' => {
                depth += 1;
                i += 1;
                if c.get(i) == Some(&'\\') && c.get(i + 1) == Some(&'*') && skip_depth > depth {
                    skip_depth = depth;
                }
            }
            '}' => {
                if depth <= skip_depth {
                    skip_depth = i32::MAX;
                }
                depth -= 1;
                i += 1;
            }
            '\\' => {
                i += 1;
                let Some(&n) = c.get(i) else { break };
                if n == '\'' {
                    let hex: String = c.get(i + 1..i + 3).map(|h| h.iter().collect()).unwrap_or_default();
                    if depth < skip_depth {
                        if let Ok(b) = u8::from_str_radix(&hex, 16) {
                            text.push(if (0x80..0xA0).contains(&b) { ' ' } else { b as char });
                        }
                    }
                    i += 3;
                    continue;
                }
                if !n.is_ascii_alphabetic() {
                    if depth < skip_depth && matches!(n, '\\' | '{' | '}') {
                        text.push(n);
                    }
                    i += 1;
                    continue;
                }
                let start = i;
                while i < c.len() && c[i].is_ascii_alphabetic() {
                    i += 1;
                }
                let word: String = c[start..i].iter().collect();
                let ns = i;
                if i < c.len() && (c[i] == '-' || c[i].is_ascii_digit()) {
                    i += 1;
                    while i < c.len() && c[i].is_ascii_digit() {
                        i += 1;
                    }
                }
                let num: i32 = c[ns..i].iter().collect::<String>().parse().unwrap_or(0);
                if i < c.len() && c[i] == ' ' {
                    i += 1;
                }
                if matches!(word.as_str(), "fonttbl" | "colortbl" | "stylesheet" | "info" | "pict" | "header" | "footer" | "listtable" | "listoverridetable") && skip_depth > depth {
                    skip_depth = depth;
                }
                if depth >= skip_depth {
                    continue;
                }
                match word.as_str() {
                    "par" | "line" => text.push('\n'),
                    "tab" => text.push('\t'),
                    "uc" => uc_skip = num.max(0) as usize,
                    "u" => {
                        let cp = if num < 0 { num + 65536 } else { num } as u32;
                        if let Some(ch) = char::from_u32(cp) {
                            text.push(ch);
                        }
                        i += uc_skip.max(1).min(c.len() - i);
                    }
                    _ => {}
                }
            }
            '\r' | '\n' => i += 1,
            ch => {
                if depth < skip_depth {
                    text.push(ch);
                }
                i += 1;
            }
        }
    }
    Ok(text.split('\n').map(|l| if l.trim().is_empty() { "<p class=\"gap\"></p>".to_string() } else { format!("<p>{}</p>", esc(l)) }).collect())
}

/// HTML body for a document, or an error message for the viewer.
pub fn render(path: &str) -> Result<String, String> {
    let p = Path::new(path);
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "docx" | "docm" | "dotx" | "dotm" => docx(p),
        "odt" | "ott" | "odp" | "otp" => odf(p),
        "pptx" | "pptm" | "ppsx" | "potx" => pptx(p),
        "rtf" => rtf(p),
        "doc" | "ppt" | "xls" | "pps" => Err("Older Office files (.doc, .ppt) can't be previewed here - open them with your default app".into()),
        _ => Err("Unsupported document type".into()),
    }
}

#[cfg(test)]
mod tests {
    /// PF_DOCS=path;path cargo test --lib docs_real -- --ignored --nocapture
    #[test]
    #[ignore]
    fn docs_real() {
        for p in std::env::var("PF_DOCS").unwrap_or_default().split(';').filter(|s| !s.is_empty()) {
            let t = std::time::Instant::now();
            match super::render(p) {
                Ok(h) => println!("{p}: {:?} {} chars, starts {:?}", t.elapsed(), h.len(), &h.chars().take(160).collect::<String>()),
                Err(e) => println!("{p}: ERR {e}"),
            }
        }
    }

    #[test]
    fn rtf_basic_and_escaping() {
        let dir = std::env::temp_dir().join("pifiles-docs-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.rtf");
        std::fs::write(&p, r"{\rtf1\ansi{\fonttbl{\f0 Arial;}}\f0 Hello \b <World>\b0\par Second line\par}").unwrap();
        let h = super::rtf(&p).unwrap();
        assert!(h.contains("Hello"), "{h}");
        assert!(h.contains("&lt;World&gt;"), "text is escaped: {h}");
        assert!(!h.contains("Arial"), "font table skipped: {h}");
        assert!(h.contains("Second line"));
    }
}
