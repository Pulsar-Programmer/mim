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
    // where the official launcher keeps it on each OS
    if cfg!(windows) {
        dirs::config_dir().expect("no AppData").join(".minecraft") // %APPDATA%\.minecraft
    } else if cfg!(target_os = "macos") {
        dirs::data_dir().expect("no data dir").join("minecraft") // ~/Library/Application Support/minecraft
    } else {
        dirs::home_dir().expect("no home dir").join(".minecraft")
    }
}

/// A subprocess that doesn't flash a console window on Windows.
fn command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

/// Symlinks `dst` to `src` (relative targets resolve from `dst`'s folder).
#[cfg(unix)]
fn symlink(src: impl AsRef<Path>, dst: impl AsRef<Path>) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst)
}

/// Windows needs Developer Mode (or admin) for real symlinks; folders fall
/// back to junctions, which need neither. Files have no such fallback.
#[cfg(windows)]
fn symlink(src: impl AsRef<Path>, dst: impl AsRef<Path>) -> std::io::Result<()> {
    use std::os::windows::fs::{symlink_dir, symlink_file};
    let (src, dst) = (PathBuf::from(src.as_ref().to_string_lossy().replace('/', "\\")), dst.as_ref());
    let resolved = dst.parent().map_or(src.clone(), |d| d.join(&src));
    if !resolved.is_dir() {
        return symlink_file(&src, dst).map_err(|e| {
            std::io::Error::new(e.kind(), format!("{e} — turn on Developer Mode in Windows Settings so MIM can link files"))
        });
    }
    if symlink_dir(&src, dst).is_ok() {
        return Ok(());
    }
    let ok = command("cmd").arg("/C").arg("mklink").arg("/J").arg(dst).arg(&resolved).status()?.success();
    ok.then_some(()).ok_or_else(|| std::io::Error::other(format!("couldn't link {}", dst.display())))
}

/// Removes a symlink or junction itself, never what it points at. (Windows
/// removes links to folders with remove_dir.)
fn remove_link(p: &Path) -> std::io::Result<()> {
    fs::remove_file(p).or_else(|_| fs::remove_dir(p))
}

