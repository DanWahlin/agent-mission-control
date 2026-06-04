use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Default)]
pub(crate) struct ExecutableEnv {
    pub(crate) path: Option<OsString>,
    pub(crate) node: Option<PathBuf>,
    pub(crate) copilot: Option<PathBuf>,
}

pub(crate) fn resolve_executable_env() -> ExecutableEnv {
    let search_dirs = executable_search_dirs();
    let path = env::join_paths(&search_dirs).ok();
    ExecutableEnv {
        path,
        node: resolve_executable("NODE", &executable_names("node"), &search_dirs),
        copilot: resolve_executable(
            "COPILOT_CLI_PATH",
            &executable_names("copilot"),
            &search_dirs,
        ),
    }
}

fn resolve_executable(env_var: &str, names: &[String], search_dirs: &[PathBuf]) -> Option<PathBuf> {
    if let Some(path) = env::var_os(env_var).map(PathBuf::from) {
        if is_executable_file(&path) {
            return Some(path);
        }
    }
    search_dirs
        .iter()
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|path| is_executable_file(path))
}

fn executable_names(base: &str) -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        vec![
            format!("{}.exe", base),
            format!("{}.cmd", base),
            format!("{}.bat", base),
            base.to_string(),
        ]
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![base.to_string()]
    }
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn executable_search_dirs() -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut dirs = Vec::new();
    let mut push = |path: PathBuf| {
        if !path.as_os_str().is_empty() && seen.insert(path.clone()) {
            dirs.push(path);
        }
    };

    if let Some(path_env) = env::var_os("PATH") {
        for path in env::split_paths(&path_env) {
            push(path);
        }
    }
    if let Some(home) = home_dir() {
        push(home.join(".local/bin"));
        push(home.join(".cargo/bin"));
        push(home.join(".bun/bin"));
        push(home.join(".npm-global/bin"));
        push(home.join(".yarn/bin"));
        push(home.join(".volta/bin"));
        push(home.join(".asdf/shims"));
        push(home.join("bin"));
    }

    #[cfg(target_os = "macos")]
    {
        push(PathBuf::from("/opt/homebrew/bin"));
        push(PathBuf::from("/usr/local/bin"));
        push(PathBuf::from("/usr/bin"));
        push(PathBuf::from("/bin"));
        push(PathBuf::from("/usr/sbin"));
        push(PathBuf::from("/sbin"));
    }
    #[cfg(target_os = "linux")]
    {
        push(PathBuf::from("/usr/local/bin"));
        push(PathBuf::from("/usr/bin"));
        push(PathBuf::from("/bin"));
        push(PathBuf::from("/snap/bin"));
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = env::var_os("APPDATA") {
            push(PathBuf::from(appdata).join("npm"));
        }
        if let Some(localappdata) = env::var_os("LOCALAPPDATA") {
            push(PathBuf::from(localappdata).join("Programs").join("nodejs"));
        }
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(program_files) = env::var_os(var) {
                push(PathBuf::from(program_files).join("nodejs"));
            }
        }
    }

    if let Some(home) = home_dir() {
        for path in collect_version_manager_bins(&home) {
            push(path);
        }
    }

    dirs
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
}

fn collect_version_manager_bins(home: &Path) -> Vec<PathBuf> {
    let mut bins = Vec::new();
    collect_child_bin_dirs(&home.join(".nvm").join("versions").join("node"), &mut bins);
    collect_child_bin_dirs(&home.join(".nodenv").join("versions"), &mut bins);
    collect_child_bin_dirs(&home.join(".fnm").join("node-versions"), &mut bins);
    collect_child_installation_bin_dirs(&home.join(".fnm").join("node-versions"), &mut bins);
    let fnm_data_root = home
        .join(".local")
        .join("share")
        .join("fnm")
        .join("node-versions");
    collect_child_bin_dirs(&fnm_data_root, &mut bins);
    collect_child_installation_bin_dirs(&fnm_data_root, &mut bins);
    bins
}

fn collect_child_bin_dirs(root: &Path, bins: &mut Vec<PathBuf>) {
    for dir in sorted_child_dirs(root) {
        bins.push(dir.join("bin"));
    }
}

fn collect_child_installation_bin_dirs(root: &Path, bins: &mut Vec<PathBuf>) {
    for dir in sorted_child_dirs(root) {
        bins.push(dir.join("installation").join("bin"));
    }
}

fn sorted_child_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort_by(|a, b| compare_version_path_desc(a, b));
    dirs
}

fn compare_version_path_desc(a: &Path, b: &Path) -> std::cmp::Ordering {
    let a_key = version_sort_key(a);
    let b_key = version_sort_key(b);
    b_key
        .cmp(&a_key)
        .then_with(|| b.file_name().cmp(&a.file_name()))
}

fn version_sort_key(path: &Path) -> Vec<u64> {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .trim_start_matches('v')
        .split(|ch: char| !ch.is_ascii_digit())
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

pub(crate) fn copilot_sdk_client_options() -> github_copilot_sdk::ClientOptions {
    let executable_env = resolve_executable_env();
    let mut options = github_copilot_sdk::ClientOptions::new();
    let mut child_env = Vec::new();
    if let Some(path) = &executable_env.path {
        child_env.push((OsString::from("PATH"), path.clone()));
    }
    if let Some(copilot) = &executable_env.copilot {
        options = options.with_program(copilot.clone());
        child_env.push((
            OsString::from("COPILOT_CLI_PATH"),
            copilot.as_os_str().to_os_string(),
        ));
    }
    if child_env.is_empty() {
        options
    } else {
        options.with_env(child_env)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_sort_prefers_newer_semver() {
        let mut paths = vec![
            PathBuf::from("/nvm/v9.0.0"),
            PathBuf::from("/nvm/v22.1.0"),
            PathBuf::from("/nvm/v20.12.2"),
        ];
        paths.sort_by(|a, b| compare_version_path_desc(a, b));
        assert_eq!(paths[0], PathBuf::from("/nvm/v22.1.0"));
        assert_eq!(paths[1], PathBuf::from("/nvm/v20.12.2"));
        assert_eq!(paths[2], PathBuf::from("/nvm/v9.0.0"));
    }
}
