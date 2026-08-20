use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Wry};

/// Build a custom item that reports back to the web app by id.
fn item(app: &AppHandle, id: &str, label: &str, accel: Option<&str>) -> tauri::Result<MenuItem<Wry>> {
    let mut b = MenuItemBuilder::new(label).id(id);
    if let Some(a) = accel {
        b = b.accelerator(a);
    }
    b.build(app)
}

/// The macOS menu bar.
///
/// Undo/redo are deliberately *custom* items rather than the predefined ones:
/// a native Edit > Undo would swallow Cmd-Z before it ever reached the web
/// view, and the app's own history is what the user actually wants back.
/// Cut/copy/paste stay predefined so text fields behave normally.
fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let app_menu = SubmenuBuilder::new(app, "Timeline")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&item(app, "new-item", "New Item", Some("CmdOrCtrl+N"))?)
        .separator()
        .item(&item(app, "export", "Export JSON…", Some("CmdOrCtrl+Shift+E"))?)
        .item(&item(app, "import", "Import JSON…", Some("CmdOrCtrl+Shift+I"))?)
        .separator()
        .close_window()
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&item(app, "undo", "Undo", Some("CmdOrCtrl+Z"))?)
        .item(&item(app, "redo", "Redo", Some("CmdOrCtrl+Shift+Z"))?)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item(app, "find", "Search…", Some("CmdOrCtrl+F"))?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item(app, "today", "Go to Today", Some("CmdOrCtrl+T"))?)
        .separator()
        .item(&item(app, "zoom-in", "Zoom In", Some("CmdOrCtrl+="))?)
        .item(&item(app, "zoom-out", "Zoom Out", Some("CmdOrCtrl+-"))?)
        .separator()
        .item(&item(app, "expand-all", "Expand All", None)?)
        .item(&item(app, "collapse-all", "Collapse All", None)?)
        .separator()
        .item(&item(app, "toggle-minimap", "Overview Strip", None)?)
        .item(&item(app, "toggle-theme", "Toggle Dark Mode", None)?)
        .separator()
        .fullscreen()
        .build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &window])
        .build()?;

    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let _ = app.emit("menu", event.id().0.clone());
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            build_menu(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
