// AI Office in its own window. The window is only a viewer of the local server (the same UI you get
// in a browser at http://127.0.0.1:3334): it starts the server if nothing answers, keeps a tray icon
// with the blocked-agent count, and can open the wallboard as an always-on-top window.
// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{create_dir_all, OpenOptions},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread::sleep,
    time::Duration,
};

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

/// The server this app started (if any), stopped again on quit. A server that was already running
/// (a login item, `npm run dev`) is left alone.
struct Server(Mutex<Option<Child>>);

fn port() -> u16 {
    std::env::var("AI_OFFICE_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3334)
}

/// The project folder: `AI_OFFICE_ROOT`, else the checkout this app was built from.
fn root() -> PathBuf {
    std::env::var_os("AI_OFFICE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
}

fn server_up(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300)).is_ok()
}

/// A GUI app doesn't get the shell's PATH, so look for Node in the usual places first.
fn node() -> String {
    if let Ok(n) = std::env::var("AI_OFFICE_NODE") {
        return n;
    }
    let candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
        r"C:\Program Files\nodejs\node.exe",
    ];
    candidates.iter().find(|p| Path::new(p).exists()).map(|p| p.to_string()).unwrap_or_else(|| "node".into())
}

fn start_server(root: &Path, port: u16) -> Option<Child> {
    let data = root.join(".data");
    create_dir_all(&data).ok()?;
    let log = OpenOptions::new().create(true).append(true).open(data.join("server.log")).ok()?;
    let mut cmd = Command::new(node());
    cmd.args(["--disable-warning=ExperimentalWarning", "apps/server/src/index.ts"])
        .current_dir(root)
        .env("PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(log.try_clone().ok()?)
        .stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn().ok()
}

/// Closing the office window hides it: the app keeps running in the tray.
fn hide_on_close(window: &WebviewWindow) {
    let w = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = w.hide();
        }
    });
}

fn show(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn open_office(app: &AppHandle, base: &str) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("main") {
        show(&w);
        return Ok(());
    }
    let w = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(base.parse().unwrap()))
        .title("AI Office")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .build()?;
    hide_on_close(&w);
    Ok(())
}

fn open_wallboard(app: &AppHandle, base: &str) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("wallboard") {
        show(&w);
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "wallboard", WebviewUrl::External(format!("{base}/?wallboard").parse().unwrap()))
        .title("AI Office · Wallboard")
        .inner_size(1280.0, 720.0)
        .always_on_top(true)
        .build()?;
    Ok(())
}

/// Called by the web app (ui/desktop.ts) whenever the number of blocked agents changes.
#[tauri::command]
fn set_blocked(app: AppHandle, count: u32) {
    #[cfg(debug_assertions)]
    eprintln!("set_blocked({count})");
    if let Some(tray) = app.tray_by_id("main") {
        let title = if count > 0 { Some(count.to_string()) } else { None };
        let _ = tray.set_title(title);
        let tip = if count > 0 { format!("AI Office · {count} blocked") } else { "AI Office".to_string() };
        let _ = tray.set_tooltip(Some(tip));
    }
}

fn main() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![set_blocked])
        .setup(|app| {
            let port = port();
            let base = format!("http://127.0.0.1:{port}");

            let child = if server_up(port) { None } else { start_server(&root(), port) };
            app.manage(Server(Mutex::new(child)));
            for _ in 0..40 {
                if server_up(port) {
                    break;
                }
                sleep(Duration::from_millis(250));
            }

            let show_item = MenuItem::with_id(app, "show", "Show office", true, None::<&str>)?;
            let wall_item = MenuItem::with_id(app, "wallboard", "Wallboard (always on top)", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit AI Office", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &wall_item, &quit_item])?;
            let tray_base = base.clone();
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("AI Office")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        let _ = open_office(app, &tray_base);
                    }
                    "wallboard" => {
                        let _ = open_wallboard(app, &tray_base);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            open_office(app.handle(), &base)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building AI Office");

    app.run(|app, event| match event {
        // (closing the office window only hides it, so it still counts as open and the app stays in the tray)
        RunEvent::Exit => {
            if let Some(server) = app.try_state::<Server>() {
                if let Some(mut child) = server.0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        }
        _ => {}
    });
}
