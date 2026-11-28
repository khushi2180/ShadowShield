use log::{error, info};
use shadowshield_core::Inspector;
use std::env;
use std::sync::Arc;

fn main() {
    let args: Vec<String> = env::args().collect();
    let is_native_host = args.iter().any(|arg| arg == "--native-host");

    if is_native_host {
        // CRITICAL INVARIANT: stdout must be pristine for Native Messaging
        // Do not use env_logger or any other logger that writes to stdout.
        let mut builder = env_logger::Builder::from_default_env();
        builder.target(env_logger::Target::Stderr);
        builder.init();

        info!("Starting ShadowShield Agent in native host mode (legacy compat)");
        shadowshield_agent::protocol_handler::run_host_mode();
        info!("Native host mode terminated");
    } else {
        env_logger::init();
        info!("ShadowShield Agent starting in daemon mode (V2 IPC)");

        // Initialize the core inspection engine
        let inspector = Inspector::new();
        info!("Inspection engine initialized");
        info!(
            "Detectors loaded: {}",
            inspector.registered_detectors_count()
        );
        info!("Status: ready");

        let config = shadowshield_agent::ipc::IpcServerConfig::default();
        let server =
            match shadowshield_agent::ipc::IpcServer::with_inspector(config, Arc::new(inspector)) {
                Ok(s) => s,
                Err(e) => {
                    error!("Failed to initialize ShadowShield IPC daemon: {:?}", e);
                    std::process::exit(1);
                }
            };

        server.run();
    }
}
