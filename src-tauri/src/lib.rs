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

/// Set to point MIM at a sample folder instead of the real one (see `bun run dev:sample`).
const MC_DIR_ENV: &str = "MIM_MINECRAFT_DIR";

fn mc_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os(MC_DIR_ENV) {
        return PathBuf::from(dir);
    }
    // macOS: ~/Library/Application Support/minecraft
    dirs::data_dir()
        .expect("no data dir")
        .join("minecraft")
}

/// Canonical path, or an error if it's outside the minecraft folder.
fn inside_mc(path: &str) -> CmdResult<PathBuf> {
    let p = fs::canonicalize(path).map_err(err)?;
    let root = fs::canonicalize(mc_dir()).map_err(err)?;
    if p.starts_with(&root) {
        Ok(p)
    } else {
        Err("not a path inside the minecraft folder".into())
    }
}

fn installations_dir() -> PathBuf {
    mc_dir().join("installations")
}

/// The main folder (None) or one installation's game folder.
fn game_dir(installation: Option<&str>) -> CmdResult<PathBuf> {
    match installation {
        None => Ok(mc_dir()),
        Some(n) if n.is_empty() || n.starts_with('.') || n.contains('/') => {
            Err("invalid installation name".into())
        }
        Some(n) => {
            let d = installations_dir().join(n);
            if d.is_dir() {
                Ok(d)
            } else {
                Err(format!("no installation named \"{n}\""))
            }
        }
    }
}

/// Installation folder names, sorted.
fn installation_names() -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(installations_dir())
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().is_dir())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| !n.starts_with('.') && n != "Shared")
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
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

/// Total bytes under `p`. Symlinks aren't followed, so shared folders linked
/// into installations are counted once, and link cycles can't hang us.
fn dir_size(p: &Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = fs::read_dir(p) {
        for entry in entries.flatten() {
            match entry.file_type() {
                Ok(t) if t.is_dir() => total += dir_size(&entry.path()),
                Ok(t) if t.is_file() => total += entry.metadata().map(|m| m.len()).unwrap_or(0),
                _ => {}
            }
        }
    }
    total
}

/// Runs `f` over `items` on one thread each — sizing big folders one by one
/// is the slow part of every scan.
// ponytail: one thread per item, swap for a pool if folders hold thousands
fn par_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    std::thread::scope(|sc| {
        let f = &f;
        let hs: Vec<_> = items.iter().map(|i| sc.spawn(move || f(i))).collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    })
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

#[tauri::command(async)]
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
#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[tauri::command(async)]
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
    let paths: Vec<PathBuf> = fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();
    let mut packs = par_map(&paths, |p| Pack {
        name: p.file_name().unwrap_or_default().to_string_lossy().into(),
        size_bytes: entry_size(p),
        is_dir: p.is_dir(),
    });
    packs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    packs
}

#[tauri::command(async)]
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

#[tauri::command(async)]
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

#[derive(Serialize)]
struct McDir {
    path: String,
    sample: bool,
}

#[tauri::command]
fn minecraft_dir() -> McDir {
    McDir {
        path: mc_dir().to_string_lossy().into(),
        sample: std::env::var_os(MC_DIR_ENV).is_some(),
    }
}

// ---------------------------------------------------------------------------
// Minecraft folder cleanup (logs + caches)
// ---------------------------------------------------------------------------

/// Where a stray root-level log belongs under logs/, or None if it isn't one.
fn log_home(name: &str) -> Option<&'static str> {
    if name.starts_with("hs_err_pid") && name.ends_with(".log") {
        Some("old")
    } else if name.starts_with("launcher_") && name.contains("log") && name.ends_with(".txt") {
        Some("launcher")
    } else if name.starts_with("nativeUpdaterLog") && name.ends_with(".txt") {
        Some("updater")
    } else {
        None
    }
}

fn log_kind(rel: &Path) -> &'static str {
    let name = rel.file_name().unwrap_or_default().to_string_lossy();
    if rel.starts_with("crash-reports") || name.starts_with("hs_err_pid") {
        "crash"
    } else if name.starts_with("launcher_") || rel.starts_with("logs/launcher") {
        "launcher"
    } else if name.starts_with("nativeUpdaterLog") || rel.starts_with("logs/updater") {
        "updater"
    } else if name.starts_with("debug") || rel.starts_with("debug") {
        "debug"
    } else {
        "game"
    }
}

const LOG_DIRS: [&str; 3] = ["logs", "crash-reports", "debug"];

/// What a top-level entry of the minecraft folder is. Purges act on exactly
/// the "logs" and "cache" buckets, so the overview and the purge agree.
fn category(name: &str) -> &'static str {
    match name {
        _ if LOG_DIRS.contains(&name) || log_home(name).is_some() => "logs",
        "webcache" | "webcache2" | "downloads" | "server-resource-packs" | ".fabric"
        | "updateSourceCache.json" | "usercache.json" => "cache",
        "assets" | "libraries" | "versions" | "runtime" | "bin" => "game",
        "saves" | "resourcepacks" | "shaderpacks" | "screenshots" | "mods" | "config"
        | "installations" | "standards" | "servers.dat" | "servers.dat_old" | "hotbar.nbt"
        | "command_history.txt" | "options.txt" | "options.txt.bak" | "optionsof.txt" | "optionsshaders.txt" => {
            "yours"
        }
        _ if name.starts_with("launcher")
            || matches!(
                name,
                "clientId_v2.txt" | "treatment_tags.json" | "realms_persistence.json" | "quickPlay"
            ) =>
        {
            "launcher"
        }
        _ => "other",
    }
}

fn root_entries(root: &Path, cat: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = fs::read_dir(root)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_name() != ".DS_Store")
                .filter(|e| category(&e.file_name().to_string_lossy()) == cat)
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

fn entry_size(p: &Path) -> u64 {
    if p.is_dir() {
        dir_size(p)
    } else {
        fs::metadata(p).map(|m| m.len()).unwrap_or(0)
    }
}

fn walk_files(dir: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_name() == ".DS_Store" {
                continue;
            }
            if path.is_dir() {
                walk_files(&path, out);
            } else {
                out.push(path);
            }
        }
    }
}

fn stray_logs(root: &Path) -> Vec<(PathBuf, &'static str)> {
    let mut out = vec![];
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(home) = log_home(&name) {
                if entry.path().is_file() {
                    out.push((entry.path(), home));
                }
            }
        }
    }
    out
}

