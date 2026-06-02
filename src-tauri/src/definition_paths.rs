use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug)]
pub struct DefinitionRoot {
    pub label: String,
    pub path: PathBuf,
}

pub fn resolve_definition_path(
    kind: &str,
    definition: &str,
    root: Option<&str>,
) -> Result<PathBuf, String> {
    let kind = normalize_definition_kind(kind)?;
    let relative = safe_definition_relative_path(definition)?;
    let requested_root = root
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "unknown");
    let mut matched_requested_root = requested_root.is_none();

    for root in definition_roots(kind) {
        if let Some(requested_root) = requested_root {
            if root.label != requested_root {
                continue;
            }
            matched_requested_root = true;
        }

        let candidate = root.path.join(&relative);
        if candidate.is_dir() {
            if let Some(file) = primary_definition_file(&candidate, kind) {
                return ensure_within_root(&file, &root);
            }
        } else if candidate.is_file() {
            return ensure_within_root(&candidate, &root);
        }
    }

    if let Some(requested_root) = requested_root {
        if !matched_requested_root {
            return Err(format!(
                "Unsupported {} definition root: {}",
                kind, requested_root
            ));
        }
    }
    Err(format!("No {} definition found for: {}", kind, definition))
}

pub fn definition_roots(kind: &str) -> Vec<DefinitionRoot> {
    let project_candidates: &[&str] = if kind == "agents" {
        &[
            ".copilot/agents",
            ".github/copilot/agents",
            ".github/agents",
        ]
    } else {
        &[".copilot/skills", ".github/copilot/skills"]
    };
    let user_candidates: &[&str] = if kind == "agents" {
        &["agents", "installed-plugins", "marketplace-cache"]
    } else {
        &["skills", "installed-plugins", "marketplace-cache"]
    };
    let mut roots = Vec::new();
    if let Some(project_root) = project_root_for_mcp() {
        roots.extend(project_candidates.iter().map(|candidate| DefinitionRoot {
            label: format!("project:{}", candidate),
            path: project_root.join(candidate),
        }));
    }
    if let Some(home) = user_home_dir() {
        roots.extend(user_candidates.iter().map(|candidate| DefinitionRoot {
            label: format!("~/.copilot/{}", candidate),
            path: home.join(".copilot").join(candidate),
        }));
    }
    roots
}

pub fn safe_definition_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.is_absolute() {
        return Err("Definition reference must be relative".to_string());
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            _ => return Err("Definition reference contains unsafe path components".to_string()),
        }
    }
    if clean.as_os_str().is_empty() {
        return Err("Definition reference is empty".to_string());
    }
    Ok(clean)
}

pub fn primary_definition_file(dir: &Path, kind: &str) -> Option<PathBuf> {
    let names: &[&str] = if kind == "agents" {
        &["AGENT.md", "agent.yaml", "agent.yml", "AGENTS.md"]
    } else {
        &["SKILL.md", "skill.yaml", "skill.yml"]
    };
    names
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
}

pub fn normalize_definition_kind(kind: &str) -> Result<&'static str, String> {
    match kind {
        "agents" | "agent" => Ok("agents"),
        "skills" | "skill" => Ok("skills"),
        _ => Err(format!("Unsupported definition kind: {}", kind)),
    }
}

fn ensure_within_root(candidate: &Path, root: &DefinitionRoot) -> Result<PathBuf, String> {
    let canonical_root = root.path.canonicalize().map_err(|err| {
        format!(
            "Unable to resolve {} definition root {}: {}",
            root.label,
            root.path.display(),
            err
        )
    })?;
    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|err| format!("Unable to resolve definition path: {}", err))?;
    if canonical_candidate.starts_with(&canonical_root) {
        Ok(canonical_candidate)
    } else {
        Err("Definition path escapes the allowed root".to_string())
    }
}

fn project_root_for_mcp() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("CMC_PROJECT_ROOT").map(PathBuf::from) {
        return Some(root);
    }
    let cwd = std::env::current_dir().ok()?;
    if cwd.file_name().and_then(|name| name.to_str()) == Some("src-tauri") {
        return cwd.parent().map(Path::to_path_buf);
    }
    Some(cwd)
}

fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}
