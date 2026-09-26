use std::process::Command;
use serde::{Deserialize, Serialize};

pub fn is_goal_limited(thread_id: &str) -> bool {
    let db_path = dirs::home_dir().unwrap_or_default().join(".codex/goals_1.sqlite");
    
    let query = format!(
        "SELECT status FROM thread_goals WHERE thread_id = '{}' AND status IN ('usage_limited', 'budget_limited') LIMIT 1;",
        thread_id
    );

    if let Ok(output) = Command::new("sqlite3")
        .arg(db_path)
        .arg(&query)
        .output() 
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        return !stdout.trim().is_empty();
    }
    
    false
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TurnInfo {
    pub turn_id: String,
    pub status: String,
}

pub fn get_latest_turn(thread_id: &str) -> Option<TurnInfo> {
    let db_path = dirs::home_dir().unwrap_or_default().join(".codex/thread_history_1.sqlite");
    
    let query = format!(
        "SELECT turn_id, status FROM thread_turns WHERE thread_id = '{}' ORDER BY rollout_ordinal DESC LIMIT 1;",
        thread_id
    );

    if let Ok(output) = Command::new("sqlite3")
        .arg(db_path)
        .arg(&query)
        .output() 
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let trimmed = stdout.trim();
        if !trimmed.is_empty() {
            let parts: Vec<&str> = trimmed.split('|').collect();
            if parts.len() >= 2 {
                return Some(TurnInfo {
                    turn_id: parts[0].to_string(),
                    status: parts[1].to_string(),
                });
            }
        }
    }
    
    None
}
