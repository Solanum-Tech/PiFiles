//! Guards for the two operations that can't be undone or that run other programs.
//! Both are confirmed in a native OS dialog, which page script cannot click or forge:
//!  - custom actions: each (program, argument template) pair is approved once, then remembered;
//!  - permanent deletes (bypassing the Recycle Bin) are confirmed every time.
//! Placeholders ({path} {dir} {name} {paths}) are expanded here, not in the page, and shells get
//! the values through environment variables so a file name can never become shell code.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

fn approvals_file() -> std::path::PathBuf {
    crate::app_data_dir().join("approved_actions.json")
}

fn action_key(program: &str, template: &str) -> String {
    use sha2::{Digest, Sha256};
    let h = Sha256::digest(format!("{}\0{}", program.trim().to_lowercase(), template.trim()).as_bytes());
    h.iter().map(|b| format!("{b:02x}")).collect()
}

fn load_approvals() -> HashSet<String> {
    // Encrypted + integrity-checked: an edited approvals file is rejected, not trusted.
    crate::vault::read(&approvals_file()).and_then(|s| serde_json::from_slice(&s).ok()).unwrap_or_default()
}

fn native_confirm(window: &tauri::WebviewWindow, title: &str, message: &str, ok: &str) -> bool {
    window
        .dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .parent(window)
        .buttons(MessageDialogButtons::OkCancelCustom(ok.into(), "Cancel".into()))
        .blocking_show()
}

/// Same tokenising as the settings UI: whitespace separates, quotes group (and are removed).
fn split_args(s: &str) -> Vec<String> {
    let (mut out, mut cur, mut q) = (Vec::new(), String::new(), None::<char>);
    for ch in s.chars() {
        match q {
            Some(c) if ch == c => q = None,
            Some(_) => cur.push(ch),
            None if ch == '"' || ch == '\'' => q = Some(ch),
            None if ch.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            None => cur.push(ch),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

pub struct ActionRequest {
    pub program: String,
    pub template: String,
    pub paths: Vec<String>,
    pub dir: String,
}

pub fn run_custom_action(window: &tauri::WebviewWindow, req: ActionRequest) -> Result<(), String> {
    let program = req.program.trim();
    if program.is_empty() {
        return Err("This action has no program".into());
    }
    let key = action_key(program, &req.template);
    let mut approved = load_approvals();
    if !approved.contains(&key) {
        let msg = format!(
            "Allow PiFiles to run this custom action?\n\nProgram: {program}\nArguments: {}\n\nOnly allow actions you added yourself in Settings. PiFiles remembers your answer for this exact program and arguments.",
            if req.template.trim().is_empty() { "(none)" } else { req.template.trim() }
        );
        if !native_confirm(window, "Run custom action", &msg, "Allow") {
            return Err("Not allowed".into());
        }
        approved.insert(key);
        let _ = std::fs::create_dir_all(crate::app_data_dir());
        let _ = crate::vault::write(&approvals_file(), &serde_json::to_vec(&approved).unwrap_or_default());
    }

    let first = req.paths.first().cloned().unwrap_or_default();
    let name = Path::new(&first).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let exe = Path::new(program).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let ps = matches!(exe.as_str(), "powershell" | "powershell.exe" | "pwsh" | "pwsh.exe");
    let cmd = matches!(exe.as_str(), "cmd" | "cmd.exe");
    if cmd && std::iter::once(&first).chain(&req.paths).chain(std::iter::once(&req.dir)).any(|v| v.contains(['&', '|', '<', '>', '^', '%', '!', '"', '\r', '\n'])) {
        return Err("This name contains characters that aren't safe to pass to cmd.exe".into());
    }
    let sub = |t: &str| -> String {
        if ps {
            t.replace("{path}", "$env:PF_PATH").replace("{dir}", "$env:PF_DIR").replace("{name}", "$env:PF_NAME")
        } else {
            t.replace("{path}", &first).replace("{dir}", &req.dir).replace("{name}", &name)
        }
    };
    let mut args = Vec::new();
    for t in split_args(&req.template) {
        if t == "{paths}" {
            if ps {
                args.push("$env:PF_PATHS".to_string());
            } else {
                args.extend(req.paths.iter().cloned());
            }
        } else {
            args.push(sub(&t));
        }
    }
    let env: HashMap<String, String> = [
        ("PF_PATH", first.clone()),
        ("PF_DIR", req.dir.clone()),
        ("PF_NAME", name),
        ("PF_PATHS", req.paths.join("\n")),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    crate::shellmenu::run_custom(program, &args, Some(&req.dir).filter(|d| !d.is_empty()).map(|s| s.as_str()), &env)
}

/// Native confirmation for deleting without the Recycle Bin.
pub fn confirm_permanent_delete(window: &tauri::WebviewWindow, sources: &[String]) -> bool {
    let what = if sources.len() == 1 {
        format!("\"{}\"", Path::new(&sources[0]).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| sources[0].clone()))
    } else {
        format!("these {} items", sources.len())
    };
    native_confirm(
        window,
        "Delete permanently",
        &format!("Permanently delete {what}?\n\nThey won't go to the Recycle Bin and can't be restored."),
        "Delete permanently",
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn split_args_matches_ui() {
        assert_eq!(super::split_args(r#"-NoExit -Command Set-Location -LiteralPath '{dir}'"#), ["-NoExit", "-Command", "Set-Location", "-LiteralPath", "{dir}"]);
        assert_eq!(super::split_args(r#""{path}" --x"#), ["{path}", "--x"]);
    }
}
