<plan>
<task type="auto">
  <name>Integrate Jupiter V6 Swap Routes into VaultExecutor</name>
  <files>engine-worker/src/engine/mod.rs</files>
  <action>
    - Ensure `reqwest` and `serde_json` are configured for asynchronous requests.
    - Add a method to `VaultExecutor` called `fetch_jupiter_swap` that calls `https://quote-api.jup.ag/v6/quote` (with USDC and a target token).
    - Add a method `fetch_jupiter_instructions` that hits `https://quote-api.jup.ag/v6/swap-instructions` to deserialize the JSON back into raw `solana_sdk::instruction::Instruction` formats.
    - Format a pseudo `process_loop` function that runs the Jupiter quote logic, verifies positive yield, and packages the results to `build_vault_ptb`.
  </action>
  <verify>Compile the rust engine successfully and verify no new dependencies are broken on the worker build.</verify>
  <done>The Vault Engine successfully builds real-world AMM instructions instead of mocked vectors.</done>
</task>
</plan>
