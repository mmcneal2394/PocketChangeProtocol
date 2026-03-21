# Requirements: PocketChange Protocol Milestone 4

## V3.0 Requirements (Smart Contract Vault)

### P1: Solana Program Architecture
- Scaffold the `vault-program` utilizing pure `solana-program` Rust architecture (to bypass heavy Anchor CLI dependencies on Windows).
- Support standard Solana Token Program (SPL) interactions for USDC and $PCP.
- Entrypoint mapping to `process_instruction` handling [Deposit, Withdraw, Borrow (Execute), Compound (Return)].

### P2: State Management & PDAs
- Establish a global `VaultState` Account.
- Derive a Program Derived Address (PDA) holding authority over the `vault_usdc` ATA.
- Derive a PDA serving as the Mint Authority over `$PCP_MINT`.

### P3: Security & Validations
- Secure the `Borrow` instruction to only be executed by the authorized local Rust Engine (`Worker`).
- Ensure `Deposit` accurately mints an equivalent mathematical share of $PCP to the user.
- Add `Withdraw` functionality that calculates the return of base token minus the `.5%` slippage fee.

### Non-Functional
- Write an integration test wrapper in JS (`scripts/` folder) to interact with the built BPF `.so` file.
