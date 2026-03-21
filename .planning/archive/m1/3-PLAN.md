<plan>
<task type="auto">
  <name>Build Arbitrage Engine Vault Integration</name>
  <files>engine-worker/src/engine/mod.rs</files>
  <action>
    - Refactor `TenantExecutor` to `VaultExecutor`.
    - Implement a `build_vault_ptb` function which wraps raw arbitrage swap instructions with the Vault's `borrow_for_arbitrage` and `process_arbitrage` instructions.
    - Compute discriminators dynamically for Anchor using `solana_sdk::hash::hash` (`global:borrow_for_arbitrage` and `global:process_arbitrage`).
    - Output informative struct logs about the assembled transaction targeting the Jito bundle framework.
  </action>
  <verify>The Rust code compiles and contains correct Web3 definitions mirroring the Vault's interfaces.</verify>
  <done>The engine is tightly bound to PocketChange mechanics, ready to execute MEV bundles natively.</done>
</task>
</plan>