/// `p` as a "/"-separated string, the form the frontend and rel paths use.
fn slash_path(p: &Path) -> String {
    p.iter().map(|c| c.to_string_lossy()).collect::<Vec<_>>().join("/")
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

fn read_profiles() -> CmdResult<Value> {
    read_profiles_in(&mc_dir())
}

fn write_profiles(v: &Value) -> CmdResult<()> {
    write_profiles_in(&mc_dir(), v)
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
    if let Some(v) = version_id.strip_prefix("neoforge-") {
        return ("neoforge".into(), neoforge_game(v));
    }
    if version_id.to_lowercase().contains("forge") {
        // "1.20.1-forge-47.2.0"
        let game = version_id.split('-').next().unwrap_or(version_id);
        return ("forge".into(), game.into());
    }
    ("vanilla".into(), version_id.into())
}

/// NeoForge numbers its builds after the game: 21.1.77 is for 1.21.1, 21.0.x
/// for 1.21, and since the year-based versions 26.1.0.x is for 26.1.
fn neoforge_game(neo: &str) -> String {
    let p: Vec<&str> = neo.split(['.', '-']).collect();
    let year_based = p[0].parse::<u32>().is_ok_and(|n| n >= 25);
    match (year_based, p.as_slice()) {
        (true, [y, m, "0", ..]) => format!("{y}.{m}"),
        (true, [y, m, patch, ..]) => format!("{y}.{m}.{patch}"),
        (false, [a, "0", ..]) => format!("1.{a}"),
        (false, [a, b, ..]) => format!("1.{a}.{b}"),
        _ => neo.into(),
    }
}

/// The start every NeoForge build for `game` shares: "1.21.1" -> "21.1.", "26.1" -> "26.1.0.".
fn neoforge_prefix(game: &str) -> String {
    let p: Vec<&str> = game.split('.').collect();
    match p.as_slice() {
        ["1", a] => format!("{a}.0."),
        ["1", a, b] => format!("{a}.{b}."),
        [y, m] => format!("{y}.{m}.0."),
        [y, m, patch] => format!("{y}.{m}.{patch}."),
        _ => format!("{game}."),
    }
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

/// Loader versions for a game version, newest first. Forge marks its
/// recommended build as stable.
#[tauri::command]
async fn list_loader_versions(loader: String, game_version: String) -> CmdResult<Vec<LoaderVersion>> {
    match loader.as_str() {
        "forge" => return forge_versions(&game_version).await,
        "neoforge" => return neoforge_versions(&game_version).await,
        _ => {}
    }
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

const FORGE_MAVEN: &str = "https://maven.minecraftforge.net/net/minecraftforge/forge";

async fn forge_versions(game: &str) -> CmdResult<Vec<LoaderVersion>> {
    let promos = send_json(
        http().get("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json"),
    )
    .await?;
    let recommended = promos["promos"][format!("{game}-recommended")].as_str().map(String::from);
    let xml = http()
        .get(format!("{FORGE_MAVEN}/maven-metadata.xml"))
        .send()
        .await
        .map_err(err)?
        .text()
        .await
        .map_err(err)?;
    let mut vs: Vec<String> = forge_list(&xml, game);
    vs.sort_by_key(|v| std::cmp::Reverse(v.split('.').map(|n| n.parse::<u32>().unwrap_or(0)).collect::<Vec<_>>()));
    Ok(vs
        .into_iter()
        .map(|v| LoaderVersion { stable: recommended.as_ref() == Some(&v), version: v })
        .collect())
}

const NEO_MAVEN: &str = "https://maven.neoforged.net/releases/net/neoforged/neoforge";

async fn neoforge_versions(game: &str) -> CmdResult<Vec<LoaderVersion>> {
    let list = send_json(
        http().get("https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge"),
    )
    .await?;
    let prefix = neoforge_prefix(game);
    let mut vs: Vec<String> = strs(&list["versions"]).into_iter().filter(|v| v.starts_with(&prefix)).collect();
    vs.sort_by_key(|v| {
        std::cmp::Reverse(v.split(['.', '-']).map(|n| n.parse::<u32>().unwrap_or(0)).collect::<Vec<_>>())
    });
    Ok(vs
        .into_iter()
        .map(|v| LoaderVersion { stable: !v.contains("beta"), version: v })
        .collect())
}

/// Forge builds for `game` out of maven-metadata.xml ("1.20.1-47.2.0" -> "47.2.0").
fn forge_list(xml: &str, game: &str) -> Vec<String> {
    xml.split(&format!("<version>{game}-"))
        .skip(1)
        .filter_map(|s| s.split('<').next())
        .filter(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit() || c == '.'))
        .map(String::from)
        .collect()
}

/// The newest Java the Minecraft launcher downloaded for itself, else `java` on PATH.
fn find_java() -> Option<PathBuf> {
    let mut javas = vec![];
    for root in [Some(mc_dir()), dirs::data_dir().map(|d| d.join("minecraft"))].into_iter().flatten() {
        let mut files = vec![];
        walk_files(&root.join("runtime"), &mut files);
        javas.extend(files.into_iter().filter(|f| f.ends_with("bin/java") || f.ends_with("bin/java.exe")));
    }
    // each runtime's Home has a `release` file with JAVA_VERSION="21.0.3"
    let major = |java: &PathBuf| {
        let release = fs::read_to_string(java.parent()?.parent()?.join("release")).ok()?;
        let v = release.lines().find_map(|l| l.strip_prefix("JAVA_VERSION=\""))?;
        v.split(['.', '"']).next()?.parse::<u32>().ok()
    };
    javas
        .into_iter()
        .filter_map(|j| Some((major(&j)?, j)))
        .max_by_key(|(m, _)| *m)
        .map(|(_, j)| j)
        .or_else(|| {
            let ok = command("java").arg("-version").output().is_ok_and(|o| o.status.success());
            ok.then(|| "java".into())
        })
}

/// Runs Forge's or NeoForge's own installer headless against the minecraft
/// folder; returns the launcher version id it made, e.g. "1.20.1-forge-47.2.0".
async fn install_forge(loader: &str, game: &str, ver: &str, p: &Progress) -> CmdResult<String> {
    let (name, url) = if loader == "neoforge" {
        ("NeoForge", format!("{NEO_MAVEN}/{ver}/neoforge-{ver}-installer.jar"))
    } else {
        let full = format!("{game}-{ver}");
        ("Forge", format!("{FORGE_MAVEN}/{full}/forge-{full}-installer.jar"))
    };
    let jar = std::env::temp_dir().join(format!("mim-{loader}-{game}-{ver}-installer.jar"));
    p.say(format!("Downloading {name} {ver}"));
    download(&url, None, &jar).await?;
    let id = zip_read(&jar, &|n| n == "install_profile.json")
        .first()
        .and_then(|(_, b)| serde_json::from_slice::<Value>(b).ok())
        .and_then(|v| v["version"].as_str().map(String::from))
        .ok_or(format!("This {name} version is too old for MIM to install"))?;
    let mc = mc_dir();
    if !mc.join("versions").join(&id).join(format!("{id}.json")).exists() {
        let java = find_java().ok_or("Couldn't find Java — open the Minecraft launcher once so it downloads its own")?;
        let before = read_profiles()?;
        let (jar2, app) = (jar.clone(), p.app.clone());
        let res = tauri::async_runtime::spawn_blocking(move || run_forge_installer(name, &java, &jar2, &mc, app))
            .await
            .map_err(err)?;
        // the installer adds its own profile; MIM registers a named one instead
        let mut after = read_profiles()?;
        after["profiles"] = before["profiles"].clone();
        write_profiles(&after)?;
        res?;
    }
    let _ = fs::remove_file(&jar);
    let _ = fs::remove_file(jar.with_extension("jar.log"));
    Ok(id)
}

fn run_forge_installer(name: &str, java: &Path, jar: &Path, mc: &Path, app: Option<tauri::AppHandle>) -> CmdResult<()> {
    use std::io::BufRead;
    let p = Progress::new(app);
    let mut child = command(java)
        .arg("-jar")
        .arg(jar)
        .arg("--installClient")
        .arg(mc)
        .current_dir(std::env::temp_dir())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(err)?;
    let out = child.stdout.take().ok_or("no installer output")?;
    let mut last = std::time::Instant::now();
    let mut tail = String::new();
    for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
        // it prints thousands of lines; a few updates a second is plenty
        if last.elapsed().as_millis() > 120 {
            p.say(format!("{name}: {}", line.trim()));
            last = std::time::Instant::now();
        }
        tail = line;
    }
    if child.wait().map_err(err)?.success() {
        Ok(())
    } else {
        Err(format!("{name}'s installer failed: {tail}"))
    }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct InstallSpec {
    name: String,
    game_version: String,
    /// "vanilla", "fabric", "forge" or "neoforge"
    loader: String,
    loader_version: Option<String>,
    standards: Vec<String>,
}

#[tauri::command]
async fn create_installation(app: tauri::AppHandle, spec: InstallSpec) -> CmdResult<()> {
    create_in(spec, &Progress::new(Some(app))).await
}

async fn create_in(spec: InstallSpec, p: &Progress) -> CmdResult<()> {
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

    // resolve the launcher version id
    let version_id = if spec.loader == "forge" || spec.loader == "neoforge" {
        let ver = match spec.loader_version {
            Some(v) => v,
            None => {
                let vs = list_loader_versions(spec.loader.clone(), spec.game_version.clone()).await?;
                vs.iter().find(|l| l.stable).or(vs.first()).ok_or("no loader build for this version")?.version.clone()
            }
        };
        match install_forge(&spec.loader, &spec.game_version, &ver, p).await {
            Ok(id) => id,
            Err(e) => {
                let _ = fs::remove_dir(&inst); // still empty
                return Err(e);
            }
        }
    } else if spec.loader == "fabric" {
        let loader = match spec.loader_version {
            Some(v) => v,
            None => {
                let loaders = list_loader_versions("fabric".into(), spec.game_version.clone()).await?;
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

    // linked from the picked standards (the built-in Shared one covers saves & co.)
    let pairs = spec
        .standards
        .iter()
        .map(|r| entry_src(r))
        .collect::<CmdResult<Vec<_>>>()?;
    link_entries(&inst, &pairs, true)?;
    for rel in &spec.standards {
        match rel.split_once('/') {
            Some((std_name, _)) if std_name != SHARED => add_link(&standard_dir(std_name)?, name)?,
            _ => {}
        }
    }

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
        "icon": if spec.loader.contains("forge") { "Furnace" } else { "Grass" },
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
        symlink(&target, &link).map_err(err)?;
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
    rel_path: String, // relative to standards/, starts with the standard's name
    scope: String,    // "global" or a game version like "1.21.10"
    is_dir: bool,
}

/// One named folder in `standards/`, plus the installations linked to it.
#[derive(Serialize)]
struct Standard {
    name: String,
    path: String,
    /// the Minecraft folder's own shared folders, always there
    builtin: bool,
    installations: Vec<String>,
    /// installation -> how many of its top-level items are live links into this standard
    live: std::collections::HashMap<String, usize>,
    entries: Vec<StandardEntry>,
    /// pictures at the standard's top level, offered as installation images
    images: Vec<String>,
}

fn is_image(name: &str, p: &Path) -> bool {
    let n = name.to_lowercase();
    p.is_file() && [".png", ".jpg", ".jpeg", ".webp"].iter().any(|x| n.ends_with(x))
}

fn images_in(dir: &Path) -> Vec<String> {
    visible_children(dir)
        .into_iter()
        .filter(|(n, p)| is_image(n, p))
        .map(|(_, p)| p.to_string_lossy().into())
        .collect()
}

/// Hidden, so listing and applying skip it.
const LINKS_FILE: &str = ".mim.json";

/// The built-in standard: SHARED_DIRS in the Minecraft folder itself.
const SHARED: &str = "Shared";

fn valid_name(n: &str) -> bool {
    !n.is_empty() && !n.starts_with('.') && !n.contains('/')
}

fn standard_dir(name: &str) -> CmdResult<PathBuf> {
    let d = standards_dir().join(name);
    if valid_name(name) && d.is_dir() {
        Ok(d)
    } else {
        Err(format!("no standard named \"{name}\""))
    }
}

fn visible_children(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut v: Vec<_> = fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| (e.file_name().to_string_lossy().to_string(), e.path()))
                .filter(|(n, _)| !n.starts_with('.'))
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

fn read_links(dir: &Path) -> Vec<String> {
    let v: Value = fs::read_to_string(dir.join(LINKS_FILE))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let existing = installation_names();
    v["installations"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .filter(|n| existing.iter().any(|e| e == n)) // drop deleted installs
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// A standard's config/ is linked into an installation's config/ file by file,
/// so it can share single mod settings and leave everything else alone.
const MERGED: &str = "config";

fn push_entry(entries: &mut Vec<StandardEntry>, rel: String, scope: &str, name: String, path: &Path) {
    if name == MERGED && path.is_dir() {
        let mut files = vec![];
        walk_files(path, &mut files);
        files.sort();
        for f in files {
            let r = slash_path(f.strip_prefix(path).unwrap_or(&f));
            if valid_rel(&r) {
                entries.push(StandardEntry {
                    rel_path: format!("{rel}/{r}"),
                    scope: scope.into(),
                    is_dir: false,
                    name: format!("{MERGED}/{r}"),
                });
            }
        }
    } else {
        entries.push(StandardEntry { rel_path: rel, scope: scope.into(), is_dir: path.is_dir(), name });
    }
}

/// "fabric/indigo.properties": plain names joined by '/', nothing hidden, no "..".
fn valid_rel(r: &str) -> bool {
    !r.is_empty() && r.split('/').all(valid_name)
}

/// "options.txt", or any file under config/ like "config/fabric/indigo.properties".
fn valid_dest(d: &str) -> bool {
    valid_name(d) || d.strip_prefix("config/").is_some_and(valid_rel)
}

/// Symlinks anywhere under `dir`, without following them.
fn links_under(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        match e.file_type() {
            Ok(t) if t.is_symlink() => out.push(e.path()),
            Ok(t) if t.is_dir() => links_under(&e.path(), out),
            _ => {}
        }
    }
}

/// The first symlinked folder on the way from `inst` down to `dest`.
fn linked_ancestor(inst: &Path, dest: &Path) -> Option<PathBuf> {
    let rel: Vec<_> = dest.strip_prefix(inst).ok()?.iter().collect();
    let mut p = inst.to_path_buf();
    for c in &rel[..rel.len().saturating_sub(1)] {
        p.push(c);
        if p.is_symlink() {
            return Some(p);
        }
    }
    None
}

#[tauri::command(async)]
fn list_standards() -> CmdResult<Vec<Standard>> {
    let names = installation_names();
    let live_of = |std: &str| -> Vec<(String, usize)> {
        names
            .iter()
            .map(|n| (n.clone(), links_of(&installations_dir().join(n), std).len()))
            .collect()
    };
    let shared_live: Vec<_> = live_of(SHARED).into_iter().filter(|(_, k)| *k > 0).collect();
    let mut out = vec![Standard {
        name: SHARED.into(),
        path: mc_dir().to_string_lossy().into(),
        builtin: true,
        installations: shared_live.iter().map(|(n, _)| n.clone()).collect(),
        live: shared_live.into_iter().collect(),
        entries: SHARED_DIRS
            .iter()
            .map(|d| StandardEntry {
                name: d.to_string(),
                rel_path: format!("{SHARED}/{d}"),
                scope: "global".into(),
                is_dir: true,
            })
            .collect(),
        // loose pictures in standards/ itself belong to no standard, so they show here
        images: images_in(&standards_dir()),
    }];
    // loose files at the top level aren't part of any standard and are ignored
    for (std_name, std_path) in visible_children(&standards_dir()) {
        if !std_path.is_dir() || std_name == SHARED {
            continue;
        }
        let mut entries = vec![];
        for (name, path) in visible_children(&std_path) {
            if path.is_dir() && is_version_name(&name) {
                // version-scoped group: list its children
                for (cname, cpath) in visible_children(&path) {
                    push_entry(&mut entries, format!("{std_name}/{name}/{cname}"), &name, cname, &cpath);
                }
            } else if !is_image(&name, &path) {
                // top-level pictures are the standard's images, not game files
                push_entry(&mut entries, format!("{std_name}/{name}"), "global", name, &path);
            }
        }
        entries.sort_by(|a, b| (&a.scope, &a.name).cmp(&(&b.scope, &b.name)));
        let installations = read_links(&std_path);
        let live = live_of(&std_name)
            .into_iter()
            .filter(|(n, _)| installations.contains(n))
            .collect();
        out.push(Standard {
            images: images_in(&std_path),
            builtin: false,
            installations,
            live,
            path: std_path.to_string_lossy().into(),
            name: std_name,
            entries,
        });
    }
    Ok(out)
}

#[tauri::command(async)]
fn ensure_standards_dir() -> CmdResult<String> {
    let dir = standards_dir();
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.to_string_lossy().into())
}

#[tauri::command(async)]
fn create_standard(name: String) -> CmdResult<String> {
    let name = name.trim();
    if !valid_name(name) {
        return Err("Invalid standard name".into());
    }
    if name.eq_ignore_ascii_case(SHARED) {
        return Err("\"Shared\" is the built-in standard".into());
    }
    let d = standards_dir().join(name);
    if d.exists() {
        return Err(format!("\"{name}\" already exists"));
    }
    fs::create_dir_all(&d).map_err(err)?;
    Ok(d.to_string_lossy().into())
}

fn write_links(dir: &Path, installations: &[String]) -> CmdResult<()> {
    let text = serde_json::to_string_pretty(&json!({ "installations": installations }))
        .map_err(err)?;
    fs::write(dir.join(LINKS_FILE), text).map_err(err)
}

fn add_link(dir: &Path, inst: &str) -> CmdResult<()> {
    let mut v = read_links(dir);
    if !v.iter().any(|n| n == inst) {
        v.push(inst.into());
    }
    write_links(dir, &v)
}

fn points_into(p: &Path, dir: &Path) -> bool {
    // junctions read back as verbatim \\?\C:\... paths
    fs::read_link(p).is_ok_and(|t| {
        let t = t.to_string_lossy();
        Path::new(t.strip_prefix(r"\\?\").unwrap_or(&t)).starts_with(dir)
    })
}

/// `link` is a symlink that ends up at `src` (however the link was written,
/// e.g. Essential's relative ones).
fn links_to(link: &Path, src: &Path) -> bool {
    link.is_symlink() && fs::canonicalize(link).ok() == fs::canonicalize(src).ok()
}

/// "PvP/1.21.10/config" -> "config", "PvP/options.txt" -> "options.txt"
fn standard_dest(rel: &str) -> Option<&str> {
    let (_std, rest) = rel.split_once('/')?;
    Some(match rest.split_once('/') {
        Some((first, inner)) if is_version_name(first) => inner,
        _ => rest,
    })
}

/// Where an entry lives and its name inside an installation.
fn entry_src(rel: &str) -> CmdResult<(PathBuf, String)> {
    let dest = match standard_dest(rel) {
        Some(d) if !rel.contains("..") && valid_dest(d) => d.to_string(),
        _ => return Err("invalid standards path".into()),
    };
    if rel.split_once('/').map(|(s, _)| s) == Some(SHARED) {
        if !SHARED_DIRS.contains(&dest.as_str()) || rel != format!("{SHARED}/{dest}") {
            return Err(format!("not a shared folder: {rel}"));
        }
        let src = mc_dir().join(&dest);
        fs::create_dir_all(&src).map_err(err)?;
        return Ok((src, dest));
    }
    let src = standards_dir().join(rel);
    if !src.exists() {
        return Err(format!("standard not found: {rel}"));
    }
    Ok((src, dest))
}

/// The live links from `inst` into standard `std`.
fn links_of(inst: &Path, std: &str) -> Vec<PathBuf> {
    if std == SHARED {
        let mc = mc_dir();
        SHARED_DIRS
            .iter()
            .map(|d| inst.join(d))
            .filter(|p| links_to(p, &mc.join(p.file_name().unwrap())))
            .collect()
    } else {
        let dir = standards_dir().join(std);
        let mut all: Vec<PathBuf> = visible_children(inst).into_iter().map(|(_, p)| p).collect();
        if !inst.join(MERGED).is_symlink() {
            links_under(&inst.join(MERGED), &mut all);
        }
        all.into_iter().filter(|p| points_into(p, &dir)).collect()
    }
}

/// Symlinks each (source, name) into `inst`, so edits on either side are live.
/// Returns what's in the way. With anything in the way and `replace` false,
/// nothing changes; with `replace`, those items go to the Trash first.
fn link_entries(inst: &Path, pairs: &[(PathBuf, String)], replace: bool) -> CmdResult<Vec<String>> {
    let mut todo = vec![];
    let mut blocked = vec![];
    for (src, name) in pairs {
        let dest = inst.join(name);
        if let Some(a) = linked_ancestor(inst, &dest) {
            // a folder on the way (like config/) is a link. One to the matching
            // folder here is how whole folders used to be linked: swap it for
            // per-file links quietly. Anything else is in the way.
            let depth = dest.strip_prefix(&a).map_or(0, |r| r.iter().count());
            let a_name = slash_path(a.strip_prefix(inst).unwrap_or(&a));
            if !src.ancestors().nth(depth).is_some_and(|s| links_to(&a, s)) && !blocked.contains(&a_name) {
                blocked.push(a_name);
            }
            todo.push((src, dest));
            continue;
        }
        if links_to(&dest, src) {
            continue; // already linked
        }
        if dest.symlink_metadata().is_ok() {
            blocked.push(name.clone());
        }
        todo.push((src, dest));
    }
    if !blocked.is_empty() && !replace {
        return Ok(blocked);
    }
    for (src, dest) in todo {
        if let Some(a) = linked_ancestor(inst, &dest) {
            remove_link(&a).map_err(err)?; // just a link, nothing lost
        }
        fs::create_dir_all(dest.parent().unwrap()).map_err(err)?;
        if dest.is_symlink() {
            remove_link(&dest).map_err(err)?; // just a link, nothing lost
        } else if dest.exists() {
            trash::delete(&dest).map_err(err)?;
        }
        symlink(src, &dest).map_err(err)?;
    }
    Ok(blocked)
}

/// Removes links; with `keep`, each becomes a real copy of what it pointed at.
/// The originals are never touched.
fn detach(links: &[PathBuf], keep: bool) -> CmdResult<()> {
    for p in links {
        let target = fs::canonicalize(p).map_err(err)?;
        remove_link(p).map_err(err)?;
        if keep {
            copy_recursive(&target, p).map_err(err)?;
        }
    }
    Ok(())
}

/// Returns the items in the way (see `link_entries`); when non-empty and
/// `replace` is false, nothing was linked.
#[tauri::command(async)]
fn link_standard(
    name: String,
    installation: String,
    rel_paths: Vec<String>,
    replace: bool,
) -> CmdResult<Vec<String>> {
    let std = if name == SHARED { None } else { Some(standard_dir(&name)?) };
    let inst = game_dir(Some(&installation))?;
    let pairs = rel_paths.iter().map(|r| entry_of(&name, r)).collect::<CmdResult<Vec<_>>>()?;
    let blocked = link_entries(&inst, &pairs, replace)?;
    if let Some(std) = std.filter(|_| blocked.is_empty() || replace) {
        add_link(&std, &installation)?;
    }
    Ok(blocked)
}

/// Unlinks the given entries; with `keep`, each becomes a real copy. Once
/// nothing is linked any more, the installation leaves the standard's list.
#[tauri::command(async)]
fn unlink_standard(name: String, installation: String, rel_paths: Vec<String>, keep: bool) -> CmdResult<()> {
    let inst = game_dir(Some(&installation))?;
    let mut links = vec![];
    for r in &rel_paths {
        let (src, dest) = entry_of(&name, r)?;
        if let (LinkState { state: "linked", .. }, link) = link_state(&inst, &src, &dest) {
            if !links.contains(&link) {
                links.push(link);
            }
        }
    }
    detach(&links, keep)?;
    if name != SHARED && links_of(&inst, &name).is_empty() {
        let std = standard_dir(&name)?;
        let v: Vec<String> = read_links(&std).into_iter().filter(|n| *n != installation).collect();
        write_links(&std, &v)?;
    }
    Ok(())
}

/// An entry of standard `name`: where it lives and its name inside an installation.
fn entry_of(name: &str, rel: &str) -> CmdResult<(PathBuf, String)> {
    match rel.split_once('/') {
        Some((s, _)) if s == name => entry_src(rel),
        _ => Err(format!("{rel} isn't part of \"{name}\"")),
    }
}

#[derive(Serialize, Debug, PartialEq)]
struct LinkState {
    /// "linked"; "free": nothing there yet; "own": the installation's own copy,
    /// which linking moves to the Trash; "other": a link to somewhere else
    state: &'static str,
    /// for "other": the standard it's linked from, when it's one
    from: Option<String>,
}

/// How entry `src` stands in `inst` under `name`, and the link that does (or
/// would) carry it: the item itself, or a linked folder on the way to it (how
/// whole folders like config/ used to be linked).
fn link_state(inst: &Path, src: &Path, name: &str) -> (LinkState, PathBuf) {
    let dest = inst.join(name);
    let link = linked_ancestor(inst, &dest).unwrap_or_else(|| dest.clone());
    let depth = dest.strip_prefix(&link).map_or(0, |r| r.iter().count());
    let state = if src.ancestors().nth(depth).is_some_and(|s| links_to(&link, s)) {
        "linked"
    } else if link.is_symlink() {
        "other"
    } else if link.symlink_metadata().is_ok() {
        "own"
    } else {
        "free"
    };
    let from = (state == "other").then(|| link_source(&link)).flatten();
    (LinkState { state, from }, link)
}

/// The standard a link points into, if any.
fn link_source(link: &Path) -> Option<String> {
    let t = fs::canonicalize(link).ok()?;
    if let Some(r) = fs::canonicalize(standards_dir()).ok().and_then(|s| t.strip_prefix(s).ok().map(PathBuf::from)) {
        return r.iter().next().map(|c| c.to_string_lossy().into());
    }
    let mc = fs::canonicalize(mc_dir()).ok()?;
    SHARED_DIRS.iter().any(|d| t == mc.join(d)).then(|| SHARED.into())
}

/// How each entry stands in an installation, in the order asked.
#[tauri::command(async)]
fn link_states(name: String, installation: String, rel_paths: Vec<String>) -> CmdResult<Vec<LinkState>> {
    let inst = game_dir(Some(&installation))?;
    rel_paths
        .iter()
        .map(|r| entry_of(&name, r).map(|(src, dest)| link_state(&inst, &src, &dest).0))
        .collect()
}

/// Moves files from an installation's config/ (`names` relative to it, like
/// "fabric/indigo.properties") into standard `standard` and links them back,
/// so every installation linked to it shares them. Where the standard already
/// has one, that copy wins: returns those names and changes nothing unless
/// `replace`, which sends the installation's own to the Trash.
#[tauri::command(async)]
fn share_config(installation: String, standard: String, names: Vec<String>, replace: bool) -> CmdResult<Vec<String>> {
    let std = standard_dir(&standard)?;
    let blocked = share_config_in(&game_dir(Some(&installation))?, &std, &names, replace)?;
    if blocked.is_empty() || replace {
        add_link(&std, &installation)?;
    }
    Ok(blocked)
}

fn share_config_in(inst: &Path, std: &Path, names: &[String], replace: bool) -> CmdResult<Vec<String>> {
    let (cfg, shared) = (inst.join(MERGED), std.join(MERGED));
    let mut pairs = vec![];
    let mut blocked = vec![];
    for n in names {
        let (own, dst) = (cfg.join(n), shared.join(n));
        if !valid_rel(n) || !own.is_file() {
            return Err(format!("no config/{n} here"));
        }
        if linked_ancestor(inst, &own).is_some() {
            return Err(format!("config/{n} is inside a linked folder — relink it under Standards first"));
        }
        if own.is_symlink() && !links_to(&own, &dst) {
            return Err(format!("config/{n} is already linked from somewhere else"));
        }
        if dst.symlink_metadata().is_ok() && !links_to(&own, &dst) {
            blocked.push(n.clone());
        }
        pairs.push((own, dst, format!("{MERGED}/{n}")));
    }
    if !blocked.is_empty() && !replace {
        return Ok(blocked);
    }
    for (own, dst, _) in &pairs {
        if dst.symlink_metadata().is_err() {
            fs::create_dir_all(dst.parent().unwrap()).map_err(err)?;
            fs::rename(own, dst).map_err(err)?; // same disk, so a plain move
        }
    }
    let pairs: Vec<_> = pairs.into_iter().map(|(_, dst, name)| (dst, name)).collect();
    link_entries(inst, &pairs, true)?;
    Ok(blocked)
}

#[tauri::command(async)]
fn delete_standard(name: String) -> CmdResult<()> {
    if name == SHARED {
        return Err("The Shared standard is the Minecraft folder itself".into());
    }
    let std = standard_dir(&name)?;
    for inst in read_links(&std) {
        // installations keep a copy of what they used
        detach(&links_of(&installations_dir().join(inst), &name), true)?;
    }
    trash::delete(std).map_err(err)
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

/// A resource pack's pack.mcmeta and pack.png, from a zip or a folder.
#[derive(Serialize)]
struct PackInfo {
    file: String,
    path: String,
    description: Option<String>,
    icon: Option<String>,
    format: Option<i64>,
    is_dir: bool,
    size_bytes: u64,
    modified: u64,
}

fn read_pack(p: &Path) -> PackInfo {
    let files: Vec<(String, Vec<u8>)> = if p.is_dir() {
        ["pack.mcmeta", "pack.png"]
            .iter()
            .filter_map(|n| Some((n.to_string(), fs::read(p.join(n)).ok()?)))
            .collect()
    } else {
        zip_read(p, &|n| n == "pack.mcmeta" || n == "pack.png")
    };
    let get = |n: &str| files.iter().find(|(f, _)| f == n).map(|(_, b)| b);
    // some packs start pack.mcmeta with a BOM
    let meta: Value = get("pack.mcmeta")
        .and_then(|b| serde_json::from_slice(b.strip_prefix(b"\xef\xbb\xbf").unwrap_or(b)).ok())
        .unwrap_or(Value::Null);
    let description = plain_text(&meta["pack"]["description"]);
    PackInfo {
        file: p.file_name().unwrap_or_default().to_string_lossy().into(),
        path: p.to_string_lossy().into(),
        description: (!description.trim().is_empty()).then_some(description),
        icon: get("pack.png").map(|b| data_url_from_png(b)),
        format: meta["pack"]["pack_format"].as_i64(),
        is_dir: p.is_dir(),
        size_bytes: entry_size(p),
        modified: modified_secs(p),
    }
}

#[derive(Serialize)]
struct PackList {
    dir: String,
    /// the folder is a link to the shared one
    linked: bool,
    /// turned-on packs from options.txt, top (winning) one first
    enabled: Vec<String>,
    packs: Vec<PackInfo>,
}

/// options.txt's resourcePacks list, bottom first like Minecraft keeps it.
fn pack_order(game: &Path) -> Vec<String> {
    let text = fs::read_to_string(game.join("options.txt")).unwrap_or_default();
    parse_options(&text)
        .into_iter()
        .find(|(k, _)| k == "resourcePacks")
        .and_then(|(_, v)| serde_json::from_str(&v).ok())
        .unwrap_or_default()
}

#[tauri::command(async)]
fn list_packs(installation: Option<String>) -> CmdResult<PackList> {
    let game = game_dir(installation.as_deref())?;
    let dir = game.join("resourcepacks");
    let paths: Vec<PathBuf> = fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    let n = p.file_name().unwrap_or_default().to_string_lossy();
                    !n.starts_with('.') && (p.is_dir() || n.ends_with(".zip"))
                })
                .collect()
        })
        .unwrap_or_default();
    let mut packs = par_map(&paths, |p| read_pack(p));
    packs.sort_by_key(|p| p.file.to_lowercase());
    Ok(PackList {
        dir: dir.to_string_lossy().into(),
        linked: dir.is_symlink(),
        enabled: pack_order(&game)
            .iter()
            .rev()
            .filter_map(|e| e.strip_prefix("file/").map(String::from))
            .collect(),
        packs,
    })
}

/// Sets which packs are on, top (winning) one first. Built-in entries like
/// "vanilla" and mod-provided ones stay underneath, as Minecraft expects.
#[tauri::command(async)]
fn set_packs(installation: Option<String>, enabled: Vec<String>) -> CmdResult<()> {
    set_packs_in(&game_dir(installation.as_deref())?, &enabled)
}

fn set_packs_in(game: &Path, enabled: &[String]) -> CmdResult<()> {
    let mut order: Vec<String> = pack_order(game).into_iter().filter(|e| !e.starts_with("file/")).collect();
    if order.is_empty() {
        order.push("vanilla".into());
    }
    order.extend(enabled.iter().rev().map(|f| format!("file/{f}")));
    let opts = game.join("options.txt");
    let mut entries = parse_options(&fs::read_to_string(&opts).unwrap_or_default());
    let value = serde_json::to_string(&order).map_err(err)?;
    match entries.iter_mut().find(|(k, _)| k == "resourcePacks") {
        Some(e) => e.1 = value,
        None => entries.push(("resourcePacks".into(), value)),
    }
    // a pack turned on here shouldn't stay in the "incompatible" list
    if let Some(e) = entries.iter_mut().find(|(k, _)| k == "incompatibleResourcePacks") {
        let rest: Vec<String> = serde_json::from_str::<Vec<String>>(&e.1)
            .unwrap_or_default()
            .into_iter()
            .filter(|x| !order.contains(x))
            .collect();
        e.1 = serde_json::to_string(&rest).map_err(err)?;
    }
    write_options_at(&opts, &entries)
}

#[tauri::command(async)]
fn add_packs(installation: Option<String>, files: Vec<String>) -> CmdResult<usize> {
    copy_in(&game_dir(installation.as_deref())?.join("resourcepacks"), &files, ".zip")
}

// ---------------------------------------------------------------------------
// Mod configs — config/ plus the folders mods drop straight into the game
// folder (journeymap/, XaeroWaypoints/, schematics/ …)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ConfigFile {
    /// relative to config/, e.g. "sodium-options.json" or "fabric/indigo-renderer.properties"
    rel: String,
    path: String,
    size_bytes: u64,
    modified: u64,
    /// the standard its top-level entry in config/ is linked from
    linked: Option<String>,
}

#[derive(Serialize)]
struct ConfigOverview {
    dir: String,
    files: Vec<ConfigFile>,
    /// top-level things in the game folder that Minecraft itself doesn't make
    loose: Vec<FolderItem>,
}

const TEXT_EXTS: [&str; 13] = [
    "json", "json5", "jsonc", "toml", "properties", "txt", "cfg", "conf", "yml", "yaml", "ini", "snbt", "hjson",
];

fn is_text_config(p: &Path) -> bool {
    p.extension().is_some_and(|e| TEXT_EXTS.contains(&e.to_string_lossy().to_lowercase().as_str()))
}

#[tauri::command(async)]
fn list_config(installation: Option<String>) -> CmdResult<ConfigOverview> {
    let game = game_dir(installation.as_deref())?;
    let dir = game.join("config");
    let mut paths = vec![];
    walk_files(&dir, &mut paths);
    let stds = fs::canonicalize(standards_dir()).ok();
    let mut files: Vec<ConfigFile> = paths
        .iter()
        .map(|p| ConfigFile {
            rel: slash_path(p.strip_prefix(&dir).unwrap_or(p)),
            path: p.to_string_lossy().into(),
            size_bytes: fs::metadata(p).map(|m| m.len()).unwrap_or(0),
            modified: modified_secs(p),
            linked: stds.as_ref().and_then(|s| {
                Some(fs::canonicalize(p).ok()?.strip_prefix(s).ok()?.iter().next()?.to_string_lossy().into())
            }),
        })
        .collect();
    files.sort_by_key(|f| f.rel.to_lowercase());
    let loose = root_entries(&game, "other")
        .into_iter()
        .filter(|p| !p.file_name().unwrap_or_default().to_string_lossy().starts_with('.'))
        .map(|p| FolderItem {
            name: p.file_name().unwrap_or_default().to_string_lossy().into(),
            category: "other",
            size_bytes: entry_size(&p),
            is_dir: p.is_dir(),
            path: p.to_string_lossy().into(),
        })
        .collect();
    Ok(ConfigOverview { dir: dir.to_string_lossy().into(), files, loose })
}

#[tauri::command(async)]
fn read_config(path: String) -> CmdResult<String> {
    let p = inside_mc(&path)?;
    if !is_text_config(&p) {
        return Err("MIM only opens text config files".into());
    }
    if fs::metadata(&p).map_err(err)?.len() > 2 << 20 {
        return Err("That file is too big to edit here — reveal it instead".into());
    }
    fs::read_to_string(&p).map_err(|_| "That file isn't plain text".into())
}

#[tauri::command(async)]
fn write_config(path: String, text: String) -> CmdResult<()> {
    let p = inside_mc(&path)?;
    if !is_text_config(&p) || !p.is_file() {
        return Err("MIM only edits existing text config files".into());
    }
    fs::write(&p, text).map_err(err)
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
    if select {
        tauri_plugin_opener::reveal_item_in_dir(&path).map_err(err)
    } else {
        tauri_plugin_opener::open_path(&path, None::<&str>).map_err(err)
    }
}

#[tauri::command]
fn open_launcher() -> CmdResult<()> {
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = command("open");
        c.args(["-a", "Minecraft"]);
        c
    } else if cfg!(windows) {
        let legacy = PathBuf::from(r"C:\Program Files (x86)\Minecraft Launcher\MinecraftLauncher.exe");
        if legacy.exists() {
            command(legacy)
        } else {
            // the Microsoft Store launcher
            let mut c = command("explorer.exe");
            c.arg(r"shell:AppsFolder\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft");
            c
        }
    } else {
        command("minecraft-launcher")
    };
    cmd.spawn().map_err(|e| format!("Couldn't open the Minecraft Launcher: {e}"))?;
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
        | "installations" | "standards" | ".mim" | "servers.dat" | "servers.dat_old" | "hotbar.nbt"
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

/// `thumb://localhost/<path>` → a 720px JPEG of a screenshot, cached on disk
/// so the gallery never decodes full-size PNGs.
fn screenshot_thumb(uri_path: &str) -> CmdResult<Vec<u8>> {
    let raw = percent_encoding::percent_decode(uri_path.trim_start_matches('/').as_bytes())
        .decode_utf8_lossy()
        .to_string();
    let cache = dirs::cache_dir().ok_or("no cache dir")?.join("mim/thumbs");
    make_thumb(&inside_mc(&raw)?, &cache)
}

fn make_thumb(src: &Path, cache_dir: &Path) -> CmdResult<Vec<u8>> {
    use std::hash::{Hash, Hasher};
    let meta = fs::metadata(src).map_err(err)?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (src, meta.len(), meta.modified().ok()).hash(&mut h);
    let cache = cache_dir.join(format!("{:016x}.jpg", h.finish()));
    if let Ok(bytes) = fs::read(&cache) {
        return Ok(bytes);
    }
    let img = image::open(src).map_err(err)?;
    let thumb = img.resize(720, 720, image::imageops::FilterType::Triangle).to_rgb8();
    let mut buf = vec![];
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 84)
        .encode_image(&thumb)
        .map_err(err)?;
    let _ = fs::create_dir_all(cache_dir).and_then(|_| fs::write(&cache, &buf));
    Ok(buf)
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
        use std::io::Read;
        let mut v = vec![];
        flate2::read::MultiGzDecoder::new(fs::File::open(&p).map_err(err)?).read_to_end(&mut v).map_err(err)?;
        v
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
    write_options_at(&options_path(&path)?, &entries)
}

fn write_options_at(p: &Path, entries: &[(String, String)]) -> CmdResult<()> {
    let mut text = String::new();
    for (k, v) in entries {
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
        let unzip = || zip::ZipArchive::new(fs::File::open(&src)?)?.extract(&tmp);
        if unzip().is_err() {
            let _ = fs::remove_dir_all(&tmp);
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
    zip_dir(&world, Path::new(&dest)).map_err(|e| format!("zipping the world failed: {e}"))
}

/// Zips `dir` into `dest`, with `dir`'s own folder at the top (like ditto --keepParent).
fn zip_dir(dir: &Path, dest: &Path) -> zip::result::ZipResult<()> {
    let parent = dir.parent().unwrap_or(dir);
    let mut files = vec![];
    walk_files(dir, &mut files);
    let mut zw = zip::ZipWriter::new(fs::File::create(dest)?);
    for f in files {
        let size = fs::metadata(&f)?.len();
        let opts = zip::write::SimpleFileOptions::default().large_file(size > u32::MAX as u64);
        zw.start_file(slash_path(f.strip_prefix(parent).unwrap_or(&f)), opts)?;
        std::io::copy(&mut fs::File::open(&f)?, &mut zw)?;
    }
    zw.finish()?;
    Ok(())
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
    if !["saves", "mods", "screenshots", "resourcepacks", "shaderpacks"].contains(&parent.as_str()) {
        return Err("MIM only trashes worlds, mods, packs and screenshots".into());
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
    /// unix seconds the file was last changed — roughly when it was added
    modified: u64,
    /// a library other mods need rather than something you'd notice in game
    library: bool,
}

/// Mod Menu's "library" badge, or an id that reads like one.
// ponytail: name heuristic, Modrinth's "library" category would be exact but costs a request
fn looks_like_library(id: &str) -> bool {
    let id = id.to_lowercase();
    ["api", "lib", "config", "kotlin", "architectury", "mixinextras", "fabric-language", "forgified"]
        .iter()
        .any(|k| id.contains(k))
}

fn modified_secs(p: &Path) -> u64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
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
        modified: modified_secs(path),
        library: false,
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
        m.library = strs(&v["custom"]["modmenu"]["badges"]).iter().any(|b| b == "library");
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
    m.library = m.library || looks_like_library(m.id.as_deref().unwrap_or(&m.file));
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

/// Copies the picked files ending in `ext` into `dir`, never overwriting.
fn copy_in(dir: &Path, files: &[String], ext: &str) -> CmdResult<usize> {
    fs::create_dir_all(dir).map_err(err)?;
    let mut n = 0;
    for f in files {
        let src = PathBuf::from(f);
        let name = src.file_name().unwrap_or_default().to_string_lossy().to_string();
        if !name.ends_with(ext) {
            continue;
        }
        fs::copy(&src, free_path(dir, &name)).map_err(err)?;
        n += 1;
    }
    Ok(n)
}

#[tauri::command(async)]
fn add_mods(installation: Option<String>, files: Vec<String>) -> CmdResult<usize> {
    copy_in(&mods_dir(installation.as_deref())?, &files, ".jar")
}

// ---------------------------------------------------------------------------
// Modrinth — import mods, collections and modpacks from a pasted link, and
// update mods in place. CurseForge's API needs a private key, so CurseForge
// links go through the same project's Modrinth page (most big mods are on both).
// ---------------------------------------------------------------------------

const MR: &str = "https://api.modrinth.com";

fn http() -> &'static reqwest::Client {
    static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            // Modrinth asks every client to identify itself
            .user_agent(concat!("MIM/", env!("CARGO_PKG_VERSION"), " (Minecraft Installation Manager)"))
            .build()
            .expect("http client")
    })
}

async fn send_json(rb: reqwest::RequestBuilder) -> CmdResult<Value> {
    let r = rb.send().await.map_err(err)?;
    match r.status() {
        s if s.is_success() => r.json().await.map_err(err),
        s if s == 404 => Err("Nothing on Modrinth at that link".into()),
        s => Err(format!("Modrinth said {s}")),
    }
}

/// What a pasted link points at: ("project", slug), ("collection", id) or
/// ("curseforge", slug). A bare word counts as a Modrinth slug.
fn parse_link(link: &str) -> CmdResult<(&'static str, String)> {
    let s = link.trim().split(['?', '#']).next().unwrap_or("");
    let s = s.trim_start_matches("https://").trim_start_matches("http://");
    let parts: Vec<&str> = s.split('/').filter(|p| !p.is_empty()).collect();
    let host = parts.first().map(|h| h.trim_start_matches("www.")).unwrap_or("");
    match parts.as_slice() {
        [_, "collection", id, ..] if host == "modrinth.com" => Ok(("collection", id.to_string())),
        [_, _kind, slug, ..] if host == "modrinth.com" => Ok(("project", slug.to_string())),
        [_, "minecraft", _kind, slug, ..] if host.ends_with("curseforge.com") => {
            Ok(("curseforge", slug.to_string()))
        }
        [slug] if !slug.contains('.') => Ok(("project", slug.to_string())),
        _ => Err("Paste a Modrinth or CurseForge link".into()),
    }
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

#[derive(Serialize)]
struct LinkInfo {
    /// "mod", "modpack", "resourcepack", "shader", … or "collection"
    kind: String,
    title: String,
    icon: Option<String>,
    projects: Vec<String>,
    game_versions: Vec<String>,
    loaders: Vec<String>,
    /// set when a CurseForge link was matched to Modrinth
    note: Option<String>,
}

#[tauri::command]
async fn resolve_link(link: String) -> CmdResult<LinkInfo> {
    let (kind, id) = parse_link(&link)?;
    if kind == "collection" {
        let c = send_json(http().get(format!("{MR}/v3/collection/{id}"))).await?;
        return Ok(LinkInfo {
            kind: "collection".into(),
            title: c["name"].as_str().unwrap_or("Collection").into(),
            icon: c["icon_url"].as_str().map(String::from),
            projects: strs(&c["projects"]),
            game_versions: vec![],
            loaders: vec![],
            note: None,
        });
    }
    let p = match send_json(http().get(format!("{MR}/v2/project/{id}"))).await {
        Err(_) if kind == "curseforge" => {
            return Err(format!(
                "\"{id}\" isn't on Modrinth under the same name — MIM reads CurseForge links through Modrinth, since CurseForge's API needs a private key"
            ))
        }
        r => r?,
    };
    Ok(LinkInfo {
        kind: p["project_type"].as_str().unwrap_or("mod").into(),
        title: p["title"].as_str().unwrap_or(&id).into(),
        icon: p["icon_url"].as_str().map(String::from),
        projects: strs(&json!([p["id"]])),
        game_versions: strs(&p["game_versions"]),
        loaders: strs(&p["loaders"]),
        note: (kind == "curseforge").then(|| "found on Modrinth".into()),
    })
}

/// An installation's folder, game version and loader ("fabric", "forge", "vanilla").
fn inst_target(name: &str) -> CmdResult<(PathBuf, String, String)> {
    let dir = game_dir(Some(name))?;
    let profiles = read_profiles()?;
    let vid = profiles["profiles"]
        .as_object()
        .and_then(|m| {
            m.values()
                .find(|p| p["gameDir"].as_str() == Some(dir.to_string_lossy().as_ref()))
        })
        .and_then(|p| p["lastVersionId"].as_str())
        .ok_or(format!("\"{name}\" isn't in the launcher, so MIM can't tell its version"))?;
    let (loader, game) = parse_version_id(vid);
    Ok((dir, game, loader))
}

fn sha512_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    format!("{:x}", sha2::Sha512::digest(bytes))
}

/// Downloads to `dest` (via a .part file), checking the hash when given.
async fn download(url: &str, sha512: Option<&str>, dest: &Path) -> CmdResult<()> {
    let r = http().get(url).send().await.map_err(err)?;
    if !r.status().is_success() {
        return Err(format!("download failed ({})", r.status()));
    }
    let bytes = r.bytes().await.map_err(err)?;
    if sha512.is_some_and(|h| h != sha512_hex(&bytes)) {
        return Err("download didn't match its checksum".into());
    }
    fs::create_dir_all(dest.parent().ok_or("bad path")?).map_err(err)?;
    let part = dest.with_file_name(format!("{}.part", dest.file_name().ok_or("bad path")?.to_string_lossy()));
    fs::write(&part, &bytes).map_err(err)?;
    fs::rename(&part, dest).map_err(err)
}

/// Newest version for the game version (and loader, for mods and modpacks) —
/// releases before betas. Nothing for that version means nothing is installed.
async fn pick_version(project: &str, kind: &str, game: &str, loader: &str) -> CmdResult<Option<Value>> {
    let url = format!("{MR}/v2/project/{project}/version");
    let mut q = vec![("game_versions", json!([game]).to_string())];
    if kind == "mod" || kind == "modpack" {
        q.push(("loaders", json!([loader]).to_string()));
    }
    let vs = send_json(http().get(&url).query(&q)).await?;
    let vs = vs.as_array().cloned().unwrap_or_default();
    Ok(vs
        .iter()
        .find(|v| v["version_type"] == "release")
        .or(vs.first())
        .cloned())
}

/// (url, safe file name, sha512) of a version's main file.
fn primary_file(v: &Value) -> Option<(String, String, Option<String>)> {
    let files = v["files"].as_array()?;
    let f = files.iter().find(|f| f["primary"] == true).or(files.first())?;
    let name = Path::new(f["filename"].as_str()?).file_name()?.to_string_lossy().to_string();
    Some((
        f["url"].as_str()?.into(),
        name,
        f["hashes"]["sha512"].as_str().map(String::from),
    ))
}

/// (sha512, path) of every mod jar in `dir`, disabled ones too.
fn jar_hashes(dir: &Path, with_disabled: bool) -> Vec<(String, PathBuf)> {
    let jars: Vec<PathBuf> = fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    let n = p.to_string_lossy();
                    n.ends_with(".jar") || (with_disabled && n.ends_with(".jar.disabled"))
                })
                .collect()
        })
        .unwrap_or_default();
    par_map(&jars, |p| (fs::read(p).map(|b| sha512_hex(&b)).unwrap_or_default(), p.clone()))
}

