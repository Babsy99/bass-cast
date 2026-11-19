// Bass Cast spike: the whole game lives in the web view (TypeScript + three.js).
// No custom commands, no plugins, no updater: default Tauri permissions only.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Bass Cast");
}