#[derive(Serialize)]
struct LogEntry {
    path: String,
    rel: String,
    name: String,
    kind: &'static str,
    modified: Option<String>,
    size_bytes: u64,
    sorted: bool,
}

fn list_logs_in(root: &Path) -> Vec<LogEntry> {
    let mut files: Vec<PathBuf> = stray_logs(root).into_iter().map(|(p, _)| p).collect();
    for d in LOG_DIRS {
        walk_files(&root.join(d), &mut files);
    }
    let mut out: Vec<LogEntry> = files
        .into_iter()
        .map(|p| {
            let rel = p.strip_prefix(root).unwrap_or(&p).to_path_buf();
            let meta = fs::metadata(&p).ok();
            LogEntry {
                kind: log_kind(&rel),
                sorted: rel.components().count() > 1,
                name: p.file_name().unwrap_or_default().to_string_lossy().into(),
                rel: rel.to_string_lossy().into(),
                path: p.to_string_lossy().into(),
                size_bytes: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: meta.and_then(|m| m.modified().ok()).map(|t| {
                    chrono::DateTime::<chrono::Utc>::from(t)
                        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
                }),
            }
        })
        .collect();
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

/// `dir/name`, or `dir/stem-N.ext` if that's taken.
fn free_path(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s, format!(".{e}")),
        None => (name, String::new()),
    };
    (1..)
        .map(|n| dir.join(format!("{stem}-{n}{ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

fn sort_logs_in(root: &Path) -> std::io::Result<usize> {
    let strays = stray_logs(root);
    for (path, home) in &strays {
        let dir = root.join("logs").join(home);
        fs::create_dir_all(&dir)?;
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        fs::rename(path, free_path(&dir, &name))?;
    }
    Ok(strays.len())
}

#[tauri::command(async)]
fn list_logs(installation: Option<String>) -> CmdResult<Vec<LogEntry>> {
    Ok(list_logs_in(&game_dir(installation.as_deref())?))
}

#[tauri::command(async)]
fn sort_logs(installation: Option<String>) -> CmdResult<usize> {
    sort_logs_in(&game_dir(installation.as_deref())?).map_err(err)
}

/// Reads a log (gunzipping .gz) — last 2 MB only, logs can be huge.
#[tauri::command(async)]
fn read_log(path: String) -> CmdResult<String> {
    let p = inside_mc(&path)?;
    let bytes = if p.extension().is_some_and(|e| e == "gz") {
        std::process::Command::new("gzip")
            .arg("-dc")
            .arg(&p)
            .output()
            .map_err(err)?
            .stdout
    } else {
        fs::read(&p).map_err(err)?
    };
    const MAX: usize = 2 * 1024 * 1024;
    let start = bytes.len().saturating_sub(MAX);
    Ok(String::from_utf8_lossy(&bytes[start..]).into())
}

#[tauri::command(async)]
fn purge_logs(installation: Option<String>) -> CmdResult<usize> {
    let t = root_entries(&game_dir(installation.as_deref())?, "logs");
    if !t.is_empty() {
        trash::delete_all(&t).map_err(err)?;
    }
    Ok(t.len())
}

#[derive(Serialize)]
struct FolderItem {
    name: String,
    path: String,
    category: &'static str,
    size_bytes: u64,
    is_dir: bool,
}

/// Every top-level entry of the minecraft folder, categorized. async so the
/// size walk (assets/libraries can be GBs) runs off the main thread.
#[tauri::command]
async fn folder_overview() -> CmdResult<Vec<FolderItem>> {
    let paths: Vec<PathBuf> = fs::read_dir(mc_dir())
        .map_err(err)?
        .flatten()
        .filter(|e| e.file_name() != ".DS_Store")
        .map(|e| e.path())
        .collect();
    let mut out = par_map(&paths, |p| {
        let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
        FolderItem {
            category: category(&name),
            size_bytes: entry_size(p),
            is_dir: p.is_dir(),
            path: p.to_string_lossy().into(),
            name,
        }
    });
    out.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    Ok(out)
}

#[tauri::command(async)]
fn purge_cache() -> CmdResult<usize> {
    let t = root_entries(&mc_dir(), "cache");
    if !t.is_empty() {
        trash::delete_all(&t).map_err(err)?;
    }
    Ok(t.len())
}


// ---------------------------------------------------------------------------
// NBT — just enough to read level.dat
// ---------------------------------------------------------------------------

fn take<'a>(r: &mut &'a [u8], n: usize) -> Option<&'a [u8]> {
    if r.len() < n {
        return None;
    }
    let (a, b) = r.split_at(n);
    *r = b;
    Some(a)
}

fn be<const N: usize>(r: &mut &[u8]) -> Option<[u8; N]> {
    take(r, N)?.try_into().ok()
}

fn nbt_str(r: &mut &[u8]) -> Option<String> {
    let n = u16::from_be_bytes(be(r)?) as usize;
    Some(String::from_utf8_lossy(take(r, n)?).into())
}

/// One tag payload as JSON. Longs become strings (seeds overflow JS numbers);
/// byte/int/long arrays are skipped as null.
fn nbt_payload(t: u8, r: &mut &[u8], depth: u8) -> Option<Value> {
    if depth > 64 {
        return None;
    }
    Some(match t {
        1 => json!(i8::from_be_bytes(be(r)?)),
        2 => json!(i16::from_be_bytes(be(r)?)),
        3 => json!(i32::from_be_bytes(be(r)?)),
        4 => json!(i64::from_be_bytes(be(r)?).to_string()),
        5 => json!(f32::from_be_bytes(be(r)?)),
        6 => json!(f64::from_be_bytes(be(r)?)),
        7 | 11 | 12 => {
            let n = i32::from_be_bytes(be(r)?).max(0) as usize;
            let width = match t {
                7 => 1,
                11 => 4,
                _ => 8,
            };
            take(r, n.checked_mul(width)?)?;
            Value::Null
        }
        8 => json!(nbt_str(r)?),
        9 => {
            let item = be::<1>(r)?[0];
            let n = i32::from_be_bytes(be(r)?).max(0);
            let mut v = vec![];
            for _ in 0..n {
                v.push(nbt_payload(item, r, depth + 1)?);
            }
            Value::Array(v)
        }
        10 => {
            let mut m = serde_json::Map::new();
            loop {
                let ct = be::<1>(r)?[0];
                if ct == 0 {
                    break;
                }
                let name = nbt_str(r)?;
                m.insert(name, nbt_payload(ct, r, depth + 1)?);
            }
            Value::Object(m)
        }
        _ => return None,
    })
}

fn nbt_root(buf: &[u8]) -> Option<Value> {
    let mut r = buf;
    let t = be::<1>(&mut r)?[0];
    nbt_str(&mut r)?;
    nbt_payload(t, &mut r, 0)
}

fn read_nbt_gz(p: &Path) -> Option<Value> {
    use std::io::Read;
    let mut buf = vec![];
    flate2::read::GzDecoder::new(fs::File::open(p).ok()?)
        .read_to_end(&mut buf)
        .ok()?;
    nbt_root(&buf)
}

// ---------------------------------------------------------------------------
// Saves
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct World {
    folder: String,
    path: String,
    location: String, // "Shared" or the installation keeping its own saves
    name: String,
    icon: Option<String>,
    last_played: Option<i64>,
    game_mode: Option<i64>,
    hardcore: bool,
    cheats: bool,
    version: Option<String>,
    seed: Option<String>,
    size_bytes: u64,
}

fn read_world(dir: &Path, location: &str) -> World {
    let d = read_nbt_gz(&dir.join("level.dat"))
        .map(|v| v["Data"].clone())
        .unwrap_or(Value::Null);
    let folder: String = dir.file_name().unwrap_or_default().to_string_lossy().into();
    World {
        name: d["LevelName"].as_str().map(String::from).unwrap_or(folder.clone()),
        icon: fs::read(dir.join("icon.png")).ok().map(|b| data_url_from_png(&b)),
        last_played: d["LastPlayed"].as_str().and_then(|s| s.parse().ok()),
        game_mode: d["GameType"].as_i64(),
        hardcore: d["hardcore"].as_i64() == Some(1),
        cheats: d["allowCommands"].as_i64() == Some(1),
        version: d["Version"]["Name"].as_str().map(String::from),
        seed: d["WorldGenSettings"]["seed"]
            .as_str()
            .or(d["RandomSeed"].as_str())
            .map(String::from),
        size_bytes: dir_size(dir),
        path: dir.to_string_lossy().into(),
        location: location.into(),
        folder,
    }
}

/// Root saves, plus any installation that keeps its own (non-linked) saves.
fn world_dirs(root: &Path) -> Vec<(String, PathBuf)> {
    let mut locations = vec![("Shared".to_string(), root.join("saves"))];
    if let Ok(rd) = fs::read_dir(root.join("installations")) {
        for e in rd.flatten() {
            let saves = e.path().join("saves");
            if saves.is_dir() && !saves.is_symlink() {
                locations.push((e.file_name().to_string_lossy().into(), saves));
            }
        }
    }
    let mut out = vec![];
    for (loc, saves) in locations {
        for e in fs::read_dir(&saves).into_iter().flatten().flatten() {
            if e.path().is_dir() && !e.file_name().to_string_lossy().starts_with('.') {
                out.push((loc.clone(), e.path()));
            }
        }
    }
    out
}

#[tauri::command(async)]
fn list_saves() -> Vec<World> {
    let mut worlds = par_map(&world_dirs(&mc_dir()), |(loc, p)| read_world(p, loc));
    worlds.sort_by(|a, b| b.last_played.cmp(&a.last_played));
    worlds
}

#[derive(Serialize)]
struct WorldDetails {
    parts: Vec<Pack>,
    datapacks: Vec<String>,
    players: usize,
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| !n.starts_with('.'))
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

#[tauri::command(async)]
fn world_details(path: String) -> CmdResult<WorldDetails> {
    let dir = inside_mc(&path)?;
    let paths: Vec<PathBuf> = names_in(&dir).iter().map(|n| dir.join(n)).collect();
    let mut parts = par_map(&paths, |p| Pack {
        name: p.file_name().unwrap_or_default().to_string_lossy().into(),
        size_bytes: entry_size(p),
        is_dir: p.is_dir(),
    });
    parts.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    Ok(WorldDetails {
        parts,
        datapacks: names_in(&dir.join("datapacks")),
        players: names_in(&dir.join("playerdata"))
            .iter()
            .filter(|n| n.ends_with(".dat"))
            .count(),
    })
}

// ---------------------------------------------------------------------------
// options.txt
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct OptionsSource {
    label: String,
    kind: &'static str, // "base" | "installation"
    path: String,
    exists: bool,
}

#[tauri::command(async)]
fn options_sources() -> Vec<OptionsSource> {
    let root = mc_dir();
    let base = root.join("options.txt");
    let mut out = vec![OptionsSource {
        label: "Base game".into(),
        kind: "base",
        exists: base.exists(),
        path: base.to_string_lossy().into(),
    }];
    let inst_dir = root.join("installations");
    for name in names_in(&inst_dir) {
        let dir = inst_dir.join(&name);
        if !dir.is_dir() || name == "Shared" {
            continue;
        }
        let p = dir.join("options.txt");
        out.push(OptionsSource {
            label: name,
            kind: "installation",
            exists: p.exists(),
            path: p.to_string_lossy().into(),
        });
    }
    out
}

fn parse_options(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// An options.txt path inside the minecraft folder (the file may not exist yet).
fn options_path(path: &str) -> CmdResult<PathBuf> {
    let p = PathBuf::from(path);
    if p.file_name().is_none_or(|n| n != "options.txt") {
        return Err("not an options.txt".into());
    }
    let parent = inside_mc(&p.parent().ok_or("bad path")?.to_string_lossy())?;
    Ok(parent.join("options.txt"))
}

#[tauri::command(async)]
fn read_options(path: String) -> CmdResult<Vec<(String, String)>> {
    let p = options_path(&path)?;
    if !p.exists() {
        return Ok(vec![]);
    }
    Ok(parse_options(&fs::read_to_string(&p).map_err(err)?))
}

/// Rewrites options.txt, keeping the previous version as options.txt.bak.
#[tauri::command(async)]
fn write_options(path: String, entries: Vec<(String, String)>) -> CmdResult<()> {
    let p = options_path(&path)?;
    let mut text = String::new();
    for (k, v) in &entries {
        if k.is_empty() || k.contains([':', '\n']) || v.contains('\n') {
            return Err(format!("invalid option \"{k}\""));
        }
        text.push_str(&format!("{k}:{v}\n"));
    }
    if p.exists() {
        fs::copy(&p, p.with_extension("txt.bak")).map_err(err)?;
    }
    fs::write(&p, text).map_err(err)
}

// ---------------------------------------------------------------------------
// Servers (servers.dat is uncompressed NBT; Minecraft keeps the previous
// version as servers.dat_old)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
struct Server {
    name: String,
    ip: String,
    icon: Option<String>, // base64 PNG, no data: prefix
    accept_textures: Option<i64>,
    hidden: bool,
}

fn read_servers(p: &Path) -> Vec<Server> {
    let Some(v) = fs::read(p).ok().and_then(|b| nbt_root(&b)) else {
        return vec![];
    };
    v["servers"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|s| Server {
                    name: s["name"].as_str().unwrap_or("Minecraft Server").into(),
                    ip: s["ip"].as_str().unwrap_or("").into(),
                    icon: s["icon"].as_str().map(String::from),
                    accept_textures: s["acceptTextures"].as_i64(),
                    hidden: s["hidden"].as_i64() == Some(1),
                })
                .collect()
        })
        .unwrap_or_default()
}