#[derive(Clone, Serialize)]
struct ProgressMsg {
    done: usize,
    total: usize, // 0 while the amount of work isn't known yet
    label: String,
}

/// Reports a long job to the window as "progress" events (silent in tests).
struct Progress {
    app: Option<tauri::AppHandle>,
    done: std::sync::atomic::AtomicUsize,
    total: std::sync::atomic::AtomicUsize,
}

impl Progress {
    fn new(app: Option<tauri::AppHandle>) -> Self {
        Self { app, done: 0.into(), total: 0.into() }
    }
    fn say(&self, label: impl Into<String>) {
        use std::sync::atomic::Ordering::Relaxed;
        use tauri::Emitter;
        if let Some(app) = &self.app {
            let _ = app.emit(
                "progress",
                ProgressMsg { done: self.done.load(Relaxed), total: self.total.load(Relaxed), label: label.into() },
            );
        }
    }
    fn add(&self, n: usize) {
        self.total.fetch_add(n, std::sync::atomic::Ordering::Relaxed);
    }
    fn tick(&self, label: impl Into<String>) {
        self.done.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.say(label)
    }
}

/// Runs the jobs a few at a time, so big packs download in parallel without
/// tripping Modrinth's rate limit, ticking `p` as each one lands.
// ponytail: fixed chunks of 8, a semaphore would keep the pipe fuller
async fn in_chunks<T: Send + 'static>(
    jobs: Vec<impl std::future::Future<Output = T> + Send + 'static>,
    p: &Progress,
    label: impl Fn(&T) -> String,
) -> CmdResult<Vec<T>> {
    p.add(jobs.len());
    let mut out = vec![];
    let mut it = jobs.into_iter().peekable();
    while it.peek().is_some() {
        let handles: Vec<_> = it.by_ref().take(8).map(tauri::async_runtime::spawn).collect();
        for h in handles {
            let r = h.await.map_err(err)?;
            p.tick(label(&r));
            out.push(r);
        }
    }
    Ok(out)
}

