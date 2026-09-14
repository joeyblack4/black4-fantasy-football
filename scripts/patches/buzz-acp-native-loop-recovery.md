# Buzz native loop recovery patch

Source: `/Users/joey/.buzz/.scratch/buzz-source`, upstream commit `b238beffaf907ecf0125dbec71bd8d5ccd1883e9`.
Patch: `buzz-acp-native-loop-recovery.patch` in this directory.

Qwen ACP returns code `-32603` with the exact message `Tool-call loop protection stopped this turn. The session is still available; send a more specific instruction to continue.` when native turn containment fires. The original Buzz harness classifies it as a generic application error and replays the batch. This patch recognizes only that exact code/message pair, leaves a visible failed-request notice immediately, preserves the original error in the observer, and invalidates only the failed prompt source session. Independent future work uses a fresh native session. It does not automatically retry or create new tasks, and does not undo earlier tool actions. Other channels, transport, auth handling, timeout behavior and ordinary transient retries are preserved.

Build and verify in a clean checkout at the source commit:

```sh
. ./bin/activate-hermit
git apply /absolute/path/to/buzz-acp-native-loop-recovery.patch
cargo fmt -p buzz-acp -- --check
cargo test -p buzz-acp --lib error_outcome_emission_tests
cargo build --release -p buzz-acp
```

September 13 verification: all 28 error-outcome tests passed, including two new tests covering precise classification and no replay with isolated session invalidation. Formatting and diff whitespace checks passed; release build succeeded.

Separate prepared artifact: `.local/tooling/qwen-recovery/buzz-acp`.
SHA256: `deec46063fcfcffc0dc58af00d03f2c3f39bef4d6383cac93a2aeced92db109d`.
The shared `.local/tooling/bin/buzz-acp` was not modified. This artifact alone does not prove a live owner turn; deployment and real-turn verification are separate.
