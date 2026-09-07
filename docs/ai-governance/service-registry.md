# AI Service Registry

The `AiServiceRegistry` is an in-memory component that maps an `AiServiceId` to its canonical `AiService` definition.

## Identity vs Discovery
The registry tracks **Identity** (who the vendor is, what the product is). It explicitly does NOT track **Discovery Mechanisms** (e.g., domains like `chatgpt.com` or DOM selectors). Those are implemented in browser-specific adapters. This prevents brittle UI changes from breaking the core security registry.

## Classifications
Every service in the registry carries a classification:
- **Approved**: Explicitly sanctioned by the organization.
- **Restricted**: Permitted under conditions, but may trigger stricter downstream policies.
- **Blocked**: Explicitly prohibited.
- **Unknown**: The service is not registered, or no explicit classification has been assigned.

## Unknown Semantics
`Unknown` does not inherently mean malicious. It simply means the organization has not yet classified the service. Depending on the `AiAccessMode`, an `Unknown` service may be allowed, coached, or blocked.

## Duplicate Registration
The registry prioritizes immutability and predictability. Attempting to register an `AiServiceId` that already exists results in a `RegistryError::DuplicateRegistration`.
