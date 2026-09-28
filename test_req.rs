#[tokio::main]
async fn main() {
    let res = reqwest::get("https://chatgpt.com/backend-api/wham/usage").await;
    println!("{:?}", res);
}
