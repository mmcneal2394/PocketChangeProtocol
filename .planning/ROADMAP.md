# Roadmap: Milestone 4 (V3.0)

## Phase 1: Native Solana Program Scaffold 
**Goal**: Launch the initial framework for the `pocketchange-vault`.
- Run cargo init to create the `vault/` workspace.
- Establish `solana-program` and `spl-token` dependencies.
- Map the state variables and discriminators for the 4 core actions.

## Phase 2: Instruction Validation & Security
**Goal**: Handle SPL transfers and mint authorizations from PDAs.
- Implement the `VaultState` Account struct.
- Bind `USDC` Token transfers for Deposits & Withdraws.
- Authorize the PDA to mint and burn `PCP` tokens synchronously.

## Phase 3: BPF Target & Integrations
**Goal**: Connect the deployed testnet contract to the Engine & UI.
- Use `solana program deploy` against Devnet / Localnet.
- Hardcode the finalized Program ID back into `engine-worker/src/engine/mod.rs` & `src/app/page.tsx`.
- Bind end-to-end execution.
