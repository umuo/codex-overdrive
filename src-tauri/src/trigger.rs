use std::process::Command;

pub fn trigger_via_cli(session_id: &str, message: &str) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    let cli_path = {
        let p1 = std::path::Path::new("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
        let p2 = std::path::Path::new("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
        if p1.exists() {
            p1.to_str().unwrap()
        } else if p2.exists() {
            p2.to_str().unwrap()
        } else {
            "codex"
        }
    };
    
    #[cfg(target_os = "windows")]
    let cli_path = "codex.exe"; // Windows 用户通常需要把 codex.exe 加入环境变量

    #[cfg(target_os = "linux")]
    let cli_path = "codex";

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
