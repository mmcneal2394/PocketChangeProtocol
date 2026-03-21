# PocketChange ($PCP) Protocol - Milestone 4

## Vision
To build the first community-owned arbitrage protocol on Solana. By pooling user funds and leveraging advanced execution strategies, $PCP democratizes access to high-frequency arbitrage profits.

## Milestone 4: Anchor Smart Contract Vault
- Transition from mocking and telemetry to real Solana on-chain logic.
- Develop an Anchor smart contract `pocketchange_vault` managing the pooled funds and `$PCP` token minting mathematics.
- Implement the PDA architecture allowing isolated user vaults against the global compounding pool.
- Enable the backend Rust worker to borrow and return flash loans from this Anchor state.
