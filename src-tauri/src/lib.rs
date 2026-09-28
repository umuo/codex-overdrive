use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Command;
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

#[tauri::command]
fn start_caffeinate() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("caffeinate")
            .args(["-d", "-i", "-m", "-s"])
            .spawn()
            .map(|_| "Caffeinate started".to_string())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok("Sleep prevention skipped on non-macOS platforms.".to_string())
    }
}

#[tauri::command]
fn stop_caffeinate() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("killall")
            .arg("caffeinate")
            .status()
            .map(|_| "Caffeinate stopped".to_string())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok("Sleep prevention skipped on non-macOS platforms.".to_string())
    }
}



#[tauri::command]
fn get_session_status(session_id: String) -> Result<Option<db::TurnInfo>, String> {
    Ok(db::get_latest_turn(&session_id))
}

#[tauri::command]
fn trigger_via_cli(session_id: String, message: String) -> Result<String, String> {
    trigger::trigger_via_cli(&session_id, &message)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
