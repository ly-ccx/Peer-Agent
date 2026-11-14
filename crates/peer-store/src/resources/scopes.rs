//! Native Host resource derivation; declaring a scope never grants filesystem
//! access. Mirrors execution-scopes.mjs, including Git's shared common directory.
use super::ResourceError;
use peer_protocol::{ExecutionResourceScope, normalize_execution_resource_scope};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceIdentity {
    pub resource_ref: String,
    pub identity: String,
}

fn absolute(path: &Path) -> Result<PathBuf, ResourceError> {
    if !path.is_absolute() || path.as_os_str().len() > 8192 {
        return Err(ResourceError::Scope);
    }
    let mut result = PathBuf::from("/");
    for part in path.components() {
        match part {
            Component::Normal(p) => result.push(p),
            Component::ParentDir => {
                result.pop();
            }
            Component::RootDir | Component::CurDir => {}
            _ => return Err(ResourceError::Scope),
        }
    }
    Ok(result)
}
fn resolved(
    path: &Path,
    allow_missing: bool,
) -> Result<(PathBuf, fs::Metadata, bool), ResourceError> {
    let mut existing = absolute(path)?;
    let mut suffix = Vec::new();
    if allow_missing {
        while !existing.exists() {
            suffix.push(existing.file_name().ok_or(ResourceError::Scope)?.to_owned());
            if !existing.pop() {
                return Err(ResourceError::Scope);
            }
        }
    }
    let mut canonical = fs::canonicalize(existing).map_err(|_| ResourceError::Scope)?;
    let meta = fs::metadata(&canonical).map_err(|_| ResourceError::Scope)?;
    let missing = !suffix.is_empty();
    for item in suffix.into_iter().rev() {
        canonical.push(item);
    }
    Ok((canonical, meta, missing))
}
fn identity(meta: &fs::Metadata) -> Result<String, ResourceError> {
    use std::os::unix::fs::MetadataExt;
    if meta.dev() > 9_007_199_254_740_991 || meta.ino() > 9_007_199_254_740_991 {
        return Err(ResourceError::Scope);
    }
    Ok(format!("{}:{}", meta.dev(), meta.ino()))
}
pub fn directory_resource(
    path: impl AsRef<Path>,
    allow_missing: bool,
) -> Result<ResourceIdentity, ResourceError> {
    let (path, meta, missing) = resolved(path.as_ref(), allow_missing)?;
    if !meta.is_dir() {
        return Err(ResourceError::Scope);
    }
    Ok(ResourceIdentity {
        resource_ref: format!("directory:{}", path.to_str().ok_or(ResourceError::Scope)?),
        identity: if missing {
            "missing".into()
        } else {
            identity(&meta)?
        },
    })
}
pub fn file_resource(
    path: impl AsRef<Path>,
    allow_missing: bool,
) -> Result<ResourceIdentity, ResourceError> {
    let (path, meta, missing) = resolved(path.as_ref(), allow_missing)?;
    if !((missing && meta.is_dir()) || (!missing && meta.is_file())) {
        return Err(ResourceError::Scope);
    }
    Ok(ResourceIdentity {
        resource_ref: format!("file:{}", path.to_str().ok_or(ResourceError::Scope)?),
        identity: if missing {
            "missing".into()
        } else {
            identity(&meta)?
        },
    })
}
pub fn resource_conflicts(first: &str, second: &str) -> bool {
    let parse = |s: &str| {
        s.strip_prefix("directory:")
            .map(|p| (true, p.to_owned()))
            .or_else(|| s.strip_prefix("file:").map(|p| (false, p.to_owned())))
    };
    let (Some((ad, a)), Some((bd, b))) = (parse(first), parse(second)) else {
        return first == second;
    };
    let inside = |child: &str, parent: &str| {
        child == parent
            || child.starts_with(&if parent.ends_with('/') {
                parent.to_owned()
            } else {
                format!("{parent}/")
            })
    };
    if ad && bd {
        inside(&a, &b) || inside(&b, &a)
    } else if !ad && !bd {
        a == b
    } else if ad {
        inside(&b, &a)
    } else {
        inside(&a, &b)
    }
}
pub fn provider_file_scopes(
    path: impl AsRef<Path>,
) -> Result<Vec<ExecutionResourceScope>, ResourceError> {
    let (path, _, _) = resolved(path.as_ref(), true)?;
    Ok(vec![ExecutionResourceScope::File {
        path: path.to_str().ok_or(ResourceError::Scope)?.into(),
    }])
}
fn small_text(path: &Path) -> Result<String, ResourceError> {
    let bytes = crate::files::read(path, 16_384)
        .map_err(|_| ResourceError::Scope)?
        .ok_or(ResourceError::Scope)?;
    Ok(peer_protocol::javascript_trim(
        std::str::from_utf8(&bytes).map_err(|_| ResourceError::Scope)?,
    )
    .into())
}
pub fn provider_execution_scopes(
    path: impl AsRef<Path>,
) -> Result<Vec<ExecutionResourceScope>, ResourceError> {
    let mut current =
        fs::canonicalize(absolute(path.as_ref())?).map_err(|_| ResourceError::Scope)?;
    if !current.is_dir() {
        return Err(ResourceError::Scope);
    }
    let mut scopes = vec![ExecutionResourceScope::Directory {
        path: current.to_str().ok_or(ResourceError::Scope)?.into(),
    }];
    loop {
        let marker = current.join(".git");
        if marker.exists() {
            let git = if marker.is_dir() {
                marker
            } else {
                let text = small_text(&marker)?;
                let value = text.strip_prefix("gitdir:").ok_or(ResourceError::Scope)?;
                let value = peer_protocol::javascript_trim(value);
                if value.is_empty() || value.contains('\n') {
                    return Err(ResourceError::Scope);
                }
                let value = Path::new(value);
                if value.is_absolute() {
                    value.to_owned()
                } else {
                    current.join(value)
                }
            };
            let common = git.join("commondir");
            let target = if common.exists() {
                git.join(small_text(&common)?)
            } else {
                git
            };
            let canonical = fs::canonicalize(target).map_err(|_| ResourceError::Scope)?;
            if !canonical.is_dir() {
                return Err(ResourceError::Scope);
            }
            scopes.push(ExecutionResourceScope::Directory {
                path: canonical.to_str().ok_or(ResourceError::Scope)?.into(),
            });
            return Ok(scopes);
        }
        if !current.pop() {
            return Ok(scopes);
        }
    }
}
pub(super) fn parse_scopes(value: &Value) -> Result<Vec<ExecutionResourceScope>, ResourceError> {
    let raw = value.as_array().ok_or(ResourceError::Scope)?;
    if raw.len() > 32 {
        return Err(ResourceError::Scope);
    }
    raw.iter()
        .map(|v| match normalize_execution_resource_scope(v) {
            Some(s @ ExecutionResourceScope::Directory { .. })
            | Some(s @ ExecutionResourceScope::File { .. }) => Ok(s),
            _ => Err(ResourceError::Scope),
        })
        .collect()
}
pub(super) fn scope_path(scope: &ExecutionResourceScope) -> Result<&str, ResourceError> {
    match scope {
        ExecutionResourceScope::Directory { path } | ExecutionResourceScope::File { path } => {
            Ok(path)
        }
        _ => Err(ResourceError::Scope),
    }
}
pub(super) fn scope_for_ref(reference: &str) -> Option<Value> {
    reference
        .strip_prefix("directory:")
        .map(|path| json!({"kind":"directory","path":path}))
        .or_else(|| {
            reference
                .strip_prefix("file:")
                .map(|path| json!({"kind":"file","path":path}))
        })
}
