import dotenv from "dotenv";
import path from "path";
// Load env from both .env and .env.local
dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), quiet: true });

import { BagsSDK } from "@bagsfm/bags-sdk";
import { Keypair, LAMPORTS_PER_SOL, Connection, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";

// Use SOLANA_PRIVATE_KEY instead as defined in .env
const BAGS_API_KEY = process.env.BAGS_API_KEY;
const SOLANA_RPC_URL = process.env.RPC_URL || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const PRIVATE_KEYS = [
    process.env.SOLANA_PRIVATE_KEY,
    process.env.PCP_DEPLOYER_PRIVATE_KEY,
    process.env.PRIVATE_KEY
].filter(Boolean) as string[];

async function claimAllFees() {
    try {
        if (!BAGS_API_KEY) {
            console.error("❌ BAGS_API_KEY is not set in .env. Please provide the Bags API Key.");
            return;
        }

        if (PRIVATE_KEYS.length === 0) {
            console.error("❌ No PRIVATE_KEYs found in .env");
            return;
        }

        const connection = new Connection(SOLANA_RPC_URL);
        const sdk = new BagsSDK(BAGS_API_KEY, connection, "processed");

        for (const pk of PRIVATE_KEYS) {
            const keypair = Keypair.fromSecretKey(bs58.decode(pk));
            console.log(`\n💰 Checking protocol fees for wallet ${keypair.publicKey.toBase58()}`);
            const commitment = sdk.state.getCommitment();

            console.log("🔍 Fetching all claimable positions from Bags...");
            const allPositions = await sdk.fee.getAllClaimablePositions(keypair.publicKey);

            if (!allPositions || allPositions.length === 0) {
                console.log("❌ No claimable fee positions found for this wallet.");
                continue;
            }

            console.log(`📋 Found ${allPositions.length} total claimable position(s).`);

            // Display position details and claim them
            for (let i = 0; i < allPositions.length; i++) {
                const position = allPositions[i];
                console.log(`\n📊 Position ${i + 1}:`);
                console.log(`   🪙 Token: ${position.baseMint}`);
                console.log(`   🏊 Virtual Pool: ${position.virtualPoolAddress}`);

                let totalClaimableSol = 0;
                if (position.virtualPoolClaimableAmount) {
                    const virtualAmount = Number(position.virtualPoolClaimableAmount) / LAMPORTS_PER_SOL;
                    console.log(`   💰 Virtual Pool Claimable: ${virtualAmount.toFixed(6)} SOL`);
                    totalClaimableSol += virtualAmount;
                }

                if (position.dammPoolClaimableAmount) {
                    const dammAmount = Number(position.dammPoolClaimableAmount) / LAMPORTS_PER_SOL;
                    console.log(`   💰 DAMM Pool Claimable: ${dammAmount.toFixed(6)} SOL`);
                    totalClaimableSol += dammAmount;
                }

                if (position.isCustomFeeVault) {
                    const customFeeVaultBalance = Number(position.customFeeVaultBalance) / LAMPORTS_PER_SOL;
                    const bps = position.customFeeVaultBps;
                    const claimableAmount = customFeeVaultBalance * (bps / 10000);
                    console.log(`   🏦 Custom Fee Vault: Yes`);
                    console.log(`   📍 Claimer Side: ${position.customFeeVaultClaimerSide}`);
                    console.log(`   💰 Custom Fee Vault Claimable: ${claimableAmount.toFixed(6)} SOL`);
                    totalClaimableSol += claimableAmount;
                }

                if (totalClaimableSol === 0) {
                    console.log(`⚠️  No SOL available to claim for this position.`);
                    continue;
                }

                console.log(`\n🎯 Creating claim transactions for token $PCP (${position.baseMint})...`);
                try {
                    const claimTransactions = await sdk.fee.getClaimTransaction(
                        keypair.publicKey,
                        position
                    );

                    if (!claimTransactions || claimTransactions.length === 0) {
                        console.log(`⚠️  No claim transactions generated for this position.`);
                        continue;
                    }

                    console.log(`✨ Generated ${claimTransactions.length} claim transaction(s)`);
                    console.log(`🔑 Signing and sending transactions sequentially...`);

                    for (let j = 0; j < claimTransactions.length; j++) {
                        const transaction = claimTransactions[j];
                        
                        // Ensure blockhash and feePayer is set
                        const { blockhash } = await connection.getLatestBlockhash();
                        transaction.recentBlockhash = blockhash;
                        transaction.feePayer = keypair.publicKey;

                        const signature = await sendAndConfirmTransaction(connection, transaction, [keypair]);
                        console.log(`✅ Transaction ${j + 1} confirmed successfully: ${signature}`);
                    }
                } catch (claimErr) {
                    console.error(`🚨 Failed to claim position ${i + 1}:`, claimErr);
                }
            }
        }

        console.log("\n🎉 Fee claiming process completed!");
    }
    catch (error) {
        console.error("🚨 Unexpected error occurred:", error);
    }
}

claimAllFees();