fn done_label(r: &Result<String, String>) -> String {
    match r {
        Ok(n) => n.clone(),
        Err(e) => format!("skipped {e}"),
    }
}

#[derive(Serialize, Default, Debug)]
struct ImportReport {
    title: String,
    added: Vec<String>,
    skipped: Vec<String>,
}

enum Fetched {
    Added(String, Vec<String>), // title, required dependencies
    Skipped(String),
    Quiet, // a dependency that's already there
}

/// Puts one project (a mod, resource pack or shader) into the installation.
async fn fetch_project(p: Value, dir: PathBuf, game: String, loader: String, have: bool, dep: bool) -> Fetched {
    let title = p["title"].as_str().unwrap_or("?").to_string();
    let kind = p["project_type"].as_str().unwrap_or("");
    if have {
        return if dep { Fetched::Quiet } else { Fetched::Skipped(format!("{title} (already installed)")) };
    }
    let folder = match kind {
        "mod" if loader == "vanilla" => return Fetched::Skipped(format!("{title} (needs Fabric)")),
        "mod" => "mods",
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        other => return Fetched::Skipped(format!("{title} ({other}s import on their own)")),
    };
    let id = p["id"].as_str().unwrap_or("");
    let v = match pick_version(id, kind, &game, &loader).await {
        Ok(Some(v)) => v,
        Ok(None) => return Fetched::Skipped(format!("{title} (no {game} {loader} version)")),
        Err(e) => return Fetched::Skipped(format!("{title} ({e})")),
    };
    let Some((url, name, hash)) = primary_file(&v) else {
        return Fetched::Skipped(format!("{title} (no file)"));
    };
    let dest = dir.join(folder).join(&name);
    if dest.exists() {
        return if dep { Fetched::Quiet } else { Fetched::Skipped(format!("{title} (already installed)")) };
    }
    if let Err(e) = download(&url, hash.as_deref(), &dest).await {
        return Fetched::Skipped(format!("{title} ({e})"));
    }
    let deps = v["dependencies"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|d| d["dependency_type"] == "required")
                .filter_map(|d| d["project_id"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Fetched::Added(title, deps)
}

/// `dir/rel` if `rel` stays inside `dir` (pack paths come from strangers).
fn safe_join(dir: &Path, rel: &str) -> CmdResult<PathBuf> {
    let p = Path::new(rel);
    if rel.is_empty() || !p.components().all(|c| matches!(c, std::path::Component::Normal(_))) {
        return Err(format!("unsafe path in pack: {rel}"));
    }
    Ok(dir.join(p))
}

/// Hosts a .mrpack may download from, per Modrinth's pack format.
fn allowed_host(url: &str) -> bool {
    ["cdn.modrinth.com", "github.com", "raw.githubusercontent.com", "gitlab.com"]
        .iter()
        .any(|h| url.starts_with(&format!("https://{h}/")))
}

/// Downloads a .mrpack's files and unpacks its overrides into `dir`.
async fn install_mrpack(
    project: &str,
    dir: &Path,
    game: &str,
    loader: &str,
    report: &mut ImportReport,
    p: &Progress,
) -> CmdResult<()> {
    let v = pick_version(project, "modpack", game, loader)
        .await?
        .ok_or(format!("This pack has no {game} {loader} version"))?;
    let (url, name, hash) = primary_file(&v).ok_or("This pack has no file")?;
    p.say(format!("Downloading {name}"));
    let tmp = dir.join(".mim").join("pack.mrpack");
    download(&url, hash.as_deref(), &tmp).await?;
    // ponytail: zip_read skips entries over 16 MB, fine for configs, not for huge bundled packs
    let mut entries = zip_read(&tmp, &|n| {
        n == "modrinth.index.json" || n.starts_with("overrides/") || n.starts_with("client-overrides/")
    });
    let _ = fs::remove_file(&tmp);
    let index: Value = entries
        .iter()
        .find(|(n, _)| n == "modrinth.index.json")
        .and_then(|(_, b)| serde_json::from_slice(b).ok())
        .ok_or("not a Modrinth pack")?;

    // client-overrides sort after overrides, so they win
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, bytes) in &entries {
        let rel = name
            .strip_prefix("client-overrides/")
            .or(name.strip_prefix("overrides/"));
        let Some(rel) = rel.filter(|r| !r.is_empty() && !r.ends_with('/')) else { continue };
        let p = safe_join(dir, rel)?;
        fs::create_dir_all(p.parent().unwrap()).map_err(err)?;
        fs::write(&p, bytes).map_err(err)?;
    }

    let mut jobs = vec![];
    for f in index["files"].as_array().into_iter().flatten() {
        if f["env"]["client"] == "unsupported" {
            continue;
        }
        let path = f["path"].as_str().unwrap_or("");
        let dest = safe_join(dir, path)?;
        let name = dest.file_name().unwrap_or_default().to_string_lossy().to_string();
        let Some(url) = strs(&f["downloads"]).into_iter().find(|u| allowed_host(u)) else {
            report.skipped.push(format!("{name} (download from an unknown site)"));
            continue;
        };
        let hash = f["hashes"]["sha512"].as_str().map(String::from);
        jobs.push(async move {
            download(&url, hash.as_deref(), &dest)
                .await
                .map(|_| name.clone())
                .map_err(|e| format!("{name} ({e})"))
        });
    }
    for r in in_chunks(jobs, p, done_label).await? {
        match r {
            Ok(n) => report.added.push(n),
            Err(e) => report.skipped.push(e),
        }
    }
    Ok(())
}

/// Imports whatever the links point at into an installation, matching its
/// game version and loader, and pulls in required dependencies.
#[tauri::command]
async fn import_links(app: tauri::AppHandle, links: Vec<String>, installation: String) -> CmdResult<ImportReport> {
    import_in(&links, &installation, &Progress::new(Some(app))).await
}

async fn import_in(links: &[String], installation: &str, p: &Progress) -> CmdResult<ImportReport> {
    let (dir, game, loader) = inst_target(installation)?;
    let mut report = ImportReport::default();
    let mut titles = vec![];
    let mut queue = vec![];
    for link in links.iter().map(|l| l.trim()).filter(|l| !l.is_empty()) {
        p.say(format!("Looking up {link}"));
        let info = match resolve_link(link.to_string()).await {
            Ok(i) => i,
            Err(e) => {
                report.skipped.push(format!("{link} ({e})"));
                continue;
            }
        };
        titles.push(info.title.clone());
        if info.kind == "modpack" {
            install_mrpack(&info.projects[0], &dir, &game, &loader, &mut report, p).await?;
        } else {
            queue.extend(info.projects);
        }
    }
    report.title = titles.join(", ");
    if queue.is_empty() {
        return Ok(report);
    }
    p.say("Checking what's already installed");

    // projects already in mods/, so nothing comes in twice
    let hashes: Vec<String> = jar_hashes(&dir.join("mods"), true).into_iter().map(|(h, _)| h).collect();
    let installed = if hashes.is_empty() {
        Value::Null
    } else {
        send_json(http().post(format!("{MR}/v2/version_files")).json(&json!({"hashes": hashes, "algorithm": "sha512"})))
            .await
            .unwrap_or(Value::Null)
    };
    let have: std::collections::HashSet<String> = installed
        .as_object()
        .map(|m| m.values().filter_map(|v| v["project_id"].as_str().map(String::from)).collect())
        .unwrap_or_default();

    let mut seen = std::collections::HashSet::new();
    let mut dep = false;
    while !queue.is_empty() {
        let ids: Vec<String> = queue.drain(..).filter(|id| seen.insert(id.clone())).collect();
        if ids.is_empty() {
            break;
        }
        let projects = send_json(http().get(format!("{MR}/v2/projects")).query(&[("ids", json!(ids).to_string())])).await?;
        let jobs: Vec<_> = projects
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|p| {
                let has = p["id"].as_str().is_some_and(|id| have.contains(id));
                fetch_project(p, dir.clone(), game.clone(), loader.clone(), has, dep)
            })
            .collect();
        let label = |f: &Fetched| match f {
            Fetched::Added(t, _) => t.clone(),
            Fetched::Skipped(s) => format!("skipped {s}"),
            Fetched::Quiet => String::new(),
        };
        for r in in_chunks(jobs, p, label).await? {
            match r {
                Fetched::Added(t, deps) => {
                    report.added.push(t);
                    queue.extend(deps.into_iter().filter(|d| !have.contains(d)));
                }
                Fetched::Skipped(s) => report.skipped.push(s),
                Fetched::Quiet => {}
            }
        }
        dep = true; // later rounds are dependencies
    }
    Ok(report)
}

