<plan>
<task type="auto">
  <name>Initialize JSONL Telemetry Pipeline</name>
  <files>engine-worker/src/db/mod.rs</files>
  <action>
    - Instead of fighting `sqlx` and `solana-client` dependency conflicts over `zeroize`, implement a pure-rust JSON Lines append-only logger targeting `engine-worker/telemetry.jsonl`.
    - Revise `engine-worker/src/db/mod.rs` to structure `TradeLogEvent` as JSON and securely append to the file.
    - Revise the Next.js API `src/app/api/logs/route.ts` to utilize `fs` module to parse that `.jsonl` file backwards to serve the latest 10 items statically.
  </action>
  <verify>Worker correctly yields a local telemetry file, and frontend renders it without mocked arrays.</verify>
  <done>Telemetry is globally functional.</done>
</task>
</plan>
