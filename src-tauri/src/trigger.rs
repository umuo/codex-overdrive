use std::process::Command;

pub fn trigger_via_cli(session_id: &str, message: &str) -> Result<String, String> {
    let cli_path = "/Applications/ChatGPT.app/Contents/Resources/codex";
    
    let output = Command::new(cli_path)
        .arg("queue")
        .arg("--thread")
        .arg(session_id)
        .arg("--message")
        .arg(message)
        .output()
        .map_err(|e| format!("CLI execution failed: {}", e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(format!("Successfully queued message via CLI: {}", stdout.trim()))
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}
