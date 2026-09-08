use log::info;
use shadowshield_core::Inspector;
use std::env;

mod native_messaging;
mod protocol_handler;

fn main() {
    let args: Vec<String> = env::args().collect();
    let is_native_host = args.iter().any(|arg| arg == "--native-host");

    if is_native_host {
        // CRITICAL INVARIANT: stdout must be pristine for Native Messaging
        // Do not use env_logger or any other logger that writes to stdout.
        // For simplicity, we initialize env_logger which targets stderr by default in modern versions,
        // but to be absolutely safe we should ensure it only goes to stderr.
        let mut builder = env_logger::Builder::from_default_env();
        builder.target(env_logger::Target::Stderr);
        builder.init();

        info!("Starting ShadowShield Agent in native host mode");
        protocol_handler::run_host_mode();
        info!("Native host mode terminated");
    } else {
        env_logger::init();
        info!("ShadowShield Agent starting in normal mode");

        // Initialize the core inspection engine
        let inspector = Inspector::new();
        info!("Inspection engine initialized");
        info!(
            "Detectors loaded: {}",
            inspector.registered_detectors_count()
        );
        info!("Status: ready");
    }
}
