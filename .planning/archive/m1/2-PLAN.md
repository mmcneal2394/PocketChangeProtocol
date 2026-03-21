<plan>
<task type="auto">
  <name>Unit Test Anchor Vault Contract Without IDL</name>
  <files>scripts/vault_local_test.mjs</files>
  <action>
    - Create a local Solana web3.js script to simulate the deposit instruction natively using Borsh serialization since the Anchor IDL isn't natively built on Windows.
    - Deploy the compiled `.so` binary to `solana-test-validator` via CLI inside the script.
    - Test minting $PCP effectively simulating Vault deposits.
  </action>
  <verify>The script correctly submits a raw Web3 transaction connecting the vault, admin, mint, and token accounts against the deployed `pocketchange_vault.so`.</verify>
  <done>Vault successfully tested against a local validator</done>
</task>
</plan>