// ponytail: plain UTF-8, not Java's modified UTF-8 — only differs for emoji
// and NUL in server names
fn nbt_put_str(b: &mut Vec<u8>, s: &str) {
    let bytes = &s.as_bytes()[..s.len().min(u16::MAX as usize)];
    b.extend((bytes.len() as u16).to_be_bytes());
    b.extend(bytes);
}

fn servers_nbt(servers: &[Server]) -> Vec<u8> {
    let str_tag = |b: &mut Vec<u8>, k: &str, v: &str| {
        b.push(8);
        nbt_put_str(b, k);
        nbt_put_str(b, v);
    };
    let byte_tag = |b: &mut Vec<u8>, k: &str, v: i64| {
        b.push(1);
        nbt_put_str(b, k);
        b.push(v as u8);
    };
    let mut b = vec![10];
    nbt_put_str(&mut b, "");
    b.push(9);
    nbt_put_str(&mut b, "servers");
    b.push(10);
    b.extend((servers.len() as i32).to_be_bytes());
    for s in servers {
        str_tag(&mut b, "name", &s.name);
        str_tag(&mut b, "ip", &s.ip);
        if let Some(icon) = &s.icon {
            str_tag(&mut b, "icon", icon);
        }
        if let Some(a) = s.accept_textures {
            byte_tag(&mut b, "acceptTextures", a);
        }
        if s.hidden {
            byte_tag(&mut b, "hidden", 1);
        }
        b.push(0);
    }
    b.push(0);
    b
}