/// Swaps every enabled mod Modrinth knows for its newest build for this
/// installation's version and loader. Old jars go to the Trash.
#[tauri::command]
async fn update_mods(app: tauri::AppHandle, installation: String) -> CmdResult<ImportReport> {
    update_in(&installation, &Progress::new(Some(app))).await
}

async fn update_in(installation: &str, p: &Progress) -> CmdResult<ImportReport> {
    let (dir, game, loader) = inst_target(installation)?;
    p.say("Checking for updates");
    let mods = dir.join("mods");
    let current = jar_hashes(&mods, false);
    let mut report = ImportReport { title: installation.into(), ..Default::default() };
    if current.is_empty() {
        return Ok(report);
    }
    let hashes: Vec<&String> = current.iter().map(|(h, _)| h).collect();
    let latest = send_json(http().post(format!("{MR}/v2/version_files/update")).json(&json!({
        "hashes": hashes,
        "algorithm": "sha512",
        "loaders": [loader],
        "game_versions": [game],
    })))
    .await?;
    let mut jobs = vec![];
    for (hash, old) in current {
        let Some((url, name, new_hash)) = latest.get(&hash).and_then(primary_file) else { continue };
        if new_hash.as_deref() == Some(hash.as_str()) {
            continue; // already newest
        }
        let dest = mods.join(&name);
        jobs.push(async move {
            download(&url, new_hash.as_deref(), &dest)
                .await
                .and_then(|_| if dest != old { trash::delete(&old).map_err(err) } else { Ok(()) })
                .map(|_| name.clone())
                .map_err(|e| format!("{name} ({e})"))
        });
    }
    for r in in_chunks(jobs, p, done_label).await? {
        match r {
            Ok(n) => report.added.push(n),
            Err(e) => report.skipped.push(e),
        }
    }
    Ok(report)
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
    width: u32,
    height: u32,
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
            // header-only read, so listing stays cheap
            let (width, height) = image::image_dimensions(e.path()).unwrap_or((16, 9));
            out.push(Screenshot {
                width,
                height,
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

// ---------------------------------------------------------------------------
// Launcher profiles — every edit backs up launcher_profiles.json first, and
// archives keep everything they move so a restore puts it all back.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct Profile {
    id: String,
    name: String,
    kind: String,
    version_id: Option<String>,
    last_used: Option<String>,
    /// gameDir resolved the launcher's way: unset means the Minecraft folder
    game_dir: String,
    shares_root: bool,
    /// not under installations/ (and not the Minecraft folder itself)
    outside: bool,
    missing: bool,
}

#[derive(Serialize, Deserialize)]
struct ArchivedProfile {
    id: String,
    profile: Value,
    game_dir: String,
    /// the game folder went into the archive; false when it was shared
    moved_dir: bool,
    /// version folders moved into the archive (ones nothing else used)
    versions: Vec<String>,
    archived: String,
}

#[derive(Serialize)]
struct ProfilesOverview {
    profiles: Vec<Profile>,
    archived: Vec<ArchivedProfile>,
    launcher_running: bool,
    backups: String,
}

fn canon(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn read_profiles_in(mc: &Path) -> CmdResult<Value> {
    let p = mc.join("launcher_profiles.json");
    if !p.exists() {
        return Ok(json!({ "profiles": {}, "version": 3 }));
    }
    serde_json::from_str(&fs::read_to_string(&p).map_err(err)?).map_err(err)
}

/// Backs up the current file, then writes `v`.
fn write_profiles_in(mc: &Path, v: &Value) -> CmdResult<()> {
    let p = mc.join("launcher_profiles.json");
    if p.exists() {
        let dir = mc.join(".mim/profile-backups");
        fs::create_dir_all(&dir).map_err(err)?;
        let stamp = chrono::Local::now().format("%Y-%m-%d_%H.%M.%S");
        fs::copy(&p, free_path(&dir, &format!("launcher_profiles-{stamp}.json"))).map_err(err)?;
    }
    fs::write(&p, serde_json::to_string_pretty(v).map_err(err)?).map_err(err)
}

fn profile_dir(mc: &Path, p: &Value) -> PathBuf {
    match p["gameDir"].as_str().filter(|d| !d.trim().is_empty()) {
        Some(d) => canon(&mc.join(d)), // an absolute gameDir replaces mc
        None => canon(mc),
    }
}

fn version_parent(mc: &Path, vid: &str) -> Option<String> {
    let text = fs::read_to_string(mc.join("versions").join(vid).join(format!("{vid}.json"))).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v["inheritsFrom"].as_str().map(String::from)
}

fn archive_dir(mc: &Path, id: &str) -> CmdResult<PathBuf> {
    if !valid_name(id) {
        return Err("invalid profile id".into());
    }
    Ok(mc.join(".mim/archive").join(id))
}

fn list_profiles_in(mc: &Path) -> CmdResult<ProfilesOverview> {
    let root = canon(mc);
    let insts = canon(&mc.join("installations"));
    let file = read_profiles_in(mc)?;
    let empty = serde_json::Map::new();
    let mut profiles: Vec<Profile> = file["profiles"]
        .as_object()
        .unwrap_or(&empty)
        .iter()
        .map(|(id, p)| {
            let dir = profile_dir(mc, p);
            let s = |k: &str| p[k].as_str().map(String::from);
            Profile {
                id: id.clone(),
                name: s("name").filter(|n| !n.is_empty()).unwrap_or_else(|| id.clone()),
                kind: s("type").unwrap_or_else(|| "custom".into()),
                version_id: s("lastVersionId"),
                last_used: s("lastUsed"),
                shares_root: dir == root,
                outside: dir != root && !dir.starts_with(&insts),
                missing: !dir.is_dir(),
                game_dir: dir.to_string_lossy().into(),
            }
        })
        .collect();
    profiles.sort_by(|a, b| b.last_used.cmp(&a.last_used));

    let mut archived: Vec<ArchivedProfile> = fs::read_dir(mc.join(".mim/archive"))
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| fs::read_to_string(e.path().join("archive.json")).ok())
                .filter_map(|t| serde_json::from_str(&t).ok())
                .collect()
        })
        .unwrap_or_default();
    archived.sort_by(|a, b| b.archived.cmp(&a.archived));

    Ok(ProfilesOverview {
        profiles,
        archived,
        launcher_running: false,
        backups: mc.join(".mim/profile-backups").to_string_lossy().into(),
    })
}

