pub trait Detector {
    fn name(&self) -> &str;
}

pub struct DummyDetector;

impl Detector for DummyDetector {
    fn name(&self) -> &str {
        "Dummy"
    }
}
