use shadowshield_protocol::{Detection, DetectorId, SensitiveText};

use crate::Detector;

pub struct PhoneNumberDetector {
    id: DetectorId,
}

impl PhoneNumberDetector {
    pub fn new() -> Self {
        Self {
            id: DetectorId::new("pii.contact.phone").unwrap(),
        }
    }
}

impl Default for PhoneNumberDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl Detector for PhoneNumberDetector {
    fn id(&self) -> &DetectorId {
        &self.id
    }

    fn inspect(&self, _content: &SensitiveText) -> Vec<Detection> {
        // Implementation is BLOCKED_BY_DEPENDENCY_DECISION.
        // We refuse to write a giant monolithic regex for international phone numbers.
        // We require maintainer decision on a robust, offline, non-networking phone parsing crate.
        Vec::new()
    }
}