#[derive(Serialize)]
struct ServerList {
    installation: Option<String>,
    label: String,
    path: String,
    exists: bool,
    servers: Vec<Server>,
    backup: Vec<Server>,
}

#[tauri::command(async)]
fn list_servers() -> Vec<ServerList> {
    let mut scopes: Vec<Option<String>> = vec![None];
    scopes.extend(installation_names().into_iter().map(Some));
    scopes
        .into_iter()
        .filter_map(|inst| {
            let dir = game_dir(inst.as_deref()).ok()?;
            let p = dir.join("servers.dat");
            Some(ServerList {
                label: inst.clone().unwrap_or("Main folder".into()),
                exists: p.exists(),
                servers: read_servers(&p),
                backup: read_servers(&dir.join("servers.dat_old")),
                path: p.to_string_lossy().into(),
                installation: inst,
            })
        })
        .collect()
}

/// Saves the list the way Minecraft does: current file becomes servers.dat_old.
#[tauri::command(async)]
fn write_servers(installation: Option<String>, servers: Vec<Server>) -> CmdResult<()> {
    let dir = game_dir(installation.as_deref())?;
    let p = dir.join("servers.dat");
    if servers.iter().any(|s| s.ip.trim().is_empty()) {
        return Err("every server needs an address".into());
    }
    if p.exists() {
        fs::copy(&p, dir.join("servers.dat_old")).map_err(err)?;
    }
    fs::write(&p, servers_nbt(&servers)).map_err(err)
}

/// Swaps servers.dat and servers.dat_old, so a restore can itself be undone.
#[tauri::command(async)]
fn restore_servers_backup(installation: Option<String>) -> CmdResult<()> {
    let dir = game_dir(installation.as_deref())?;
    let (cur, old, tmp) = (
        dir.join("servers.dat"),
        dir.join("servers.dat_old"),
        dir.join("servers.dat_mim_swap"),
    );
    if !old.exists() {
        return Err("no backup to restore".into());
    }
    if cur.exists() {
        fs::rename(&cur, &tmp).map_err(err)?;
    }
    fs::rename(&old, &cur).map_err(err)?;
    if tmp.exists() {
        fs::rename(&tmp, &old).map_err(err)?;
    }
    Ok(())
}

#[derive(Serialize)]
struct Ping {
    online: i64,
    max: i64,
    version: String,
    motd: String,
    latency_ms: u128,
    favicon: Option<String>,
}

fn put_varint(mut v: u32, b: &mut Vec<u8>) {
    loop {
        if v & !0x7f == 0 {
            b.push(v as u8);
            return;
        }
        b.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    }
}

fn read_varint(r: &mut impl std::io::Read) -> std::io::Result<u32> {
    let mut v = 0u32;
    for i in 0..5 {
        let mut x = [0u8];
        r.read_exact(&mut x)?;
        v |= ((x[0] & 0x7f) as u32) << (7 * i);
        if x[0] & 0x80 == 0 {
            return Ok(v);
        }
    }
    Err(std::io::Error::other("bad varint"))
}

/// Chat component → plain text, without § formatting codes.
fn plain_text(v: &Value) -> String {
    let raw = match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(plain_text).collect(),
        Value::Object(o) => {
            let mut s = o.get("text").map(plain_text).unwrap_or_default();
            if let Some(Value::Array(extra)) = o.get("extra") {
                s.extend(extra.iter().map(plain_text));
            }
            s
        }
        _ => String::new(),
    };
    let mut out = String::new();
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c == '§' {
            chars.next();
        } else {
            out.push(c);
        }
    }
    out
}

