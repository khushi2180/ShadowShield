# Fixture Storage Policy

Provider-published test credentials may themselves match GitHub/GitLab/other secret scanners. Therefore:

- Complete secret-shaped credentials should not be committed literally.
- Push protection must never be bypassed merely because a credential is a test fixture.
- Approved secret fixtures may use safe test-time reconstruction (e.g. string concatenation) to prevent triggering static scanning on the repository.
- Provenance must still identify the authoritative source.
- Reconstruction must produce exactly the maintainer-approved fixture.
- Coding agents may not invent fragments representing a different credential.
- Production/live credentials remain prohibited.
