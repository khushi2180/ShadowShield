# System Overview

ShadowShield comprises several conceptual boundaries:

* **agent**: The background daemon handling inspection execution.
* **tray**: The UI (Windows tray, macOS menu bar) providing status and settings.
* **extension**: A browser extension (Manifest V3) that observes user inputs bound for AI services.
* **core**: The security logic orchestrating detection and policy application.
* **detectors**: Implementations of algorithms matching patterns (secrets, PII, etc.).
* **ML runtime**: The engine (future) that runs local model inference using ONNX.
* **backend**: A future cloud control plane for centralized policy.
* **dashboard**: A future web interface for managing the platform.

## Architecture

```text
+-------------------+
|      Browser      |
|  +-------------+  |
|  |  Extension  |  |
|  +------+------+  |
+---------|---------+
          |
    Native Messaging
          |
+---------v---------+
|   ShadowShield    |
|       Agent       |
|  +-------------+  |
|  |    Core     |  |
|  +-------------+  |
|  |  Detectors  |  |
|  +-------------+  |
|  | ML Runtime  |  |
|  +-------------+  |
+-------------------+
```