/// Server List Ping (what the multiplayer screen does).
// ponytail: no SRV lookup, so servers that rely on SRV records show offline
fn ping(address: &str) -> std::io::Result<Ping> {
    use std::io::{Read, Write};
    use std::net::ToSocketAddrs;
    use std::time::{Duration, Instant};
    let address = address.trim();
    let (host, port) = match address.rsplit_once(':') {
        Some((h, p)) if p.parse::<u16>().is_ok() => (h, p.parse().unwrap()),
        _ => (address, 25565),
    };
    let addr = (host, port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| std::io::Error::other("no address"))?;
    let start = Instant::now();
    let mut s = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(3))?;
    s.set_read_timeout(Some(Duration::from_secs(3)))?;
    s.set_write_timeout(Some(Duration::from_secs(3)))?;

    let mut body = vec![0x00];
    put_varint(767, &mut body);
    put_varint(host.len() as u32, &mut body);
    body.extend(host.as_bytes());
    body.extend(port.to_be_bytes());
    put_varint(1, &mut body);
    let mut pkt = vec![];
    put_varint(body.len() as u32, &mut pkt);
    pkt.extend(body);
    pkt.extend([1, 0]); // status request
    s.write_all(&pkt)?;

    read_varint(&mut s)?; // packet length
    read_varint(&mut s)?; // packet id
    let n = read_varint(&mut s)? as usize;
    if n > 1 << 20 {
        return Err(std::io::Error::other("response too large"));
    }
    let mut buf = vec![0; n];
    s.read_exact(&mut buf)?;
    let latency_ms = start.elapsed().as_millis();
    let v: Value = serde_json::from_slice(&buf)?;
    Ok(Ping {
        online: v["players"]["online"].as_i64().unwrap_or(0),
        max: v["players"]["max"].as_i64().unwrap_or(0),
        version: plain_text(&v["version"]["name"]),
        motd: plain_text(&v["description"]),
        favicon: v["favicon"].as_str().map(String::from),
        latency_ms,
    })
}

#[tauri::command(async)]
fn ping_server(address: String) -> CmdResult<Ping> {
    ping(&address).map_err(err)
}

// ---------------------------------------------------------------------------
// Worlds: import / back up
// ---------------------------------------------------------------------------

fn find_world(dir: &Path) -> Option<PathBuf> {
    if dir.join("level.dat").exists() {
        return Some(dir.to_path_buf());
    }
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.join("level.dat").exists())
}

/// Copies a world folder or .zip into a saves folder. Returns the new folder name.
#[tauri::command(async)]
fn import_world(source: String, installation: Option<String>) -> CmdResult<String> {
    let saves = game_dir(installation.as_deref())?.join("saves");
    fs::create_dir_all(&saves).map_err(err)?;
    let src = PathBuf::from(&source);
    let stem = src.file_stem().unwrap_or_default().to_string_lossy().to_string();

    let tmp = std::env::temp_dir().join(format!("mim-import-{}", uuid::Uuid::new_v4()));
    let world = if src.is_dir() {
        find_world(&src)
    } else {
        let ok = std::process::Command::new("ditto")
            .args(["-x", "-k"])
            .arg(&src)
            .arg(&tmp)
            .status()
            .map_err(err)?
            .success();
        if !ok {
            return Err("couldn't unzip that file".into());
        }
        find_world(&tmp)
    };
    let result = match world {
        None => Err("no level.dat found — that isn't a Minecraft world".into()),
        Some(w) => {
            let name = if w == tmp || w == src {
                stem
            } else {
                w.file_name().unwrap_or_default().to_string_lossy().into()
            };
            let dest = free_path(&saves, &name);
            copy_recursive(&w, &dest).map_err(err)?;
            Ok(dest.file_name().unwrap_or_default().to_string_lossy().into())
        }
    };
    let _ = fs::remove_dir_all(&tmp);
    result
}

#[tauri::command(async)]
fn backup_world(path: String, dest: String) -> CmdResult<()> {
    let world = inside_mc(&path)?;
    if !world.join("level.dat").exists() {
        return Err("not a world".into());
    }
    let ok = std::process::Command::new("ditto")
        .args(["-c", "-k", "--sequesterRsrc", "--keepParent"])
        .arg(&world)
        .arg(&dest)
        .status()
        .map_err(err)?
        .success();
    if ok {
        Ok(())
    } else {
        Err("zipping the world failed".into())
    }
}

