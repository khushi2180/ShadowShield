use log::info;
use shadowshield_core::Inspector;

fn main() {
    env_logger::init();
    info!("ShadowShield Agent starting");
    
    // Initialize the core inspection engine
    let _inspector = Inspector::new();
    info!("Inspection engine initialized");
    
    // In Phase 1A, the detector registry starts empty
    info!("Detectors loaded: 0");
    
    info!("Status: ready");
}
