<plan>
<task type="auto">
  <name>Deploy Smart Contract to Devnet</name>
  <files>src/app/page.tsx</files>
  <action>
    - Ensure Solana CLI is pointed towards `devnet`.
    - Fund the current local machine deployer with `solana airdrop 2`.
    - Execute `cargo build-sbf` on `programs/pocketchange_vault`.
    - Run `solana program deploy target/deploy/pocketchange_vault.so`.
    - Extract the deployed devnet Program ID.
    - Update `src/app/page.tsx`'s connection logic via React hooks `const connection = new Connection(clusterApiUrl('devnet'), 'confirmed')`.
    - Update the UI's `PROGRAM_ID`, `USDC_MINT`, and `PCP_MINT` constants to new Devnet equivalents.
  </action>
  <verify>A successful deposit transaction is broadcast over the Solana devnet instead of localhost.</verify>
  <done>The dApp operates fundamentally in a staging environment.</done>
</task>
</plan>
