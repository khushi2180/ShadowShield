#[derive(Debug, Clone)]
pub struct InspectionRequest {
    pub request_id: String,
    pub source: String,
    pub ai_service: String,
    pub content: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone)]
pub struct InspectionResult {
    pub request_id: String,
    pub detections: Vec<Detection>,
    pub risk: RiskLevel,
    pub action: PolicyAction,
}

#[derive(Debug, Clone)]
pub struct Detection {
    pub category: DetectionCategory,
}

#[derive(Debug, Clone)]
pub enum DetectionCategory {
    Secret,
    Credential,
    PII,
    SourceCode,
}

#[derive(Debug, Clone)]
pub enum RiskLevel {
    None,
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone)]
pub enum PolicyAction {
    Allow,
    Coach,
    Redact,
    Block,
}

#[derive(Debug, Clone)]
pub struct SecurityEvent {
    pub timestamp: u64,
}
