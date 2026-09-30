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
    pub is_usage_limited: bool,
}

fn is_usage_limit_error(error_json: Option<&str>) -> bool {
    error_json
        .and_then(|error| serde_json::from_str::<serde_json::Value>(error).ok())
        .and_then(|error| error.get("codexErrorInfo").cloned())
        .is_some_and(|info| info.as_str() == Some("usageLimitExceeded"))
}

fn latest_turn(conn: &Connection, thread_id: &str) -> rusqlite::Result<Option<TurnInfo>> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT turn_id, status, error_json FROM thread_turns WHERE thread_id = ?1 ORDER BY rollout_ordinal DESC LIMIT 1",
        [thread_id],
        |row| {
            let error: Option<String> = row.get(2)?;
            Ok(TurnInfo {
                turn_id: row.get(0)?,
                status: row.get(1)?,
                is_usage_limited: is_usage_limit_error(error.as_deref()),
            })
        },
    ).optional()
}

pub fn get_latest_turn(thread_id: &str) -> Result<Option<TurnInfo>, String> {
    let db_path = dirs::home_dir().unwrap_or_default().join(".codex/thread_history_1.sqlite");
    let conn = Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ).map_err(|e| e.to_string())?;
    latest_turn(&conn, thread_id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_usage_limit_errors_qualify() {
        assert!(is_usage_limit_error(Some(r#"{"codexErrorInfo":"usageLimitExceeded"}"#)));
        for error in [None, Some("invalid"), Some(r#"{"message":"usage limit"}"#),
            Some(r#"{"codexErrorInfo":"budgetLimitExceeded"}"#),
            Some(r#"{"codexErrorInfo":"networkError"}"#)] {
            assert!(!is_usage_limit_error(error));
        }
    }

    #[test]
    fn latest_turn_uses_its_own_error_and_parameterized_thread_id() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, status TEXT, error_json TEXT, rollout_ordinal INTEGER);").unwrap();
        conn.execute("INSERT INTO thread_turns VALUES (?1, 'old', 'failed', ?2, 1)",
            ["thread'1", r#"{"codexErrorInfo":"usageLimitExceeded"}"#]).unwrap();
        assert!(latest_turn(&conn, "thread'1").unwrap().unwrap().is_usage_limited);
        conn.execute("INSERT INTO thread_turns VALUES (?1, 'new', 'completed', NULL, 2)", ["thread'1"]).unwrap();
        let turn = latest_turn(&conn, "thread'1").unwrap().unwrap();
        assert_eq!(turn.turn_id, "new");
        assert!(!turn.is_usage_limited);
        assert!(latest_turn(&conn, "missing").unwrap().is_none());
        conn.execute_batch("DROP TABLE thread_turns").unwrap();
        assert!(latest_turn(&conn, "thread'1").is_err());
    }
}
