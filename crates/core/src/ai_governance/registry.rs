use shadowshield_protocol::{AiService, AiServiceClassification, AiServiceId};
use std::collections::HashMap;

#[derive(Debug, PartialEq, Eq)]
pub enum RegistryError {
    DuplicateRegistration,
}

pub struct AiServiceRegistry {
    services: HashMap<AiServiceId, AiService>,
}

impl AiServiceRegistry {
    pub fn new() -> Self {
        Self {
            services: HashMap::new(),
        }
    }

    pub fn register(&mut self, service: AiService) -> Result<(), RegistryError> {
        if self.services.contains_key(&service.id) {
            return Err(RegistryError::DuplicateRegistration);
        }
        self.services.insert(service.id.clone(), service);
        Ok(())
    }

    pub fn lookup(&self, id: &AiServiceId) -> Option<&AiService> {
        self.services.get(id)
    }

    pub fn classification(&self, id: &AiServiceId) -> AiServiceClassification {
        match self.lookup(id) {
            Some(service) => service.classification.clone(),
            None => AiServiceClassification::Unknown,
        }
    }

    pub fn list(&self) -> Vec<&AiService> {
        self.services.values().collect()
    }

    /// Creates a default registry populated strictly for test/baseline purposes.
    /// This DOES NOT assign universal classification defaults.
    pub fn new_with_defaults() -> Self {
        let mut registry = Self::new();

        let _ = registry.register(AiService {
            id: AiServiceId::new("chatgpt").unwrap(),
            display_name: "ChatGPT".to_string(),
            vendor: "OpenAI".to_string(),
            classification: AiServiceClassification::Unknown, // No hardcoded trust
        });

        let _ = registry.register(AiService {
            id: AiServiceId::new("claude").unwrap(),
            display_name: "Claude".to_string(),
            vendor: "Anthropic".to_string(),
            classification: AiServiceClassification::Unknown,
        });

        let _ = registry.register(AiService {
            id: AiServiceId::new("gemini").unwrap(),
            display_name: "Gemini".to_string(),
            vendor: "Google".to_string(),
            classification: AiServiceClassification::Unknown,
        });

        registry
    }
}

impl Default for AiServiceRegistry {
    fn default() -> Self {
        Self::new_with_defaults()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_operations() {
        let mut registry = AiServiceRegistry::new();
        let id = AiServiceId::new("test").unwrap();
        let service = AiService {
            id: id.clone(),
            display_name: "Test AI".to_string(),
            vendor: "Test Vendor".to_string(),
            classification: AiServiceClassification::Approved,
        };

        // Register
        assert_eq!(registry.register(service.clone()), Ok(()));

        // Duplicate
        assert_eq!(
            registry.register(service.clone()),
            Err(RegistryError::DuplicateRegistration)
        );

        // Lookup
        assert_eq!(registry.lookup(&id), Some(&service));

        // Classification
        assert_eq!(
            registry.classification(&id),
            AiServiceClassification::Approved
        );

        // Unknown Classification
        let unknown_id = AiServiceId::new("unknown").unwrap();
        assert_eq!(
            registry.classification(&unknown_id),
            AiServiceClassification::Unknown
        );
        assert_eq!(registry.lookup(&unknown_id), None);

        // List
        assert_eq!(registry.list().len(), 1);
    }
}
