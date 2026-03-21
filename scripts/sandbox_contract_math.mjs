/**
 * PocketChange Protocol (PRD v1.2) - Math & Logic Sandbox
 * 
 * This simulation replicates the exact integer math and state updates 
 * engineered in the Anchor Rust Smart Contract. It verifies that:
 * 1. $PCP Tokenomics scale proportionally (Auto-compounding)
 * 2. Protocol Fees (20%) are correctly siphoned during Arbitrage Yields
 * 3. Unstaking Fees (0.5%) are correctly calculated and deducted upon withdrawal.
 */

console.log("====================================================");
console.log("🧪 PocketChange Smart Contract Math Sandbox (Strict)");
console.log("====================================================\n");

// --- Protocol Configuration ---
const PROTOCOL_FEE_BPS = 2000n; // 20.00%
const UNSTAKE_FEE_BPS = 50n;    // 0.50%

// --- Vault State ---
let totalStakedAssets = 0n; // Micro-USDC (6 decimals)
let totalSharesMinted = 0n; // Raw $PCP   (9 decimals)

let treasuryBalance = 0n;

// Dummy user accounts for simulation
let user1 = { usdc: 10_000_000n, pcp: 0n }; // Started with 10 USDC
let user2 = { usdc: 10_000_000n, pcp: 0n }; // Started with 10 USDC

const formatAmount = (amount, decimals = 6) => `$${(Number(amount) / 10**decimals).toFixed(4)}`;
const formatPCP = (amount) => `${(Number(amount) / 10**9).toFixed(4)} $PCP`;

function printState() {
    console.log(`\n📊 [VAULT STATE]`);
    console.log(` - Total Assets Tracked: ${formatAmount(totalStakedAssets)}`);
    console.log(` - Total $PCP Minted:    ${formatPCP(totalSharesMinted)}`);
    if (totalSharesMinted > 0n) {
        const exchangeRate = Number(totalStakedAssets) / Number(totalSharesMinted) * 1000;
        console.log(` - Exchange Rate:        1 $PCP = ${exchangeRate.toFixed(4)} USDC`);
    } else {
        console.log(` - Exchange Rate:        1 $PCP = 1.0000 USDC`);
    }
    console.log(` - Treasury Balance:     ${formatAmount(treasuryBalance)}\n`);
}

// ---------------------------------------------------------
// 1. STAKING LOGIC (from lib.rs)
// ---------------------------------------------------------
function stake(userObj, userName, amountInput) {
    console.log(`📥 [ACTION] ${userName} Stakes ${formatAmount(amountInput)} USDC`);
    let sharesToMint = 0n;

    if (totalStakedAssets === 0n || totalSharesMinted === 0n) {
        // First depositor gets 1:1, but scale UP by 1000 because $PCP has 9 decimals and USDC has 6
        sharesToMint = amountInput * 1000n; 
    } else {
        // (amount * total_shares_minted) / total_staked_assets
        sharesToMint = (amountInput * totalSharesMinted) / totalStakedAssets;
    }

    userObj.usdc -= amountInput;
    userObj.pcp += sharesToMint;

    totalStakedAssets += amountInput;
    totalSharesMinted += sharesToMint;

    console.log(`    ↳ Minted: ${formatPCP(sharesToMint)} to ${userName}`);
}

// ---------------------------------------------------------
// 2. ARBITRAGE EXECUTION LOGIC (from lib.rs)
// ---------------------------------------------------------
function executeArbitrage(profitDelta) {
    console.log(`🤖 [ACTION] Arbitrage Keeper Executes Trade. Vault Nets ${formatAmount(profitDelta)} Profit.`);
    
    // Treasury takes 20%
    // (profit * protocol_fee_bps) / 10000
    let treasuryCut = (profitDelta * PROTOCOL_FEE_BPS) / 10000n;
    
    // Remaining goes to Stakers via Auto-Compounding
    let stakerCut = profitDelta - treasuryCut;

    treasuryBalance += treasuryCut;
    // We add to tracked assets without minting new shares!
    totalStakedAssets += stakerCut;

    console.log(`    ↳ Treasury Cut (${Number(PROTOCOL_FEE_BPS)/100}%): ${formatAmount(treasuryCut)}`);
    console.log(`    ↳ Staker Compound Yield:   ${formatAmount(stakerCut)} added to total assets`);
}

// ---------------------------------------------------------
// 3. UNSTAKING LOGIC WITH 0.5% FEE (from lib.rs)
// ---------------------------------------------------------
function unstake(userObj, userName, sharesToBurn) {
    console.log(`🔥 [ACTION] ${userName} Unstakes ${formatPCP(sharesToBurn)}`);

    // Calculate gross return based on newly inflated exchange rate
    // (shares * total_staked_assets) / total_shares_minted
    let underlyingToReturn = (sharesToBurn * totalStakedAssets) / totalSharesMinted;

    // Calculate 0.5% Protocol Unstaking withdrawal fee
    let feeAmount = (underlyingToReturn * UNSTAKE_FEE_BPS) / 10000n;
    let netReturn = underlyingToReturn - feeAmount;

    userObj.pcp -= sharesToBurn;
    userObj.usdc += netReturn;

    treasuryBalance += feeAmount;
    totalStakedAssets -= underlyingToReturn; // Contract pulls whole chunk out
    totalSharesMinted -= sharesToBurn;       // Contract burns shares

    console.log(`    ↳ Gross Valuation: ${formatAmount(underlyingToReturn)}`);
    console.log(`    ↳ Unstaking Fee (${Number(UNSTAKE_FEE_BPS)/100}%): ${formatAmount(feeAmount)} sent to Treasury`);
    console.log(`    ↳ Net Sent to Wallet: ${formatAmount(netReturn)} USDC`);
}

// =========================================================
// EXECUTE SIMULATION WORKFLOW
// =========================================================

// Scenario 1: Genesis Staker joins empty pool
stake(user1, "User 1", 5_000_000n); // 5 USDC
printState();

// Scenario 2: Flash Loan Arb generated 1 USDC of yield
executeArbitrage(1_000_000n); // 1 USDC profit
printState();

// Scenario 3: User 2 joins after yield was generated (gets less $PCP due to inflated rate)
stake(user2, "User 2", 5_000_000n); // 5 USDC
printState();

// Scenario 4: User 1 withdraws after profit, pays 0.5% fee
unstake(user1, "User 1", 5_000_000_000n); // Burning their 5 $PCP
printState();

// Final checks
console.log(`✅ [SUMMARY] User 1 Wallet Balance: ${formatAmount(user1.usdc)} (Started with $10.0000)`);
console.log(`✅ [SUMMARY] User 2 Wallet Balance: ${formatAmount(user2.usdc)} (Started with $10.0000)`);
console.log(`✅ [SUMMARY] Protocol Treasury:     ${formatAmount(treasuryBalance)}\n`);
