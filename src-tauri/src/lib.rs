use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::{Child, Command};
#[cfg(target_os = "macos")]
use std::sync::Mutex;
use tauri::Manager;
use serde::{Deserialize, Serialize};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde_json::Value;

pub mod trigger;
pub mod db;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Session {
    pub id: String,
    pub thread_name: String,
    pub updated_at: String,
    pub is_goal_limited: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct QuotaState {
    pub allowed: bool,
    pub used_percent: f64,
    pub reset_at: Option<u64>,
    pub error: Option<String>,
}

fn get_codex_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".codex")
}

#[tauri::command]
fn get_sessions() -> Result<Vec<Session>, String> {
    let index_path = get_codex_dir().join("session_index.jsonl");
    let file = File::open(&index_path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut sessions = Vec::new();

    for line in reader.lines() {
        if let Ok(line_content) = line {
            if let Ok(session) = serde_json::from_str::<serde_json::Value>(&line_content) {
                let id = session["id"].as_str().unwrap_or("").to_string();
                let thread_name = session["thread_name"].as_str().unwrap_or("").to_string();
                let updated_at = session["updated_at"].as_str().unwrap_or("").to_string();
                
                let is_goal_limited = db::is_goal_limited(&id);
                
                sessions.push(Session {
                    id,
                    thread_name,
                    updated_at,
                    is_goal_limited,
                });
            }
        }
    }
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(sessions)
}

#[tauri::command]
async fn check_quota() -> Result<QuotaState, String> {
    let auth_path = get_codex_dir().join("auth.json");
    let auth_data = std::fs::read_to_string(&auth_path).map_err(|e| e.to_string())?;
    let auth_json: Value = serde_json::from_str(&auth_data).map_err(|e| e.to_string())?;
    
    let access_token = auth_json["tokens"]["access_token"].as_str().ok_or("No access token")?;
    let account_id = auth_json["tokens"]["account_id"].as_str();

    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {}", access_token)).map_err(|e| e.to_string())?);
    
    if let Some(acc_id) = account_id {
        if let Ok(val) = HeaderValue::from_str(acc_id) {
            headers.insert("chatgpt-account-id", val);
        }
    }

    let client = reqwest::Client::builder()
        .use_native_tls()
        .build()
        .map_err(|e| e.to_string())?;
    
    let res = client.get("https://chatgpt.com/backend-api/wham/usage")
        .headers(headers)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Ok(QuotaState { allowed: false, used_percent: 0.0, reset_at: None, error: Some(format!("HTTP {}", res.status())) });
    }

    let usage: Value = res.json().await.map_err(|e| e.to_string())?;
    let rate_limit = &usage["rate_limit"];
    
    let allowed = rate_limit["allowed"].as_bool().unwrap_or(false);
    let primary = &rate_limit["primary_window"];
    let used_percent = primary["used_percent"].as_f64().unwrap_or(0.0);
    let reset_at = primary["reset_at"].as_u64();

    Ok(QuotaState {
        allowed,
        used_percent,
        reset_at,
        error: None,
    })
}

#[derive(Default)]
struct SleepPrevention {
    #[cfg(target_os = "macos")]
    child: Mutex<Option<Child>>,
}

impl SleepPrevention {
    fn start(&self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            let mut child = self.child.lock().map_err(|e| e.to_string())?;
            if let Some(process) = child.as_mut() {
                if process.try_wait().map_err(|e| e.to_string())?.is_none() {
                    return Ok(());
                }
            }
            *child = None;
            // Also release assertions if the parent exits unexpectedly.
            *child = Some(Command::new("caffeinate")
                .args(["-d", "-i", "-m", "-s", "-w"])
                .arg(std::process::id().to_string())
                .spawn()
                .map_err(|e| e.to_string())?);
        }
        Ok(())
    }

    fn stop(&self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            let mut child = self.child.lock().map_err(|e| e.to_string())?;
            if let Some(process) = child.as_mut() {
                if process.try_wait().map_err(|e| e.to_string())?.is_none() {
                    process.kill().map_err(|e| e.to_string())?;
                    process.wait().map_err(|e| e.to_string())?;
                }
            }
            *child = None;
        }
        Ok(())
    }
}

impl Drop for SleepPrevention {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::SleepPrevention;

    #[test]
    fn sleep_prevention_is_idempotent_and_only_stops_its_own_child() {
        let first = SleepPrevention::default();
        let second = SleepPrevention::default();
        first.start().unwrap();
        second.start().unwrap();
        let pid = first.child.lock().unwrap().as_ref().unwrap().id();
        first.start().unwrap();
        assert_eq!(first.child.lock().unwrap().as_ref().unwrap().id(), pid);
        first.stop().unwrap();
        first.stop().unwrap();
        assert!(first.child.lock().unwrap().is_none());
        assert!(second.child.lock().unwrap().as_mut().unwrap().try_wait().unwrap().is_none());
        second.stop().unwrap();
    }
}

#[tauri::command]
fn start_caffeinate(state: tauri::State<'_, SleepPrevention>) -> Result<(), String> {
    state.start()
}

#[tauri::command]
fn stop_caffeinate(state: tauri::State<'_, SleepPrevention>) -> Result<(), String> {
    state.stop()
}

#[tauri::command]
fn get_session_status(session_id: String) -> Result<Option<db::TurnInfo>, String> {
    db::get_latest_turn(&session_id)
}

#[tauri::command]
fn trigger_via_cli(session_id: String, message: String) -> Result<String, String> {
    trigger::trigger_via_cli(&session_id, &message)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SleepPrevention::default())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_sessions,
            check_quota,
            start_caffeinate,
            stop_caffeinate,
            trigger_via_cli,
            get_session_status
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Err(error) = app.state::<SleepPrevention>().stop() {
                    eprintln!("Failed to stop sleep prevention: {error}");
                }
            }
        });
}