/// Moves a world, mod, or screenshot to the Trash — nothing else.
#[tauri::command(async)]
fn trash_item(path: String) -> CmdResult<()> {
    let p = inside_mc(&path)?;
    let parent = p
        .parent()
        .and_then(|d| d.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if !["saves", "mods", "screenshots"].contains(&parent.as_str()) {
        return Err("MIM only trashes worlds, mods and screenshots".into());
    }
    trash::delete(&p).map_err(err)
}

// ---------------------------------------------------------------------------
// Mods — a tiny zip reader so we can look inside jars without a new dependency
// ---------------------------------------------------------------------------

/// Reads the entries `want` accepts out of a zip (stored or deflated; no zip64).
fn zip_read(path: &Path, want: &dyn Fn(&str) -> bool) -> Vec<(String, Vec<u8>)> {
    use std::io::{Read, Seek, SeekFrom};
    let le16 = |b: &[u8], i: usize| u16::from_le_bytes([b[i], b[i + 1]]) as usize;
    let le32 = |b: &[u8], i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as u64;
    let mut out = vec![];
    let Ok(mut f) = fs::File::open(path) else { return out };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let tail_len = len.min(65_557);
    let mut tail = vec![0; tail_len as usize];
    if f.seek(SeekFrom::End(-(tail_len as i64))).is_err() || f.read_exact(&mut tail).is_err() {
        return out;
    }
    let Some(e) = tail.windows(4).rposition(|w| w == [0x50, 0x4b, 0x05, 0x06]) else {
        return out;
    };
    if tail.len() < e + 22 {
        return out;
    }
    let (cd_size, cd_off) = (le32(&tail, e + 12), le32(&tail, e + 16));
    if cd_off + cd_size > len {
        return out;
    }
    let mut cd = vec![0; cd_size as usize];
    if f.seek(SeekFrom::Start(cd_off)).is_err() || f.read_exact(&mut cd).is_err() {
        return out;
    }
    let mut i = 0;
    while i + 46 <= cd.len() && cd[i..i + 4] == [0x50, 0x4b, 0x01, 0x02] {
        let method = le16(&cd, i + 10);
        let csize = le32(&cd, i + 20);
        let (nlen, xlen, clen) = (le16(&cd, i + 28), le16(&cd, i + 30), le16(&cd, i + 32));
        let lho = le32(&cd, i + 42);
        let Some(name_bytes) = cd.get(i + 46..i + 46 + nlen) else { break };
        let name = String::from_utf8_lossy(name_bytes).to_string();
        i += 46 + nlen + xlen + clen;
        if !want(&name) || csize > 16 << 20 {
            continue;
        }
        let mut lh = [0u8; 30];
        if f.seek(SeekFrom::Start(lho)).is_err() || f.read_exact(&mut lh).is_err() {
            continue;
        }
        let skip = 30 + le16(&lh, 26) + le16(&lh, 28);
        let mut data = vec![0; csize as usize];
        if f.seek(SeekFrom::Start(lho + skip as u64)).is_err() || f.read_exact(&mut data).is_err() {
            continue;
        }
        let bytes = match method {
            0 => data,
            8 => {
                let mut v = vec![];
                if flate2::read::DeflateDecoder::new(&data[..])
                    .take(32 << 20)
                    .read_to_end(&mut v)
                    .is_err()
                {
                    continue;
                }
                v
            }
            _ => continue,
        };
        out.push((name, bytes));
    }
    out
}

#[derive(Serialize)]
struct Mod {
    file: String,
    path: String,
    enabled: bool,
    id: Option<String>,
    name: String,
    version: Option<String>,
    description: Option<String>,
    authors: Vec<String>,
    loader: Option<&'static str>,
    icon: Option<String>,
    size_bytes: u64,
}

const MOD_META: [&str; 4] = [
    "fabric.mod.json",
    "quilt.mod.json",
    "META-INF/mods.toml",
    "META-INF/neoforge.mods.toml",
];

/// First `key = "value"` in a mods.toml (good enough for display fields).
fn toml_field(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|l| {
        let (k, v) = l.split_once('=')?;
        if k.trim() != key {
            return None;
        }
        let v = v.trim().trim_matches(|c| c == '"' || c == '\'').trim();
        (!v.is_empty() && !v.starts_with("${")).then(|| v.to_string())
    })
}

fn read_mod(path: &Path) -> Mod {
    let file = path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let mut m = Mod {
        name: file.trim_end_matches(".disabled").trim_end_matches(".jar").into(),
        enabled: !file.ends_with(".disabled"),
        size_bytes: fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        path: path.to_string_lossy().into(),
        file,
        id: None,
        version: None,
        description: None,
        authors: vec![],
        loader: None,
        icon: None,
    };
    let metas = zip_read(path, &|n| MOD_META.contains(&n));
    let mut icon_path = None;
    if let Some((_, b)) = metas.iter().find(|(n, _)| n.ends_with(".json")) {
        let v: Value = serde_json::from_slice(b).unwrap_or(Value::Null);
        let quilt = v.get("quilt_loader").is_some();
        let meta = if quilt { &v["quilt_loader"]["metadata"] } else { &v };
        let root = if quilt { &v["quilt_loader"] } else { &v };
        m.loader = Some(if quilt { "quilt" } else { "fabric" });
        m.id = root["id"].as_str().map(String::from);
        m.version = root["version"].as_str().map(String::from);
        if let Some(n) = meta["name"].as_str() {
            m.name = n.into();
        }
        m.description = meta["description"].as_str().map(String::from);
        let people = if quilt { &meta["contributors"] } else { &v["authors"] };
        m.authors = match people {
            Value::Array(a) => a
                .iter()
                .filter_map(|p| p.as_str().or(p["name"].as_str()).map(String::from))
                .collect(),
            Value::Object(o) => o.keys().cloned().collect(),
            _ => vec![],
        };
        // icon is a path, or {"16": path, "128": path} — take the biggest
        icon_path = match &meta["icon"] {
            Value::String(s) => Some(s.clone()),
            Value::Object(o) => o
                .iter()
                .max_by_key(|(k, _)| k.parse::<u32>().unwrap_or(0))
                .and_then(|(_, v)| v.as_str().map(String::from)),
            _ => None,
        };
    } else if let Some((n, b)) = metas.first() {
        let t = String::from_utf8_lossy(b);
        m.loader = Some(if n.contains("neoforge") { "neoforge" } else { "forge" });
        m.id = toml_field(&t, "modId");
        m.version = toml_field(&t, "version");
        if let Some(d) = toml_field(&t, "displayName") {
            m.name = d;
        }
        m.description = toml_field(&t, "description");
        m.authors = toml_field(&t, "authors").into_iter().collect();
        icon_path = toml_field(&t, "logoFile");
    }
    if let Some(ip) = icon_path {
        let ip = ip.trim_start_matches('/').to_string();
        if let Some((_, b)) = zip_read(path, &|n| n == ip).first() {
            m.icon = Some(data_url_from_png(b));
        }
    }
    m
}

fn mods_dir(installation: Option<&str>) -> CmdResult<PathBuf> {
    Ok(game_dir(installation)?.join("mods"))
}

#[tauri::command(async)]
fn list_mods(installation: Option<String>) -> CmdResult<Vec<Mod>> {
    let dir = mods_dir(installation.as_deref())?;
    let jars: Vec<PathBuf> = fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    let n = p.to_string_lossy();
                    n.ends_with(".jar") || n.ends_with(".jar.disabled")
                })
                .collect()
        })
        .unwrap_or_default();
    let mut mods = par_map(&jars, |p| read_mod(p));
    mods.sort_by_key(|m| m.name.to_lowercase());
    Ok(mods)
}

/// Enables/disables a mod the way launchers do: foo.jar <-> foo.jar.disabled.
#[tauri::command(async)]
fn toggle_mod(path: String) -> CmdResult<String> {
    let p = inside_mc(&path)?;
    if p.parent().and_then(|d| d.file_name()).is_none_or(|n| n != "mods") {
        return Err("not a mod".into());
    }
    let s = p.to_string_lossy().to_string();
    let next = match s.strip_suffix(".disabled") {
        Some(enabled) => PathBuf::from(enabled),
        None if s.ends_with(".jar") => PathBuf::from(format!("{s}.disabled")),
        None => return Err("not a jar".into()),
    };
    if next.exists() {
        return Err("a file with that name already exists".into());
    }
    fs::rename(&p, &next).map_err(err)?;
    Ok(next.to_string_lossy().into())
}

