fn main() {
    let attributes = tauri_build::Attributes::new();
    let target = std::env::var("TARGET").expect("Cargo sets TARGET");
    let attributes = if target.ends_with("-windows-msvc") {
        // Embed the Common Controls manifest in test executables as well as the app.
        let manifest =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    } else {
        attributes
    };
    tauri_build::try_build(attributes).expect("Tauri build setup failed");
}
