use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn mc_dir() -> PathBuf {
    // macOS: ~/Library/Application Support/minecraft
    dirs::data_dir()
        .expect("no data dir")
        .join("minecraft")
}

fn installations_dir() -> PathBuf {
    mc_dir().join("installations")
}

fn standards_dir() -> PathBuf {
    mc_dir().join("standards")
}

fn profiles_path() -> PathBuf {
    mc_dir().join("launcher_profiles.json")
}

fn read_profiles() -> CmdResult<Value> {
    let p = profiles_path();
    if !p.exists() {
        return Ok(json!({ "profiles": {}, "version": 3 }));
    }
    let text = fs::read_to_string(&p).map_err(err)?;
    serde_json::from_str(&text).map_err(err)
}

fn write_profiles(v: &Value) -> CmdResult<()> {
    let text = serde_json::to_string_pretty(v).map_err(err)?;
    fs::write(profiles_path(), text).map_err(err)
}

fn now_iso() -> String {
    chrono::Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Folders Essential shares between installations by symlinking to the root
/// minecraft folder. We do the same.
const SHARED_DIRS: [&str; 3] = ["resourcepacks", "saves", "screenshots"];

fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            if entry.file_name().to_string_lossy() == ".DS_Store" {
                continue;
            }
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst)?;
    }
    Ok(())
}

fn dir_size(p: &Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = fs::read_dir(p) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                total += dir_size(&path);
            } else if let Ok(meta) = entry.metadata() {
                total += meta.len();
            }
        }
    }
    total
}

/// "1.21.10", "26.1.2" — standards subfolders named like versions are
/// version-scoped; everything else at the top level is global.
fn is_version_name(name: &str) -> bool {
    name.chars().next().is_some_and(|c| c.is_ascii_digit()) && name.contains('.')
}

fn parse_version_id(version_id: &str) -> (String, String) {
    // returns (loader, game_version)
    if let Some(rest) = version_id.strip_prefix("fabric-loader-") {
        if let Some((_, game)) = rest.split_once('-') {
            return ("fabric".into(), game.into());
        }
    }
    if version_id.to_lowercase().contains("forge") {
        return ("forge".into(), version_id.into());
    }
    ("vanilla".into(), version_id.into())
}

fn data_url_from_png(bytes: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

// ---------------------------------------------------------------------------
// Installations
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct Installation {
    name: String,
    path: String,
    version_id: Option<String>,
    game_version: Option<String>,
    loader: Option<String>,
    icon: Option<String>,
    last_used: Option<String>,
    created: Option<String>,
    mods_count: usize,
    registered: bool,
    linked: Vec<String>,
    unlinked: Vec<String>,
}

#[tauri::command]
fn list_installations() -> CmdResult<Vec<Installation>> {
    let dir = installations_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let profiles = read_profiles()?;
    let empty = serde_json::Map::new();
    let profile_map = profiles["profiles"].as_object().unwrap_or(&empty);

    let mut out = vec![];
    for entry in fs::read_dir(&dir).map_err(err)?.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !path.is_dir() || name.starts_with('.') || name == "Shared" {
            continue;
        }

        let profile = profile_map.values().find(|p| {
            p["gameDir"].as_str() == Some(path.to_string_lossy().as_ref())
        });

        let version_id = profile
            .and_then(|p| p["lastVersionId"].as_str())
            .map(String::from);
        let (loader, game_version) = match &version_id {
            Some(v) => {
                let (l, g) = parse_version_id(v);
                (Some(l), Some(g))
            }
            None => (None, None),
        };

        // custom image takes priority over launcher icon
        let custom = path.join(".mim").join("icon.png");
        let icon = if custom.exists() {
            fs::read(&custom).ok().map(|b| data_url_from_png(&b))
        } else {
            profile.and_then(|p| p["icon"].as_str()).map(String::from)
        };

        let mods_count = fs::read_dir(path.join("mods"))
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|e| e.path().extension().is_some_and(|x| x == "jar"))
                    .count()
            })
            .unwrap_or(0);

        let mut linked = vec![];
        let mut unlinked = vec![];
        for d in SHARED_DIRS {
            if path.join(d).is_symlink() {
                linked.push(d.to_string());
            } else if path.join(d).exists() {
                unlinked.push(d.to_string());
            }
        }

        out.push(Installation {
            name,
            path: path.to_string_lossy().into(),
            version_id,
            game_version,
            loader,
            icon,
            last_used: profile.and_then(|p| p["lastUsed"].as_str()).map(String::from),
            created: profile.and_then(|p| p["created"].as_str()).map(String::from),
            mods_count,
            registered: profile.is_some(),
            linked,
            unlinked,
        });
    }
    // most recently used first
    out.sort_by(|a, b| b.last_used.cmp(&a.last_used));
    Ok(out)
}

