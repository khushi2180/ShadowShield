# ADR-008: Sensitive Text Wrapper

## Context
Raw sensitive content must not be accidentally logged or dumped in debug output during runtime crashes or internal traces. The `String` type defaults to transparent `Debug` implementations.

## Decision
We introduced a `SensitiveText` wrapper type to contain the input content. We implemented a custom `Debug` trait for `SensitiveText` that hardcodes the output to `SensitiveText(<redacted>)`.

## Consequences
* Prevents accidental leakage in `unwrap()`, `panic!()`, or logging calls.
* Forces explicit `.as_str()` calls when the content actually needs to be inspected.
* True memory zeroing is out of scope for Phase 1A.

## Status
Accepted
