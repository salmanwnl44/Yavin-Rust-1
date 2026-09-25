use crate::{expecting, made_folders, with_workspace, Watch, Workspace};
use ide_workspace::file_tree::{temp_nonce, temp_path_for};
use ide_workspace::process::{capture, ToolOutput};
use ide_workspace::resource_events::{Expectation, OperationKind};
use serde::Deserialize;
use std::{
    collections::HashMap,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, State};

#[derive(Default)]
pub struct Jobs(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
    hidden: bool,
    ignored: bool,
    include: Vec<String>,
    exclude: Vec<String>,
    folder: String,
    buffer: Option<String>,
    files_only: bool,
}

#[tauri::command]
pub fn cancel_search(jobs: State<'_, Jobs>, id: String) -> Result<(), String> {
    if let Some(job) = jobs.0.lock().map_err(|e| e.to_string())?.get(&id) {
        job.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn search_project(
    app: tauri::AppHandle,
    state: State<'_, Workspace>,
    jobs: State<'_, Jobs>,
    workspace: String,
    id: String,
    options: SearchOptions,
) -> Result<ToolOutput, String> {
    let manager = with_workspace(&state, |m| {
        if m.validate_path(&workspace)? != m.root() {
            return Err("Workspace changed; search again".into());
        }
        Ok(m.clone())
    })?;
    let folder = manager.validate_path(&options.folder)?;
    if !folder.is_dir() {
        return Err("Search scope must be a directory".into());
    }
    if options.query.len() > 16384
        || options
            .buffer
            .as_ref()
            .is_some_and(|b| b.len() > 10 * 1024 * 1024)
    {
        return Err("Search input exceeds supported size".into());
    }
    let binary = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/search/rg.exe")
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("resources/search/rg.exe")
    };
    if !binary.is_file() {
        return Err("Search tool is missing. Run scripts/setup-search.ps1 and rebuild.".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut entries = jobs.0.lock().map_err(|e| e.to_string())?;
        if entries.len() >= 16 {
            return Err("Too many searches; wait for cancellation".into());
        }
        if entries.contains_key(&id) {
            return Err("Duplicate search request".into());
        }
        entries.insert(id.clone(), cancelled.clone());
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(binary);
        cmd.current_dir(folder).args([
            "--no-config",
            "--no-follow",
            "--max-filesize",
            "10M",
            "--glob",
            "!.git/**",
            "--glob",
            "!**/.git/**",
        ]);
        if options.files_only {
            cmd.args(["--files", "--null"]);
        } else {
            cmd.args(["--json", "--encoding", "utf-8", "--color", "never"]);
            if !options.regex {
                cmd.arg("--fixed-strings");
            }
            if !options.case_sensitive {
                cmd.arg("--ignore-case");
            }
            if options.whole_word {
                cmd.arg("--word-regexp");
            }
        }
        if options.hidden {
            cmd.arg("--hidden");
        }
        if options.ignored {
            cmd.arg("--no-ignore");
        }
        for glob in &options.include {
            cmd.arg("--glob").arg(glob);
        }
        for glob in &options.exclude {
            cmd.arg("--glob").arg(format!("!{glob}"));
        }
        // Hard exclusions come last so user globs cannot reinclude repository metadata.
        cmd.args(["--glob", "!.git/**", "--glob", "!**/.git/**"]);
        if !options.files_only {
            cmd.arg("--regexp").arg(&options.query);
        }
        cmd.arg("--")
            .arg(if options.buffer.is_some() { "-" } else { "." });
        capture(cmd, options.buffer, cancelled)
    })
    .await
    .map_err(|e| e.to_string());
    jobs.0.lock().map_err(|e| e.to_string())?.remove(&id);
    result?
}

#[tauri::command(async)]
pub fn write_file_guarded(
    state: State<'_, Workspace>,
    watch: State<'_, Watch>,
    path: String,
    expected: String,
    content: String,
) -> Result<(), String> {
    with_workspace(&state, |manager| {
        if manager.read_file(&path)? != expected {
            return Err(
                "File changed on disk. Reopen or review its current contents before saving.".into(),
            );
        }
        // One operation: the temporary file the bytes are written to first (gone again, or
        // holding exactly them), the rename onto the target, and the target's final bytes.
        let target = manager.validate_path(&path)?;
        let nonce = temp_nonce();
        let mut results = made_folders(&target);
        results.push((
            temp_path_for(&target, nonce),
            Expectation::transient(content.as_bytes()),
        ));
        results.push((target, Expectation::content(content.as_bytes())));
        expecting(&watch, OperationKind::Save, results, || {
            manager.write_file_with(&path, &content, nonce)
        })
    })
}