// ---------------------------------------------------------------------------
// Version metadata (Mojang + Fabric)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct GameVersion {
    id: String,
    #[serde(rename = "type")]
    kind: String,
}

#[tauri::command]
async fn list_game_versions() -> CmdResult<Vec<GameVersion>> {
    let manifest: Value =
        reqwest::get("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json")
            .await
            .map_err(err)?
            .json()
            .await
            .map_err(err)?;
    let versions = manifest["versions"].as_array().ok_or("bad manifest")?;
    Ok(versions
        .iter()
        .filter_map(|v| {
            Some(GameVersion {
                id: v["id"].as_str()?.into(),
                kind: v["type"].as_str()?.into(),
            })
        })
        .collect())
}

#[derive(Serialize)]
struct LoaderVersion {
    version: String,
    stable: bool,
}

#[tauri::command]
async fn list_loader_versions(game_version: String) -> CmdResult<Vec<LoaderVersion>> {
    let url = format!("https://meta.fabricmc.net/v2/versions/loader/{game_version}");
    let list: Value = reqwest::get(&url).await.map_err(err)?.json().await.map_err(err)?;
    let arr = list.as_array().ok_or("no fabric loaders for this version")?;
    Ok(arr
        .iter()
        .filter_map(|v| {
            Some(LoaderVersion {
                version: v["loader"]["version"].as_str()?.into(),
                stable: v["loader"]["stable"].as_bool().unwrap_or(false),
            })
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct InstallSpec {
    name: String,
    game_version: String,
    fabric: bool,
    loader_version: Option<String>,
    standards: Vec<String>,
}

#[tauri::command]
async fn create_installation(spec: InstallSpec) -> CmdResult<()> {
    let name = spec.name.trim();
    if name.is_empty() || name.starts_with('.') || name.contains('/') {
        return Err("Invalid installation name".into());
    }
    let mc = mc_dir();
    let inst = installations_dir().join(name);
    if inst.exists() {
        return Err(format!("\"{name}\" already exists"));
    }
    fs::create_dir_all(&inst).map_err(err)?;

    // Essential-style shared folder symlinks
    link_shared_dirs(&inst)?;

    // resolve the launcher version id
    let version_id = if spec.fabric {
        let loader = match spec.loader_version {
            Some(v) => v,
            None => {
                let loaders = list_loader_versions(spec.game_version.clone()).await?;
                loaders
                    .iter()
                    .find(|l| l.stable)
                    .or(loaders.first())
                    .ok_or("no fabric loader available")?
                    .version
                    .clone()
            }
        };
        let url = format!(
            "https://meta.fabricmc.net/v2/versions/loader/{}/{}/profile/json",
            spec.game_version, loader
        );
        let profile: Value = reqwest::get(&url).await.map_err(err)?.json().await.map_err(err)?;
        let id = profile["id"].as_str().ok_or("bad fabric profile json")?.to_string();
        let vdir = mc.join("versions").join(&id);
        fs::create_dir_all(&vdir).map_err(err)?;
        fs::write(
            vdir.join(format!("{id}.json")),
            serde_json::to_string_pretty(&profile).map_err(err)?,
        )
        .map_err(err)?;
        id
    } else {
        // vanilla: the launcher fetches the version json itself
        spec.game_version.clone()
    };

    apply_standards_inner(&inst, &spec.standards)?;

    // register with the official launcher
    let mut profiles = read_profiles()?;
    if !profiles["profiles"].is_object() {
        profiles["profiles"] = json!({});
    }
    let key = uuid::Uuid::new_v4().simple().to_string();
    let now = now_iso();
    profiles["profiles"][key] = json!({
        "created": now,
        "gameDir": inst.to_string_lossy(),
        "icon": "Grass",
        "lastUsed": now,
        "lastVersionId": version_id,
        "name": name,
        "type": "custom"
    });
    write_profiles(&profiles)
}

fn link_shared_dirs(inst: &Path) -> CmdResult<(Vec<String>, Vec<String>)> {
    let mc = mc_dir();
    let mut linked = vec![];
    let mut skipped = vec![];
    for d in SHARED_DIRS {
        let target = mc.join(d);
        fs::create_dir_all(&target).map_err(err)?;
        let link = inst.join(d);
        if link.exists() || link.is_symlink() {
            skipped.push(d.to_string());
            continue;
        }
        std::os::unix::fs::symlink(&target, &link).map_err(err)?;
        linked.push(d.to_string());
    }
    Ok((linked, skipped))
}

/// Symlink shared folders into an existing installation. Never touches
/// folders that already exist (a real local folder stays local).
#[tauri::command]
fn link_installation(name: String) -> CmdResult<(Vec<String>, Vec<String>)> {
    let inst = installations_dir().join(&name);
    if !inst.is_dir() {
        return Err(format!("no installation named \"{name}\""));
    }
    link_shared_dirs(&inst)
}

// ---------------------------------------------------------------------------
// Standards
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct StandardEntry {
    name: String,
    rel_path: String,
    scope: String, // "global" or a game version like "1.21.10"
    is_dir: bool,
}

#[derive(Serialize)]
struct Standards {
    path: String,
    exists: bool,
    entries: Vec<StandardEntry>,
}

#[tauri::command]
fn list_standards() -> CmdResult<Standards> {
    let dir = standards_dir();
    let mut entries = vec![];
    if dir.exists() {
        for entry in fs::read_dir(&dir).map_err(err)?.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            if path.is_dir() && is_version_name(&name) {
                // version-scoped group: list its children
                for child in fs::read_dir(&path).map_err(err)?.flatten() {
                    let cname = child.file_name().to_string_lossy().to_string();
                    if cname.starts_with('.') {
                        continue;
                    }
                    entries.push(StandardEntry {
                        rel_path: format!("{name}/{cname}"),
                        scope: name.clone(),
                        is_dir: child.path().is_dir(),
                        name: cname,
                    });
                }
            } else {
                entries.push(StandardEntry {
                    rel_path: name.clone(),
                    scope: "global".into(),
                    is_dir: path.is_dir(),
                    name,
                });
            }
        }
    }
    entries.sort_by(|a, b| (&a.scope, &a.name).cmp(&(&b.scope, &b.name)));
    Ok(Standards {
        path: dir.to_string_lossy().into(),
        exists: dir.exists(),
        entries,
    })
}

#[tauri::command]
fn ensure_standards_dir() -> CmdResult<String> {
    let dir = standards_dir();
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.to_string_lossy().into())
}

fn apply_standards_inner(inst: &Path, rel_paths: &[String]) -> CmdResult<()> {
    let std_dir = standards_dir();
    for rel in rel_paths {
        if rel.contains("..") {
            return Err("invalid standards path".into());
        }
        let src = std_dir.join(rel);
        if !src.exists() {
            return Err(format!("standard not found: {rel}"));
        }
        // strip a version-folder prefix: "1.21.10/options.txt" -> "options.txt"
        let dest_rel = match rel.split_once('/') {
            Some((first, rest)) if is_version_name(first) => rest,
            _ => rel.as_str(),
        };
        copy_recursive(&src, &inst.join(dest_rel)).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn apply_standards(name: String, rel_paths: Vec<String>) -> CmdResult<()> {
    let inst = installations_dir().join(&name);
    if !inst.is_dir() {
        return Err(format!("no installation named \"{name}\""));
    }
    apply_standards_inner(&inst, &rel_paths)
}

// ---------------------------------------------------------------------------
// Custom images
// ---------------------------------------------------------------------------

#[tauri::command]
fn set_custom_icon(name: String, image_path: String) -> CmdResult<String> {
    let inst = installations_dir().join(&name);
    if !inst.is_dir() {
        return Err(format!("no installation named \"{name}\""));
    }
    let img = image::open(&image_path).map_err(err)?;
    let thumb = img.resize_to_fill(128, 128, image::imageops::FilterType::Lanczos3);
    let mut buf = Vec::new();
    thumb
        .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(err)?;

    let mim = inst.join(".mim");
    fs::create_dir_all(&mim).map_err(err)?;
    fs::write(mim.join("icon.png"), &buf).map_err(err)?;

    // mirror into the launcher profile so the official launcher shows it too
    let data_url = data_url_from_png(&buf);
    let mut profiles = read_profiles()?;
    if let Some(map) = profiles["profiles"].as_object_mut() {
        for profile in map.values_mut() {
            if profile["gameDir"].as_str() == Some(inst.to_string_lossy().as_ref()) {
                profile["icon"] = json!(data_url);
            }
        }
    }
    write_profiles(&profiles)?;
    Ok(data_url)
}

// ---------------------------------------------------------------------------
// Resource packs
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct Pack {
    name: String,
    size_bytes: u64,
    is_dir: bool,
}

#[derive(Serialize)]
struct LocalPacks {
    installation: String,
    packs: Vec<Pack>,
}

#[derive(Serialize)]
struct PacksOverview {
    shared_path: String,
    shared: Vec<Pack>,
    linked_installations: Vec<String>,
    local: Vec<LocalPacks>,
}

fn scan_packs(dir: &Path) -> Vec<Pack> {
    let mut packs = vec![];
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let is_dir = path.is_dir();
            packs.push(Pack {
                name,
                size_bytes: if is_dir {
                    dir_size(&path)
                } else {
                    entry.metadata().map(|m| m.len()).unwrap_or(0)
                },
                is_dir,
            });
        }
    }
    packs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    packs
}

#[tauri::command]
fn list_resourcepacks() -> CmdResult<PacksOverview> {
    let shared_dir = mc_dir().join("resourcepacks");
    let mut linked = vec![];
    let mut local = vec![];
    if let Ok(entries) = fs::read_dir(installations_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if !path.is_dir() || name.starts_with('.') || name == "Shared" {
                continue;
            }
            let rp = path.join("resourcepacks");
            if rp.is_symlink() {
                linked.push(name);
            } else if rp.is_dir() {
                let packs = scan_packs(&rp);
                if !packs.is_empty() {
                    local.push(LocalPacks { installation: name, packs });
                }
            }
        }
    }
    linked.sort();
    Ok(PacksOverview {
        shared_path: shared_dir.to_string_lossy().into(),
        shared: scan_packs(&shared_dir),
        linked_installations: linked,
        local,
    })
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

#[tauri::command]
fn delete_installation(name: String, remove_profile: bool) -> CmdResult<()> {
    let inst = installations_dir().join(&name);
    if !inst.is_dir() {
        return Err(format!("no installation named \"{name}\""));
    }
    trash::delete(&inst).map_err(err)?;
    if remove_profile {
        let mut profiles = read_profiles()?;
        if let Some(map) = profiles["profiles"].as_object_mut() {
            map.retain(|_, p| {
                p["gameDir"].as_str() != Some(inst.to_string_lossy().as_ref())
            });
        }
        write_profiles(&profiles)?;
    }
    Ok(())
}

#[tauri::command]
fn reveal_path(path: String, select: bool) -> CmdResult<()> {
    let mut cmd = std::process::Command::new("open");
    if select {
        cmd.arg("-R");
    }
    cmd.arg(&path).spawn().map_err(err)?;
    Ok(())
}

#[tauri::command]
fn open_launcher() -> CmdResult<()> {
    std::process::Command::new("open")
        .args(["-a", "Minecraft"])
        .spawn()
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
fn minecraft_dir() -> String {
    mc_dir().to_string_lossy().into()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_installations,
            list_game_versions,
            list_loader_versions,
            create_installation,
            link_installation,
            list_standards,
            ensure_standards_dir,
            apply_standards,
            set_custom_icon,
            list_resourcepacks,
            delete_installation,
            reveal_path,
            open_launcher,
            minecraft_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
