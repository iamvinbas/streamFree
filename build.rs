// Embeds the app icon and version info into the Windows executable.
fn main() {
    println!("cargo:rerun-if-changed=packaging/icons/streamfree.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("packaging/icons/streamfree.ico")
            .set("ProductName", "streamFree")
            .set("FileDescription", "streamFree live-streaming studio");
        if let Err(e) = res.compile() {
            println!("cargo:warning=could not embed the Windows icon: {e}");
        }
    }
}
