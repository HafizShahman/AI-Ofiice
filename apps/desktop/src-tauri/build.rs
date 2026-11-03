// Commands must be declared here so pages served from the local server (a remote origin to Tauri)
// can be granted them in capabilities/default.json.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["set_blocked"])),
    )
    .expect("failed to run tauri-build");
}