#[tauri::command(async)]
fn add_mods(installation: Option<String>, files: Vec<String>) -> CmdResult<usize> {
    let dir = mods_dir(installation.as_deref())?;
    fs::create_dir_all(&dir).map_err(err)?;
    let mut n = 0;
    for f in files {
        let src = PathBuf::from(&f);
        let name = src.file_name().unwrap_or_default().to_string_lossy().to_string();
        if !name.ends_with(".jar") {
            continue;
        }
        fs::copy(&src, free_path(&dir, &name)).map_err(err)?;
        n += 1;
    }
    Ok(n)
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct Screenshot {
    path: String,
    name: String,
    location: String,
    modified: Option<String>,
    size_bytes: u64,
}

#[tauri::command(async)]
fn list_screenshots() -> Vec<Screenshot> {
    let mut dirs = vec![("Shared".to_string(), mc_dir().join("screenshots"))];
    for name in installation_names() {
        let d = installations_dir().join(&name).join("screenshots");
        if d.is_dir() && !d.is_symlink() {
            dirs.push((name, d));
        }
    }
    let mut out = vec![];
    for (loc, d) in dirs {
        for e in fs::read_dir(&d).into_iter().flatten().flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.to_lowercase().ends_with(".png") {
                continue;
            }
            let meta = e.metadata().ok();
            out.push(Screenshot {
                path: e.path().to_string_lossy().into(),
                location: loc.clone(),
                size_bytes: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: meta.and_then(|m| m.modified().ok()).map(|t| {
                    chrono::DateTime::<chrono::Utc>::from(t)
                        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
                }),
                name,
            });
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // runs against a throwaway sample folder, never the real minecraft dir
    #[test]
    fn cleanup_on_sample_folder() {
        let root = std::env::temp_dir().join(format!("mim-test-{}", uuid::Uuid::new_v4()));
        let touch = |rel: &str| {
            let p = root.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, rel).unwrap();
        };
        for f in [
            "hs_err_pid42452.log",
            "launcher_log.txt",
            "launcher_cef_log.txt",
            "nativeUpdaterLog3.txt",
            "launcher_profiles.json",
            "options.txt",
            "logs/latest.log",
            "logs/launcher/launcher_log.txt", // forces a rename on collision
            "crash-reports/crash-1.txt",
            "debug/disconnect-client.txt",
            "downloads/log.json",
            "webcache2/blob",
            "usercache.json",
        ] {
            touch(f);
        }

        assert_eq!(list_logs_in(&root).iter().filter(|l| !l.sorted).count(), 4);
        assert_eq!(sort_logs_in(&root).unwrap(), 4);
        for f in [
            "logs/old/hs_err_pid42452.log",
            "logs/launcher/launcher_log-1.txt",
            "logs/launcher/launcher_cef_log.txt",
            "logs/updater/nativeUpdaterLog3.txt",
            "launcher_profiles.json",
            "options.txt",
        ] {
            assert!(root.join(f).exists(), "{f} missing");
        }
        assert!(!root.join("launcher_log.txt").exists());

        let logs = list_logs_in(&root);
        assert!(logs.iter().all(|l| l.sorted));
        let kind = |n: &str| logs.iter().find(|l| l.name == n).unwrap().kind;
        assert_eq!(kind("hs_err_pid42452.log"), "crash");
        assert_eq!(kind("crash-1.txt"), "crash");
        assert_eq!(kind("launcher_cef_log.txt"), "launcher");
        assert_eq!(kind("nativeUpdaterLog3.txt"), "updater");
        assert_eq!(kind("latest.log"), "game");
        assert_eq!(kind("disconnect-client.txt"), "debug");

        let names = |cat| -> Vec<String> {
            root_entries(&root, cat)
                .iter()
                .map(|p| p.file_name().unwrap().to_string_lossy().into())
                .collect()
        };
        assert_eq!(names("logs"), ["crash-reports", "debug", "logs"]);
        assert_eq!(names("cache"), ["downloads", "usercache.json", "webcache2"]);
        assert_eq!(names("launcher"), ["launcher_profiles.json"]);
        assert_eq!(names("yours"), ["options.txt"]);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reads_level_dat() {
        use std::io::Write;
        let s = |b: &mut Vec<u8>, t: &str| {
            b.extend((t.len() as u16).to_be_bytes());
            b.extend(t.as_bytes());
        };
        // {"": {Data: {LevelName: "Test", LastPlayed: 1700000000000L,
        //   Version: {Name: "1.21.10"}, WorldGenSettings: {seed: -42L}, ids: [I; 1, 2]}}}
        let mut b = vec![10];
        s(&mut b, "");
        b.push(10);
        s(&mut b, "Data");
        b.push(8);
        s(&mut b, "LevelName");
        s(&mut b, "Test");
        b.push(4);
        s(&mut b, "LastPlayed");
        b.extend(1_700_000_000_000i64.to_be_bytes());
        b.push(11);
        s(&mut b, "ids");
        b.extend(2i32.to_be_bytes());
        b.extend([0, 0, 0, 1, 0, 0, 0, 2]);
        b.push(10);
        s(&mut b, "Version");
        b.push(8);
        s(&mut b, "Name");
        s(&mut b, "1.21.10");
        b.push(0);
        b.push(10);
        s(&mut b, "WorldGenSettings");
        b.push(4);
        s(&mut b, "seed");
        b.extend((-42i64).to_be_bytes());
        b.extend([0, 0, 0]);

        let dir = std::env::temp_dir().join(format!("mim-world-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let mut gz = flate2::write::GzEncoder::new(
            fs::File::create(dir.join("level.dat")).unwrap(),
            flate2::Compression::default(),
        );
        gz.write_all(&b).unwrap();
        gz.finish().unwrap();

        let w = read_world(&dir, "Shared");
        assert_eq!(w.name, "Test");
        assert_eq!(w.last_played, Some(1_700_000_000_000));
        assert_eq!(w.version.as_deref(), Some("1.21.10"));
        assert_eq!(w.seed.as_deref(), Some("-42"));
        fs::remove_dir_all(&dir).unwrap();
    }

    /// `python3 scripts/seed_sample.py && cargo test -- --ignored`
    #[test]
    #[ignore]
    fn reads_seeded_sample() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../sample-minecraft");
        let mut names: Vec<_> = world_dirs(&root)
            .iter()
            .map(|(loc, p)| format!("{loc}: {}", read_world(p, loc).name))
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "Shared: Build Plot",
                "Shared: HARDCORE ATTEMPT 3",
                "Shared: Survival Base",
                "Survival 1.21.4: Old Survival",
            ]
        );
        assert_eq!(names_in(&root.join("installations")).len(), 3);

        let servers = read_servers(&root.join("servers.dat"));
        assert_eq!(servers.len(), 4);
        assert!(servers[0].icon.is_some());
        assert_eq!(read_servers(&root.join("servers.dat_old")).len(), 3);

        let mods = root.join("installations/Create Modpack/mods");
        let jei = read_mod(&mods.join("jei-1.21.1-forge-19.21.jar"));
        assert_eq!((jei.name.as_str(), jei.loader), ("Just Enough Items", Some("forge")));
        assert!(jei.icon.is_some());
        let z = read_mod(&root.join("installations/Hypixel 1.21.10/mods/zoomify-2.14.jar.disabled"));
        assert_eq!((z.name.as_str(), z.enabled), ("Zoomify", false));
    }

    #[test]
    fn servers_round_trip() {
        let servers = vec![
            Server {
                name: "Hypixel".into(),
                ip: "mc.hypixel.net".into(),
                icon: Some("aWNvbg==".into()),
                accept_textures: Some(1),
                hidden: false,
            },
            Server {
                name: "Local".into(),
                ip: "localhost:25566".into(),
                icon: None,
                accept_textures: None,
                hidden: true,
            },
        ];
        let p = std::env::temp_dir().join(format!("mim-servers-{}.dat", uuid::Uuid::new_v4()));
        fs::write(&p, servers_nbt(&servers)).unwrap();
        assert_eq!(read_servers(&p), servers);
        fs::write(&p, servers_nbt(&[])).unwrap();
        assert_eq!(read_servers(&p), vec![]);
        fs::remove_file(&p).unwrap();
    }

    #[test]
    fn reads_mod_metadata_from_jar() {
        let dir = std::env::temp_dir().join(format!("mim-mod-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::write(
            dir.join("fabric.mod.json"),
            r#"{"id":"sodium","name":"Sodium","version":"0.6.0","authors":["jellysquid",{"name":"IMS"}],"icon":{"16":"assets/s.png","128":"assets/b.png"}}"#,
        )
        .unwrap();
        fs::write(dir.join("assets/b.png"), b"big").unwrap();
        fs::write(dir.join("big.txt"), "x".repeat(5000)).unwrap(); // deflated entry
        let jar = dir.join("sodium.jar");
        let ok = std::process::Command::new("zip")
            .current_dir(&dir)
            .args(["-q", "-r", "sodium.jar", "fabric.mod.json", "assets", "big.txt"])
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let m = read_mod(&jar);
        assert_eq!(m.name, "Sodium");
        assert_eq!(m.version.as_deref(), Some("0.6.0"));
        assert_eq!(m.authors, ["jellysquid", "IMS"]);
        assert_eq!(m.loader, Some("fabric"));
        assert_eq!(m.icon.as_deref(), Some(data_url_from_png(b"big").as_str()));
        let big = zip_read(&jar, &|n| n == "big.txt");
        assert_eq!(big[0].1.len(), 5000);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn mods_toml_fields() {
        let t = "modLoader=\"javafml\"\n[[mods]]\nmodId=\"create\"\nversion=\"${file.jarVersion}\"\ndisplayName=\"Create\"\n";
        assert_eq!(toml_field(t, "modId").as_deref(), Some("create"));
        assert_eq!(toml_field(t, "version"), None);
        assert_eq!(toml_field(t, "displayName").as_deref(), Some("Create"));
    }

    #[test]
    fn pings_a_fake_server() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut c, _) = listener.accept().unwrap();
            let len = read_varint(&mut c).unwrap(); // handshake
            let mut hs = vec![0; len as usize];
            c.read_exact(&mut hs).unwrap();
            let mut req = [0u8; 2]; // status request
            c.read_exact(&mut req).unwrap();
            assert_eq!(req, [1, 0]);
            let json = br#"{"version":{"name":"1.21.10"},"players":{"online":3,"max":20},"description":"\u00a7bHi"}"#;
            let mut body = vec![0x00];
            put_varint(json.len() as u32, &mut body);
            body.extend(json);
            let mut pkt = vec![];
            put_varint(body.len() as u32, &mut pkt);
            pkt.extend(body);
            c.write_all(&pkt).unwrap();
        });
        let p = ping(&format!("127.0.0.1:{port}")).unwrap();
        assert_eq!((p.online, p.max), (3, 20));
        assert_eq!(p.version, "1.21.10");
        assert_eq!(p.motd, "Hi");
    }

    #[test]
    fn motd_plain_text() {
        let v: Value = serde_json::from_str(r#"{"text":"§aHypixel ","extra":[{"text":"Network"},"!"]}"#).unwrap();
        assert_eq!(plain_text(&v), "Hypixel Network!");
    }

    #[test]
    fn options_keep_colons_in_values() {
        let o = parse_options("fov:0.5\nresourcePacks:[\"file/a:b.zip\"]\n\n");
        assert_eq!(o[1], ("resourcePacks".into(), "[\"file/a:b.zip\"]".into()));
        assert_eq!(o.len(), 2);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // screenshots load straight from disk, but only from the minecraft folder
            use tauri::Manager;
            let _ = app.asset_protocol_scope().allow_directory(mc_dir(), true);
            Ok(())
        })
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
            minecraft_dir,
            list_logs,
            sort_logs,
            read_log,
            purge_logs,
            folder_overview,
            list_saves,
            world_details,
            options_sources,
            read_options,
            write_options,
            list_servers,
            write_servers,
            restore_servers_backup,
            ping_server,
            import_world,
            backup_world,
            trash_item,
            list_mods,
            toggle_mod,
            add_mods,
            list_screenshots,
            purge_cache
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
