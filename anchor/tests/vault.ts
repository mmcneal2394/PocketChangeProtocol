import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PocketchangeVault } from "../target/types/pocketchange_vault";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
  createTransferInstruction,
} from "@solana/spl-token";
import { assert } from "chai";

describe("pocketchange_vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PocketchangeVault as Program<PocketchangeVault>;

  const admin = provider.wallet;
  let usdcMint: anchor.web3.PublicKey;
  let pcpMint: anchor.web3.PublicKey;
  let vaultUsdc: anchor.web3.PublicKey;
  let treasuryUsdc: anchor.web3.PublicKey;
  let userUsdc: anchor.web3.PublicKey;
  let userPcp: anchor.web3.PublicKey;
  let adminUsdc: anchor.web3.PublicKey;
  let vaultStatePda: anchor.web3.PublicKey;
  let vaultBump: number;

  before(async () => {
    // Derive vault PDA
    [vaultStatePda, vaultBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault")],
      program.programId
    );

    // Create USDC mock mint (admin is mint authority)
    usdcMint = await createMint(
      provider.connection,
      (admin as any).payer,
      admin.publicKey,
      null,
      6 // USDC decimals
    );

    // Create PCP mint (vault PDA is mint authority for shares)
    pcpMint = await createMint(
      provider.connection,
      (admin as any).payer,
      vaultStatePda, // vault PDA is mint authority
      null,
      9 // PCP decimals
    );

    // Create token accounts
    vaultUsdc = await createAccount(provider.connection, (admin as any).payer, usdcMint, vaultStatePda);
    treasuryUsdc = await createAccount(provider.connection, (admin as any).payer, usdcMint, admin.publicKey);
    userUsdc = await createAccount(provider.connection, (admin as any).payer, usdcMint, admin.publicKey);
    userPcp = await createAccount(provider.connection, (admin as any).payer, pcpMint, admin.publicKey);
    adminUsdc = await createAccount(provider.connection, (admin as any).payer, usdcMint, admin.publicKey);

    // Mint USDC to user for testing
    await mintTo(
      provider.connection,
      (admin as any).payer,
      usdcMint,
      userUsdc,
      admin.publicKey,
      1_000_000_000 // 1000 USDC
    );
  });

  // Test 1: Initialize vault
  it("initializes the vault", async () => {
    await program.methods
      .initialize(50, 2000) // 0.5% unstaking fee, 20% treasury share
      .accounts({
        admin: admin.publicKey,
        vaultState: vaultStatePda,
        pcpMint: pcpMint,
        vaultUsdcAccount: vaultUsdc,
        treasuryUsdcAccount: treasuryUsdc,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultStatePda);
    assert.equal(vault.admin.toString(), admin.publicKey.toString());
    assert.equal(vault.unstakingFeeBasisPoints, 50);
    assert.equal(vault.profitShareTreasuryBp, 2000);
    assert.equal(vault.totalShares.toNumber(), 0);
    assert.equal(vault.totalDeposits.toNumber(), 0);
    assert.equal(vault.isBorrowing, false);
    assert.equal(vault.borrowAmount.toNumber(), 0);
  });

  // Test 2: Deposit USDC and receive PCP shares
  it("deposits USDC and mints PCP shares", async () => {
    const depositAmount = 100_000_000; // 100 USDC

    await program.methods
      .deposit(new anchor.BN(depositAmount))
      .accounts({
        user: admin.publicKey,
        vaultState: vaultStatePda,
        userUsdcAccount: userUsdc,
        vaultUsdcAccount: vaultUsdc,
        pcpMint: pcpMint,
        userPcpAccount: userPcp,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultStatePda);
    assert.equal(vault.totalDeposits.toNumber(), depositAmount);
    // First deposit: shares == amount
    assert.equal(vault.totalShares.toNumber(), depositAmount);

    const pcpAccount = await getAccount(provider.connection, userPcp);
    assert.equal(Number(pcpAccount.amount), depositAmount);
  });

  // Test 3: Zero deposit should fail
  it("rejects zero deposit", async () => {
    try {
      await program.methods
        .deposit(new anchor.BN(0))
        .accounts({
          user: admin.publicKey,
          vaultState: vaultStatePda,
          userUsdcAccount: userUsdc,
          vaultUsdcAccount: vaultUsdc,
          pcpMint: pcpMint,
          userPcpAccount: userPcp,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.include(err.toString(), "ZeroDeposit");
    }
  });

  // Test 4: Borrow for arbitrage (admin only)
  it("allows admin to borrow for arbitrage", async () => {
    const borrowAmount = 50_000_000; // 50 USDC

    await program.methods
      .borrowForArbitrage(new anchor.BN(borrowAmount))
      .accounts({
        admin: admin.publicKey,
        vaultState: vaultStatePda,
        vaultUsdcAccount: vaultUsdc,
        adminUsdcAccount: adminUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultStatePda);
    assert.equal(vault.isBorrowing, true);
    assert.equal(vault.borrowAmount.toNumber(), borrowAmount);

    const adminUsdcAcct = await getAccount(provider.connection, adminUsdc);
    assert.equal(Number(adminUsdcAcct.amount), borrowAmount);
  });

  // Test 5: Double borrow should fail (borrow already active)
  it("rejects double borrow", async () => {
    try {
      await program.methods
        .borrowForArbitrage(new anchor.BN(10_000_000))
        .accounts({
          admin: admin.publicKey,
          vaultState: vaultStatePda,
          vaultUsdcAccount: vaultUsdc,
          adminUsdcAccount: adminUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.include(err.toString(), "BorrowAlreadyActive");
    }
  });

  // Test 6: Process arbitrage profit
  it("processes arbitrage profit correctly", async () => {
    const profit = 5_000_000; // 5 USDC profit

    // Mint extra 5 USDC to admin as simulated "profit"
    await mintTo(
      provider.connection,
      (admin as any).payer,
      usdcMint,
      adminUsdc,
      admin.publicKey,
      5_000_000
    );

    // Transfer all 55 USDC from admin back to vault (50 borrowed + 5 profit)
    const repayIx = createTransferInstruction(
      adminUsdc,
      vaultUsdc,
      admin.publicKey,
      55_000_000
    );

    const tx = new anchor.web3.Transaction().add(repayIx);
    await provider.sendAndConfirm(tx);

    // Now process the arbitrage
    await program.methods
      .processArbitrage(new anchor.BN(profit))
      .accounts({
        admin: admin.publicKey,
        vaultState: vaultStatePda,
        vaultUsdcAccount: vaultUsdc,
        treasuryUsdcAccount: treasuryUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultStatePda);
    assert.equal(vault.isBorrowing, false);
    assert.equal(vault.borrowAmount.toNumber(), 0);

    // Pool share = profit * (1 - 20%) = 5M * 80% = 4M
    // Treasury share = 5M * 20% = 1M
    // total_deposits should be 100M + 4M = 104M
    assert.equal(vault.totalDeposits.toNumber(), 104_000_000);

    // Check treasury got its cut
    const treasuryAcct = await getAccount(provider.connection, treasuryUsdc);
    assert.equal(Number(treasuryAcct.amount), 1_000_000); // 1 USDC treasury share
  });

  // Test 7: Process arbitrage without active borrow should fail
  it("rejects process_arbitrage without active borrow", async () => {
    try {
      await program.methods
        .processArbitrage(new anchor.BN(1_000_000))
        .accounts({
          admin: admin.publicKey,
          vaultState: vaultStatePda,
          vaultUsdcAccount: vaultUsdc,
          treasuryUsdcAccount: treasuryUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.include(err.toString(), "InsufficientRepayment");
    }
  });

  // Test 8: Withdraw (burn PCP, receive USDC)
  it("withdraws USDC by burning PCP shares", async () => {
    const sharesToBurn = 50_000_000; // Burn 50 PCP (half of 100)

    const vaultBefore = await program.account.vaultState.fetch(vaultStatePda);
    const expectedUsdc = (sharesToBurn * vaultBefore.totalDeposits.toNumber()) / vaultBefore.totalShares.toNumber();
    const expectedFee = Math.floor(expectedUsdc * 50 / 10000); // 0.5% fee
    const expectedReturn = expectedUsdc - expectedFee;

    const userUsdcBefore = await getAccount(provider.connection, userUsdc);

    await program.methods
      .withdraw(new anchor.BN(sharesToBurn))
      .accounts({
        user: admin.publicKey,
        vaultState: vaultStatePda,
        vaultUsdcAccount: vaultUsdc,
        userUsdcAccount: userUsdc,
        pcpMint: pcpMint,
        userPcpAccount: userPcp,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultStatePda);
    assert.equal(vault.totalShares.toNumber(), 100_000_000 - sharesToBurn);

    const userUsdcAfter = await getAccount(provider.connection, userUsdc);
    const received = Number(userUsdcAfter.amount) - Number(userUsdcBefore.amount);
    assert.approximately(received, expectedReturn, 1); // Allow 1 lamport rounding
  });

  // Test 9: Zero withdraw should fail
  it("rejects zero withdrawal", async () => {
    try {
      await program.methods
        .withdraw(new anchor.BN(0))
        .accounts({
          user: admin.publicKey,
          vaultState: vaultStatePda,
          vaultUsdcAccount: vaultUsdc,
          userUsdcAccount: userUsdc,
          pcpMint: pcpMint,
          userPcpAccount: userPcp,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.include(err.toString(), "ZeroWithdraw");
    }
  });

  // Test 10: Non-admin cannot borrow
  it("rejects borrow from non-admin", async () => {
    const attacker = anchor.web3.Keypair.generate();

    // Airdrop some SOL to attacker for fees
    const sig = await provider.connection.requestAirdrop(attacker.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);

    const attackerUsdc = await createAccount(
      provider.connection,
      (admin as any).payer,
      usdcMint,
      attacker.publicKey
    );

    try {
      await program.methods
        .borrowForArbitrage(new anchor.BN(10_000_000))
        .accounts({
          admin: attacker.publicKey,
          vaultState: vaultStatePda,
          vaultUsdcAccount: vaultUsdc,
          adminUsdcAccount: attackerUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([attacker])
        .rpc();
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.include(err.toString(), "Unauthorized");
    }
  });
});
