use log::info;
use shadowshield_core::Engine;

fn main() {
    env_logger::init();
    info!("ShadowShield Agent starting");
    info!("Version: 0.1.0-dev");
    
    #[cfg(target_os = "windows")]
    info!("Platform: Windows");
    
    #[cfg(target_os = "macos")]
    info!("Platform: macOS");
    
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    info!("Platform: Unknown");

    let _engine = Engine::new();
    
    info!("Status: ready");
}