fn relink_profile_in(mc: &Path, id: &str, dir: &Path) -> CmdResult<()> {
    if !dir.is_dir() {
        return Err("pick an existing folder".into());
    }
    let mut file = read_profiles_in(mc)?;
    let p = file["profiles"].get_mut(id).filter(|p| p.is_object()).ok_or("no such profile")?;
    p["gameDir"] = json!(canon(dir).to_string_lossy());
    write_profiles_in(mc, &file)
}

/// Moves a profile's own folder into installations/<name> and points it there.
fn move_profile_in(mc: &Path, id: &str) -> CmdResult<String> {
    let mut file = read_profiles_in(mc)?;
    let p = file["profiles"].get(id).filter(|p| p.is_object()).ok_or("no such profile")?;
    let dir = profile_dir(mc, p);
    let insts = mc.join("installations");
    if dir == canon(mc) {
        return Err("it uses the Minecraft folder itself — archive it instead".into());
    }
    if !dir.is_dir() {
        return Err("its folder is missing — re-link it first".into());
    }
    if dir.starts_with(canon(&insts)) {
        return Err("already in installations/".into());
    }
    let name = p["name"].as_str().unwrap_or("").replace('/', "-");
    let name = name.trim().trim_start_matches('.');
    let name = if name.is_empty() { id } else { name };
    let dest = (0..)
        .map(|n| insts.join(if n == 0 { name.to_string() } else { format!("{name} {n}") }))
        .find(|d| !d.exists())
        .unwrap();
    fs::create_dir_all(&insts).map_err(err)?;
    // ponytail: rename only, so a folder on another drive errors instead of copying
    fs::rename(&dir, &dest).map_err(|e| format!("couldn't move the folder: {e}"))?;
    file["profiles"][id]["gameDir"] = json!(dest.to_string_lossy());
    if let Err(e) = write_profiles_in(mc, &file) {
        let _ = fs::rename(&dest, &dir);
        return Err(e);
    }
    Ok(dest.to_string_lossy().into())
}

/// Takes a profile out of the launcher. Its own folder and any version folders
/// nothing else uses move into .mim/archive/<id>; a folder it shares (like the
/// Minecraft folder) stays put.
fn archive_profile_in(mc: &Path, id: &str) -> CmdResult<()> {
    let arch = archive_dir(mc, id)?;
    if arch.exists() {
        return Err("already archived".into());
    }
    let mut file = read_profiles_in(mc)?;
    let map = file["profiles"].as_object().ok_or("no profiles")?;
    let p = map.get(id).ok_or("no such profile")?.clone();
    let others: Vec<&Value> = map.iter().filter(|(k, _)| *k != id).map(|(_, v)| v).collect();
    let dir = profile_dir(mc, &p);
    let shared = dir == canon(mc) || others.iter().any(|o| profile_dir(mc, o) == dir);

    fs::create_dir_all(&arch).map_err(err)?;
    let moved_dir = !shared && dir.is_dir();
    if moved_dir {
        if let Err(e) = fs::rename(&dir, arch.join("game")) {
            let _ = fs::remove_dir_all(&arch);
            return Err(format!("couldn't move the folder: {e}"));
        }
    }
    let mut versions = vec![];
    if let Some(vid) = p["lastVersionId"].as_str().filter(|v| valid_name(v)) {
        let used = others.iter().any(|o| {
            let ov = o["lastVersionId"].as_str().unwrap_or("");
            ov == vid || version_parent(mc, ov).as_deref() == Some(vid)
        });
        let src = mc.join("versions").join(vid);
        // ponytail: "latest-release" profiles aren't resolved; vanilla versions re-download anyway
        if !used && src.is_dir() {
            fs::create_dir_all(arch.join("versions")).map_err(err)?;
            if fs::rename(&src, arch.join("versions").join(vid)).is_ok() {
                versions.push(vid.to_string());
            }
        }
    }
    let record = ArchivedProfile {
        id: id.into(),
        profile: p,
        game_dir: dir.to_string_lossy().into(),
        moved_dir,
        versions,
        archived: now_iso(),
    };
    fs::write(arch.join("archive.json"), serde_json::to_string_pretty(&record).map_err(err)?)
        .map_err(err)?;
    file["profiles"].as_object_mut().unwrap().remove(id);
    write_profiles_in(mc, &file)
}

fn restore_profile_in(mc: &Path, id: &str) -> CmdResult<()> {
    let arch = archive_dir(mc, id)?;
    let text = fs::read_to_string(arch.join("archive.json")).map_err(|_| "not archived")?;
    let record: ArchivedProfile = serde_json::from_str(&text).map_err(err)?;
    let mut file = read_profiles_in(mc)?;
    if !file["profiles"].is_object() {
        file["profiles"] = json!({});
    }
    if file["profiles"].get(id).is_some() {
        return Err("a profile with this id is back in the launcher already".into());
    }
    let dir = PathBuf::from(&record.game_dir);
    if record.moved_dir {
        if dir.exists() {
            return Err(format!("something is already at {}", dir.display()));
        }
        fs::create_dir_all(dir.parent().unwrap_or(mc)).map_err(err)?;
        fs::rename(arch.join("game"), &dir).map_err(err)?;
    }
    for v in &record.versions {
        let dest = mc.join("versions").join(v);
        if !dest.exists() {
            fs::create_dir_all(mc.join("versions")).map_err(err)?;
            let _ = fs::rename(arch.join("versions").join(v), dest);
        }
    }
    file["profiles"][id] = record.profile;
    write_profiles_in(mc, &file)?;
    // only empties go; anything left over (a version that came back meanwhile) stays
    let _ = fs::remove_file(arch.join("archive.json"));
    let _ = fs::remove_dir(arch.join("versions"));
    let _ = fs::remove_dir(&arch);
    Ok(())
}

