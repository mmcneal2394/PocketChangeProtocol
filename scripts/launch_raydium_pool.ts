import {
  Raydium,
  TxVersion,
  parseTokenAccountResp,
} from '@raydium-io/raydium-sdk-v2';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import * as dotenv from 'dotenv';
import BN from 'bn.js';

dotenv.config();

// =========================================================================
// PocketChange ($PCP) Raydium CPMM Liquidity Pool Implementation
// =========================================================================

// Ensure your `.env` contains:
// PRIVATE_KEY="your_base58_private_key"
// SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  throw new Error("Missing PRIVATE_KEY in .env");
}

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

// ================= CONFIGURATION =================
// The Mint Address for $PCP
const PCP_MINT = new PublicKey("4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS"); // Replace if different
const PCP_DECIMALS = 6;

// The Base Pair (Typically wrapped SOL)
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const WSOL_DECIMALS = 9;

// Liquidity Amounts
// Ensure the wallet actually holds these exact amounts or the TX will simulate and fail
const PCP_LIQUIDITY_AMOUNT = 10_000_000; // E.g., 10 Million PCP
const SOL_LIQUIDITY_AMOUNT = 50; // E.g., 50 SOL

async function main() {
  console.log("🚀 Initializing Raydium Framework...");

  // Initialize Raydium SDK
  const raydium = await Raydium.load({
    owner: wallet,
    connection,
    cluster: 'mainnet', 
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: 'finalized',
  });

  console.log(`🔑 Wallet: ${wallet.publicKey.toBase58()}`);

  // Fetch create pool routing parameters from Raydium API
  console.log("📡 Fetching CPMM Pool Configs...");
  const cpmmConfigs = await raydium.api.getCpmmConfigs();
  if (cpmmConfigs.length === 0) {
      throw new Error("Failed to fetch Raydium CPMM fee configurations.");
  }

  // Choose the standard 0.25% fee tier (index 0 usually, verify in prod)
  const feeConfig = cpmmConfigs.find((config) => config.tradeFeeRate === 2500) || cpmmConfigs[0];
  console.log(`🏦 Selected Fee Tier: ${feeConfig.tradeFeeRate / 10000}%`);

  // Transform numbers to BigNumber incorporating Decimals
  const baseAmountBN = new BN(PCP_LIQUIDITY_AMOUNT).mul(new BN(10).pow(new BN(PCP_DECIMALS)));
  const quoteAmountBN = new BN(SOL_LIQUIDITY_AMOUNT).mul(new BN(10).pow(new BN(WSOL_DECIMALS)));

  console.log(`💧 Depositing:`);
  console.log(`   - ${PCP_LIQUIDITY_AMOUNT} $PCP`);
  console.log(`   - ${SOL_LIQUIDITY_AMOUNT} WSOL`);

  console.log("⚙️ Building CPMM Create Transaction...");
  const { execute, extInfo } = await raydium.cpmm.createPool({
    programId: require('@raydium-io/raydium-sdk-v2').CREATE_CPMM_POOL_PROGRAM, // Target Raydium CPMM Program
    poolFeeAccount: new PublicKey(feeConfig.id),
    mintA: {
      address: PCP_MINT.toBase58(),
      decimals: PCP_DECIMALS,
      programId: TOKEN_PROGRAM_ID.toBase58(),
    },
    mintB: {
      address: WSOL_MINT.toBase58(),
      decimals: WSOL_DECIMALS,
      programId: TOKEN_PROGRAM_ID.toBase58(),
    },
    mintAAmount: baseAmountBN,
    mintBAmount: quoteAmountBN,
    startTime: new BN(0), // 0 = Immediately tradeable
    feeConfig: feeConfig,
    associatedOnly: false,
    ownerInfo: {
      useSOLBalance: true, // Automatically unwraps WSOL if needed
    },
    txVersion: TxVersion.V0,
  });

  console.log(`🔗 Pool Address will be: ${extInfo.address.poolId.toBase58()}`);
  console.log(`📤 Sending Transaction...`);

  try {
    const { txId } = await execute({ sendAndConfirm: true });
    console.log(`✅ Liquidity Pool Created Successfully!`);
    console.log(`📜 Transaction Signature: https://solscan.io/tx/${txId}`);
    
    // Auto-update the Engine Worker logic locally
    console.log("\n🚀 The $PCP market is officially live. Please ensure you update `config.yaml` to point the Arbitrage Engine to the new Raydium AMM.");
  } catch (error) {
    console.error("❌ Transaction Failed:");
    console.error(error);
  }
}

main().catch(console.error);
