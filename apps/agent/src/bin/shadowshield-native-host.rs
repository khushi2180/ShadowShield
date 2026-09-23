use log::info;

fn main() {
    // CRITICAL INVARIANT: stdout must be pristine for Native Messaging
    // We strictly use stderr for all logging
    let mut builder = env_logger::Builder::from_default_env();
    builder.target(env_logger::Target::Stderr);
    builder.init();

    info!("Starting ShadowShield Native Host");
    shadowshield_agent::protocol_handler::run_host_mode();
    info!("Native host terminated");
}