/// The launcher rewrites launcher_profiles.json when it quits, undoing edits.
fn launcher_running() -> bool {
    std::env::var_os(MC_DIR_ENV).is_none() // a sample folder isn't the launcher's
        && if cfg!(windows) {
            command("tasklist").args(["/NH", "/FO", "CSV"]).output().is_ok_and(|o| {
                let out = String::from_utf8_lossy(&o.stdout).to_lowercase();
                out.contains("\"minecraftlauncher.exe\"") || out.contains("\"minecraft.exe\"")
            })
        } else {
            let pattern = if cfg!(target_os = "macos") { "Minecraft.app/Contents/MacOS" } else { "minecraft-launcher" };
            command("pgrep")
                .args(["-f", pattern])
                .stdout(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        }
}

fn launcher_closed() -> CmdResult<()> {
    if launcher_running() {
        Err("Quit the Minecraft Launcher first — it would overwrite these edits".into())
    } else {
        Ok(())
    }
}

#[tauri::command(async)]
fn list_profiles() -> CmdResult<ProfilesOverview> {
    let mut o = list_profiles_in(&mc_dir())?;
    o.launcher_running = launcher_running();
    Ok(o)
}

#[tauri::command(async)]
fn relink_profile(id: String, dir: String) -> CmdResult<()> {
    launcher_closed()?;
    relink_profile_in(&mc_dir(), &id, Path::new(&dir))
}

#[tauri::command(async)]
fn move_profile(id: String) -> CmdResult<String> {
    launcher_closed()?;
    move_profile_in(&mc_dir(), &id)
}

#[tauri::command(async)]
fn archive_profile(id: String) -> CmdResult<()> {
    launcher_closed()?;
    archive_profile_in(&mc_dir(), &id)
}

#[tauri::command(async)]
fn restore_profile(id: String) -> CmdResult<()> {
    launcher_closed()?;
    restore_profile_in(&mc_dir(), &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_dest_strips_name_and_version() {
        assert_eq!(standard_dest("PvP/options.txt"), Some("options.txt"));
        assert_eq!(standard_dest("PvP/1.21.10/config"), Some("config"));
        assert_eq!(standard_dest("PvP/config/sodium.json"), Some("config/sodium.json"));
        assert_eq!(standard_dest("options.txt"), None); // loose, not in a standard
    }

    // throwaway temp folder, never the real minecraft dir
    #[test]
    fn link_warns_then_detach_copies_back() {
        let root = std::env::temp_dir().join(format!("mim-std-{}", uuid::Uuid::new_v4()));
        let (std, inst) = (root.join("standards/PvP"), root.join("inst"));
        fs::create_dir_all(std.join("1.21.10")).unwrap();
        fs::create_dir_all(&inst).unwrap();
        fs::write(std.join("options.txt"), "fov:90").unwrap();
        fs::write(std.join("1.21.10/servers.dat"), "x").unwrap();
        fs::write(inst.join("options.txt"), "mine").unwrap();
        let pairs = vec![
            (std.join("options.txt"), "options.txt".to_string()),
            (std.join("1.21.10/servers.dat"), "servers.dat".to_string()),
        ];

        // something in the way: reported, nothing touched
        assert_eq!(link_entries(&inst, &pairs, false).unwrap(), ["options.txt"]);
        assert_eq!(fs::read_to_string(inst.join("options.txt")).unwrap(), "mine");
        assert!(!inst.join("servers.dat").exists());

        // clear the way (a symlink, so replace just removes it — no Trash in tests)
        fs::remove_file(inst.join("options.txt")).unwrap();
        symlink("missing-options.txt", inst.join("options.txt")).unwrap();
        link_entries(&inst, &pairs, true).unwrap();
        fs::write(std.join("options.txt"), "fov:70").unwrap(); // live edit
        assert_eq!(fs::read_to_string(inst.join("options.txt")).unwrap(), "fov:70");
        assert!(points_into(&inst.join("servers.dat"), &std));
        assert!(link_entries(&inst, &pairs, false).unwrap().is_empty()); // idempotent

        // a relative link (how Essential writes them) still counts as linked
        fs::remove_file(inst.join("servers.dat")).unwrap();
        symlink("../standards/PvP/1.21.10/servers.dat", inst.join("servers.dat"))
            .unwrap();
        assert!(link_entries(&inst, &pairs, false).unwrap().is_empty());

        // per-item state: linked, someone else's link, the install's own, nothing yet
        let st = |src: &Path, n: &str| link_state(&inst, src, n).0.state;
        assert_eq!(st(&std.join("1.21.10/servers.dat"), "servers.dat"), "linked");
        fs::write(std.join("other.txt"), "").unwrap();
        assert_eq!(st(&std.join("other.txt"), "options.txt"), "other");
        assert_eq!(st(&std.join("other.txt"), "other.txt"), "free");
        fs::write(inst.join("own.txt"), "").unwrap();
        assert_eq!(st(&std.join("other.txt"), "own.txt"), "own");
        let cfg = root.join("standards/PvP/config");
        fs::create_dir_all(&cfg).unwrap();
        fs::write(cfg.join("a.json"), "").unwrap();
        symlink(&cfg, inst.join("config")).unwrap(); // the old whole-folder link
        let (s, link) = link_state(&inst, &cfg.join("a.json"), "config/a.json");
        assert_eq!((s.state, link), ("linked", inst.join("config")));
        remove_link(&inst.join("config")).unwrap();

        // keep: real copy; remove: gone. Originals untouched either way.
        detach(&[inst.join("options.txt")], true).unwrap();
        assert!(!inst.join("options.txt").is_symlink());
        assert_eq!(fs::read_to_string(inst.join("options.txt")).unwrap(), "fov:70");
        detach(&[inst.join("servers.dat")], false).unwrap();
        assert!(inst.join("servers.dat").symlink_metadata().is_err());
        assert!(std.join("1.21.10/servers.dat").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    // throwaway temp folder, never the real minecraft dir
    #[test]
    fn share_config_links_single_mods() {
        let root = std::env::temp_dir().join(format!("mim-cfg-{}", uuid::Uuid::new_v4()));
        let (std, a, b) = (root.join("standards/PvP"), root.join("a"), root.join("b"));
        for (inst, v) in [(&a, "a"), (&b, "b")] {
            fs::create_dir_all(inst.join("config/fabric")).unwrap();
            fs::write(inst.join("config/sodium.json"), v).unwrap();
            fs::write(inst.join("config/fabric/x.toml"), v).unwrap();
        }
        let sodium = vec!["sodium.json".to_string()];

        // a shares sodium: moved into the standard, linked back, the rest untouched
        assert!(share_config_in(&a, &std, &sodium, false).unwrap().is_empty());
        assert!(links_to(&a.join("config/sodium.json"), &std.join("config/sodium.json")));
        assert_eq!(fs::read_to_string(a.join("config/sodium.json")).unwrap(), "a");
        assert!(!a.join("config/fabric").is_symlink());
        assert!(share_config_in(&a, &std, &sodium, false).unwrap().is_empty()); // idempotent

        // b has its own: reported, nothing touched
        assert_eq!(share_config_in(&b, &std, &sodium, false).unwrap(), ["sodium.json"]);
        assert_eq!(fs::read_to_string(b.join("config/sodium.json")).unwrap(), "b");
        assert_eq!(fs::read_to_string(std.join("config/sodium.json")).unwrap(), "a");

        // linking the standard into a fresh install makes config/ and links one file
        let c = root.join("c");
        fs::create_dir_all(&c).unwrap();
        let pairs = vec![(std.join("config/sodium.json"), "config/sodium.json".to_string())];
        link_entries(&c, &pairs, false).unwrap();
        assert!(!c.join("config").is_symlink() && c.join("config/sodium.json").is_symlink());

        // the old way, all of config/ linked: quietly becomes per-file links
        let d = root.join("d");
        fs::create_dir_all(&d).unwrap();
        symlink(std.join("config"), d.join("config")).unwrap();
        assert!(link_entries(&d, &pairs, false).unwrap().is_empty());
        assert!(!d.join("config").is_symlink() && d.join("config/sodium.json").is_symlink());
        assert!(std.join("config/sodium.json").is_file());

        // one file deep in a folder: only that file is linked, its siblings stay put
        fs::write(a.join("config/fabric/y.toml"), "own").unwrap();
        assert!(share_config_in(&a, &std, &["fabric/x.toml".into()], false).unwrap().is_empty());
        assert!(!a.join("config/fabric").is_symlink());
        assert!(links_to(&a.join("config/fabric/x.toml"), &std.join("config/fabric/x.toml")));
        assert!(a.join("config/fabric/y.toml").is_file() && !std.join("config/fabric/y.toml").exists());
        let mut found = vec![];
        links_under(&a.join("config"), &mut found);
        assert_eq!(found.len(), 2);
        let deep = vec![(std.join("config/fabric/x.toml"), "config/fabric/x.toml".to_string())];
        assert!(link_entries(&c, &deep, false).unwrap().is_empty());
        assert!(c.join("config/fabric/x.toml").is_symlink());

        assert!(share_config_in(&a, &std, &["../x".into()], false).is_err());
        assert!(valid_dest("config/a/b.json") && !valid_dest("config/../b") && !valid_dest("mods/x"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn thumbnails_shrink_and_cache() {
        let root = std::env::temp_dir().join(format!("mim-thumb-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let src = root.join("2026-11-18_21.04.11.png");
        image::RgbImage::from_pixel(1920, 1080, image::Rgb([90, 160, 80])).save(&src).unwrap();
        let cache = root.join("thumbs");
        let a = make_thumb(&src, &cache).unwrap();
        let img = image::load_from_memory(&a).unwrap();
        assert_eq!((img.width(), img.height()), (720, 405));
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 1);
        assert_eq!(make_thumb(&src, &cache).unwrap(), a); // served from cache
        assert_eq!(image::image_dimensions(&src).unwrap(), (1920, 1080));
        fs::remove_dir_all(&root).unwrap();
    }

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

        let hy = root.join("installations/Hypixel 1.21.10");
        assert!(read_mod(&hy.join("mods/fabric-api-0.130.0.jar")).library);
        assert!(!read_mod(&hy.join("mods/sodium-fabric-0.6.0.jar")).library);
        let faithful = read_pack(&root.join("resourcepacks/Faithful 32x.zip"));
        assert_eq!(faithful.description.as_deref(), Some("The classic look, doubled."));
        assert!(faithful.icon.is_some() && faithful.format == Some(64));
        assert_eq!(pack_order(&hy), ["vanilla", "fabric", "file/Low Fire.zip", "file/Faithful 32x.zip"]);
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
    fn zips_and_unzips_a_world() {
        let root = std::env::temp_dir().join(format!("mim-zip-{}", uuid::Uuid::new_v4()));
        let world = root.join("My World");
        fs::create_dir_all(world.join("region")).unwrap();
        fs::write(world.join("level.dat"), b"lvl").unwrap();
        fs::write(world.join("region/r.0.0.mca"), "x".repeat(5000)).unwrap();
        zip_dir(&world, &root.join("w.zip")).unwrap();
        zip::ZipArchive::new(fs::File::open(root.join("w.zip")).unwrap()).unwrap().extract(root.join("out")).unwrap();
        assert_eq!(find_world(&root.join("out")), Some(root.join("out/My World")));
        assert_eq!(fs::read(root.join("out/My World/region/r.0.0.mca")).unwrap().len(), 5000);
        fs::remove_dir_all(&root).unwrap();
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
        let mut zw = zip::ZipWriter::new(fs::File::create(&jar).unwrap());
        for f in ["fabric.mod.json", "assets/b.png", "big.txt"] {
            zw.start_file(f, zip::write::SimpleFileOptions::default()).unwrap();
            std::io::Write::write_all(&mut zw, &fs::read(dir.join(f)).unwrap()).unwrap();
        }
        zw.finish().unwrap();
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
    fn parses_mod_links() {
        let p = |l: &str| parse_link(l).map(|(k, id)| format!("{k}:{id}"));
        assert_eq!(p("https://modrinth.com/mod/sodium").unwrap(), "project:sodium");
        assert_eq!(p("modrinth.com/modpack/fabulously-optimized/versions?l=fabric").unwrap(), "project:fabulously-optimized");
        assert_eq!(p("https://modrinth.com/collection/AbCd1234/").unwrap(), "collection:AbCd1234");
        assert_eq!(p("https://www.curseforge.com/minecraft/mc-mods/jei").unwrap(), "curseforge:jei");
        assert_eq!(p("sodium").unwrap(), "project:sodium");
        assert!(p("https://example.com/mod/x").is_err());
        assert!(safe_join(Path::new("/i"), "../x").is_err());
        assert!(safe_join(Path::new("/i"), "/etc/x").is_err());
        assert!(safe_join(Path::new("/i"), "mods/a.jar").is_ok());
        assert!(allowed_host("https://cdn.modrinth.com/data/x.jar"));
        assert!(!allowed_host("https://cdn.modrinth.com.evil.io/x.jar"));
    }

    // hits the real Modrinth API in a temp folder: cargo test modrinth_e2e -- --ignored
    #[test]
    #[ignore]
    fn modrinth_e2e() {
        let root = std::env::temp_dir().join(format!("mim-mr-{}", uuid::Uuid::new_v4()));
        let inst = root.join("installations/Test");
        fs::create_dir_all(&inst).unwrap();
        let profile = json!({"profiles": {"t": {"gameDir": inst.to_string_lossy(), "lastVersionId": "fabric-loader-0.16.14-1.21.1"}}});
        fs::write(root.join("launcher_profiles.json"), profile.to_string()).unwrap();
        std::env::set_var(MC_DIR_ENV, &root);

        // Mod Menu requires Fabric API and Placeholder API, which should come along
        let r = tauri::async_runtime::block_on(import_in(&["https://modrinth.com/mod/modmenu".into()], "Test", &Progress::new(None))).unwrap();
        assert!(r.added.iter().any(|t| t == "Fabric API"), "{:?}", r.added);
        let again = tauri::async_runtime::block_on(import_in(&["modmenu".into()], "Test", &Progress::new(None))).unwrap();
        assert!(again.added.is_empty() && again.skipped[0].contains("already"), "{:?}", again.skipped);
        // already newest, so nothing to update
        let u = tauri::async_runtime::block_on(update_in("Test", &Progress::new(None))).unwrap();
        assert!(u.added.is_empty() && u.skipped.is_empty(), "{:?}", u.added);
        // a CurseForge link to a mod that's on Modrinth too
        let cf = tauri::async_runtime::block_on(import_in(&["https://www.curseforge.com/minecraft/mc-mods/sodium".into()], "Test", &Progress::new(None))).unwrap();
        assert_eq!(cf.added, ["Sodium"]);
        let files: Vec<_> = fs::read_dir(inst.join("mods")).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(files.len(), 4, "{files:?}");

        // an old Sodium gets swapped for the newest one, the old jar goes to the Trash
        for f in &files {
            if f.to_string_lossy().starts_with("sodium") {
                fs::remove_file(inst.join("mods").join(f)).unwrap();
            }
        }
        let old = "https://cdn.modrinth.com/data/AANobbMI/versions/RncWhTxD/sodium-fabric-0.5.11%2Bmc1.21.jar";
        tauri::async_runtime::block_on(download(old, None, &inst.join("mods/sodium-old.jar"))).unwrap();
        let u = tauri::async_runtime::block_on(update_in("Test", &Progress::new(None))).unwrap();
        assert!(u.added.iter().any(|n| n.starts_with("sodium")) && !inst.join("mods/sodium-old.jar").exists(), "{u:?}");

        // a modpack: files from the index plus its overrides
        let r = tauri::async_runtime::block_on(import_in(&["https://modrinth.com/modpack/fabulously-optimized".into()], "Test", &Progress::new(None))).unwrap();
        assert!(r.added.len() > 10 && inst.join("config").is_dir(), "{:?}", r.skipped);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn pack_order_round_trip() {
        let game = std::env::temp_dir().join(format!("mim-packs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&game).unwrap();
        fs::write(
            game.join("options.txt"),
            "fov:0.5\nresourcePacks:[\"vanilla\",\"fabric\",\"file/Old.zip\"]\nincompatibleResourcePacks:[\"file/B.zip\"]\n",
        )
        .unwrap();
        // UI order is top first; Minecraft stores bottom first, built-ins underneath
        set_packs_in(&game, &["A.zip".into(), "B.zip".into()]).unwrap();
        assert_eq!(pack_order(&game), ["vanilla", "fabric", "file/B.zip", "file/A.zip"]);
        let text = fs::read_to_string(game.join("options.txt")).unwrap();
        assert!(text.contains("fov:0.5") && text.contains("incompatibleResourcePacks:[]"), "{text}");
        fs::remove_dir_all(&game).unwrap();
    }

    #[test]
    fn neoforge_versions_map_to_game() {
        assert_eq!(neoforge_game("21.1.77"), "1.21.1");
        assert_eq!(neoforge_game("21.0.167"), "1.21");
        assert_eq!(neoforge_game("20.4.80-beta"), "1.20.4");
        assert_eq!(neoforge_game("26.1.0.12"), "26.1");
        assert_eq!(neoforge_game("26.1.2.3"), "26.1.2");
        assert_eq!(neoforge_prefix("1.21.1"), "21.1.");
        assert_eq!(neoforge_prefix("1.21"), "21.0.");
        assert_eq!(neoforge_prefix("26.1"), "26.1.0.");
        assert_eq!(parse_version_id("neoforge-21.1.77"), ("neoforge".into(), "1.21.1".into()));
    }

    #[test]
    fn forge_versions_from_maven() {
        let xml = "<version>1.20.1-47.4.5</version><version>1.20.1-47.4.29</version><version>1.20-46.0.1</version><version>1.7.10-10.13.4.1614-1.7.10</version>";
        assert_eq!(forge_list(xml, "1.20.1"), ["47.4.5", "47.4.29"]);
        assert_eq!(forge_list(xml, "1.20"), ["46.0.1"]);
        assert!(forge_list(xml, "1.7.10").is_empty());
    }

    // real Forge installer into a temp folder: cargo test forge_e2e -- --ignored
    #[test]
    #[ignore]
    fn forge_e2e() {
        for (loader, game) in [("forge", "1.20.1"), ("neoforge", "1.21.1")] {
            forge_e2e_one(loader, game);
        }
    }

    fn forge_e2e_one(loader: &str, game: &str) {
        let root = std::env::temp_dir().join(format!("mim-forge-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("installations")).unwrap();
        fs::write(root.join("launcher_profiles.json"), r#"{"profiles":{}}"#).unwrap();
        std::env::set_var(MC_DIR_ENV, &root);
        let spec = InstallSpec {
            name: "Forgey".into(),
            game_version: game.into(),
            loader: loader.into(),
            loader_version: None,
            standards: vec![],
        };
        tauri::async_runtime::block_on(create_in(spec, &Progress::new(None))).unwrap();
        let profiles = read_profiles().unwrap();
        let all = profiles["profiles"].as_object().unwrap();
        assert_eq!(all.len(), 1, "installer's own profile should be gone: {all:?}");
        let vid = all.values().next().unwrap()["lastVersionId"].as_str().unwrap().to_string();
        assert!(vid.contains("forge-") && root.join("versions").join(&vid).is_dir(), "{vid}");
        let (_, g, l) = inst_target("Forgey").unwrap();
        assert_eq!((g.as_str(), l.as_str()), (game, loader));
        fs::remove_dir_all(&root).unwrap();
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

    // throwaway temp folder, never the real minecraft dir
    #[test]
    fn profiles_flag_move_archive_restore() {
        let mc = canon(&std::env::temp_dir()).join(format!("mim-prof-{}", uuid::Uuid::new_v4()));
        let ext = mc.join("elsewhere/Old Pack");
        for d in ["installations/Kept", "versions/1.21.10", "versions/hop-1.0", "elsewhere/Old Pack"] {
            fs::create_dir_all(mc.join(d)).unwrap();
        }
        fs::write(mc.join("versions/hop-1.0/hop-1.0.json"), r#"{"inheritsFrom":"1.21.10"}"#).unwrap();
        fs::write(ext.join("options.txt"), "fov:1").unwrap();
        let file = json!({"version": 3, "profiles": {
            "hop": {"name": "Hoplite", "lastVersionId": "hop-1.0", "type": "custom"},
            "kept": {"name": "Kept", "gameDir": mc.join("installations/Kept"), "lastVersionId": "1.21.10"},
            "old": {"name": "Old Pack", "gameDir": ext, "lastVersionId": "1.21.10"},
            "gone": {"name": "Gone", "gameDir": mc.join("nope")}
        }});
        fs::write(mc.join("launcher_profiles.json"), file.to_string()).unwrap();

        let o = list_profiles_in(&mc).unwrap();
        let get = |o: &ProfilesOverview, id: &str| {
            let p = o.profiles.iter().find(|p| p.id == id).unwrap();
            (p.shares_root, p.outside, p.missing)
        };
        assert_eq!(get(&o, "hop"), (true, false, false));
        assert_eq!(get(&o, "kept"), (false, false, false));
        assert_eq!(get(&o, "old"), (false, true, false));
        assert_eq!(get(&o, "gone"), (false, true, true));
        assert!(move_profile_in(&mc, "hop").is_err()); // root-sharing can't move

        // root-sharing archive: exports profile + its unused version, root untouched
        archive_profile_in(&mc, "hop").unwrap();
        assert!(mc.join("installations").is_dir());
        assert!(!mc.join("versions/hop-1.0").exists());
        assert!(mc.join("versions/1.21.10").exists()); // others still use it
        let o = list_profiles_in(&mc).unwrap();
        assert!(o.profiles.iter().all(|p| p.id != "hop"));
        assert_eq!(o.archived[0].versions, ["hop-1.0"]);
        assert!(!o.archived[0].moved_dir);
        restore_profile_in(&mc, "hop").unwrap();
        assert!(mc.join("versions/hop-1.0/hop-1.0.json").exists());
        assert!(!mc.join(".mim/archive/hop").exists());
        assert_eq!(read_profiles_in(&mc).unwrap()["profiles"]["hop"]["name"], "Hoplite");

        // moving into installations/, then archiving takes the folder along
        let dest = move_profile_in(&mc, "old").unwrap();
        assert_eq!(dest, mc.join("installations/Old Pack").to_string_lossy());
        assert!(!ext.exists());
        archive_profile_in(&mc, "old").unwrap();
        assert!(!Path::new(&dest).exists());
        assert!(mc.join(".mim/archive/old/game/options.txt").exists());
        restore_profile_in(&mc, "old").unwrap();
        assert_eq!(fs::read_to_string(Path::new(&dest).join("options.txt")).unwrap(), "fov:1");

        relink_profile_in(&mc, "gone", &mc.join("installations/Kept")).unwrap();
        assert!(!list_profiles_in(&mc).unwrap().profiles.iter().any(|p| p.missing));
        assert!(relink_profile_in(&mc, "gone", &mc.join("nope")).is_err());
        // every write left a backup
        assert_eq!(fs::read_dir(mc.join(".mim/profile-backups")).unwrap().count(), 6);
        fs::remove_dir_all(&mc).unwrap();
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
        .register_asynchronous_uri_scheme_protocol("thumb", |_ctx, req, responder| {
            let path = req.uri().path().to_string();
            std::thread::spawn(move || {
                let res = tauri::http::Response::builder()
                    .header("Access-Control-Allow-Origin", "*") // lets the viewer read pixels for its palette
                    .header("Cache-Control", "max-age=31536000");
                responder.respond(match screenshot_thumb(&path) {
                    Ok(bytes) => res.header("Content-Type", "image/jpeg").body(bytes),
                    Err(e) => res.status(404).body(e.into_bytes()),
                }
                .unwrap());
            });
        })
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
            create_standard,
            delete_standard,
            link_standard,
            unlink_standard,
            link_states,
            share_config,
            set_custom_icon,
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
            resolve_link,
            import_links,
            update_mods,
            list_config,
            read_config,
            write_config,
            list_packs,
            set_packs,
            add_packs,
            list_screenshots,
            purge_cache,
            list_profiles,
            relink_profile,
            move_profile,
            archive_profile,
            restore_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
