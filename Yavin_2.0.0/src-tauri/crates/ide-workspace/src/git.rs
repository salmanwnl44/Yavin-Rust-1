use crate::file_tree::clean_path_str;
use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct GitStatus {
    pub root: String,
    pub output: String,
}

fn run_git(workspace_root: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command.args(args).current_dir(workspace_root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command
        .output()
        .map_err(|e| format!("Cannot run Git: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Git failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    String::from_utf8(output.stdout).map_err(|e| format!("Git returned non-UTF-8 filenames: {e}"))
}

/// Porcelain paths are relative to the repository root, even for a nested workspace.
pub fn get_workspace_git_status(workspace_root: &str) -> Result<GitStatus, String> {
    let root = run_git(workspace_root, &["rev-parse", "--show-toplevel"])?;
    let output = run_git(
        workspace_root,
        &["status", "--porcelain=v1", "-z", "-uall", "--", "."],
    )?;
    Ok(GitStatus {
        root: clean_path_str(root.trim_end_matches(['\r', '\n'])),
        output,
    })
}
