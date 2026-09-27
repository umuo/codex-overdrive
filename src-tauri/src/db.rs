use serde::{Deserialize, Serialize};
use rusqlite::Connection;

pub fn is_goal_limited(thread_id: &str) -> bool {
    let db_path = dirs::home_dir().unwrap_or_default().join(".codex/goals_1.sqlite");
    
    if !db_path.exists() {
        return false;
    }

    if let Ok(conn) = Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
    ) {
        let query = format!(
            "SELECT status FROM thread_goals WHERE thread_id = '{}' AND status IN ('usage_limited', 'budget_limited') LIMIT 1;",
            thread_id
        );

        if let Ok(mut stmt) = conn.prepare(&query) {
            if let Ok(mut rows) = stmt.query([]) {
                if let Ok(Some(_)) = rows.next() {
                    return true;
                }
            }
        }
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
    
    if !db_path.exists() {
        return None;
    }

    if let Ok(conn) = Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
    ) {
        let query = format!(
            "SELECT turn_id, status FROM thread_turns WHERE thread_id = '{}' ORDER BY rollout_ordinal DESC LIMIT 1;",
            thread_id
        );

        if let Ok(mut stmt) = conn.prepare(&query) {
            if let Ok(mut rows) = stmt.query([]) {
                if let Ok(Some(row)) = rows.next() {
                    if let (Ok(turn_id), Ok(status)) = (row.get::<_, String>(0), row.get::<_, String>(1)) {
                        return Some(TurnInfo {
                            turn_id,
                            status,
                        });
                    }
                }
            }
        }
    }
    
    None
}
