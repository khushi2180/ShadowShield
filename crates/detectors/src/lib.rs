use shadowshield_protocol::{Detection, DetectorId, SensitiveText};

pub mod email;
pub mod ipv4;
pub mod ipv6;
pub mod jwt;
pub mod payment_card;
pub mod private_key;
pub mod stripe;

pub trait Detector {
    fn id(&self) -> &DetectorId;

    /// Inspect pure text context and return any detections.
    /// Does not have access to telemetry, network, filesystem, etc.
    /// Access to the underlying raw content should be deliberate via `content.expose()`.
    fn inspect(&self, content: &SensitiveText) -> Vec<Detection>;
}

pub struct DetectorRegistry {
    detectors: Vec<Box<dyn Detector>>,
}

impl DetectorRegistry {
    pub fn new() -> Self {
        Self {
            detectors: Vec::new(),
        }
    }

    pub fn register(&mut self, detector: Box<dyn Detector>) {
        self.detectors.push(detector);
    }

    pub fn inspect_all(&self, content: &SensitiveText) -> Vec<Detection> {
        let mut all_detections = Vec::new();
        for detector in &self.detectors {
            let mut detections = detector.inspect(content);
            all_detections.append(&mut detections);
        }
        all_detections
    }
}

impl Default for DetectorRegistry {
    fn default() -> Self {
        Self::new()
    }
}
