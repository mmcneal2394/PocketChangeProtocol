"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildVersionedTransaction = buildVersionedTransaction;
const web3_js_1 = require("@solana/web3.js");
const fs = __importStar(require("fs"));
const cache_1 = require("../jupiter/cache");
const config_1 = require("../utils/config");
const logger_1 = require("../utils/logger");
const connection = new web3_js_1.Connection(config_1.config.RPC_ENDPOINT, { commitment: 'processed' });
async function buildVersionedTransaction(ix1Response, ix2Response, jitoTipLamports = 0) {
    try {
        const rawKeypair = JSON.parse(fs.readFileSync(config_1.config.WALLET_KEYPAIR_PATH, 'utf-8'));
        const wallet = web3_js_1.Keypair.fromSecretKey(new Uint8Array(rawKeypair));
        const blockhash = (0, cache_1.getCachedBlockhash)();
        if (!blockhash) {
            throw new Error('No cached blockhash available');
        }
        const instructions = [];
        const deserializeInstruction = (ix) => {
            if (!ix)
                return null;
            try {
                return new web3_js_1.TransactionInstruction({
                    programId: new web3_js_1.PublicKey(ix.programId),
                    keys: ix.accounts.map((key) => ({
                        pubkey: new web3_js_1.PublicKey(key.pubkey),
                        isSigner: key.isSigner,
                        isWritable: key.isWritable,
                    })),
                    data: Buffer.from(ix.data, "base64"),
                });
            }
            catch (err) {
                console.error("DEBUG PUBKEY ERROR on IX:", ix);
                throw err;
            }
        };
        // Load necessary address lookup tables
        const altsToFetch = [
            ...(ix1Response.addressLookupTableAddresses || []),
            ...(ix2Response.addressLookupTableAddresses || [])
        ];
        const altsRaw = await Promise.all(Array.from(new Set(altsToFetch)).map(addr => (0, cache_1.getAddressLookupTable)(addr)));
        const alts = altsRaw.filter(alt => alt !== null);
        // Add Ix1 instructions
        if (ix1Response.setupInstructions) {
            ix1Response.setupInstructions.forEach((ix) => instructions.push(deserializeInstruction(ix)));
        }
        instructions.push(deserializeInstruction(ix1Response.swapInstruction));
        if (ix1Response.cleanupInstruction) {
            instructions.push(deserializeInstruction(ix1Response.cleanupInstruction));
        }
        // Add Ix2 instructions
        if (ix2Response.setupInstructions) {
            ix2Response.setupInstructions.forEach((ix) => instructions.push(deserializeInstruction(ix)));
        }
        instructions.push(deserializeInstruction(ix2Response.swapInstruction));
        if (ix2Response.cleanupInstruction) {
            instructions.push(deserializeInstruction(ix2Response.cleanupInstruction));
        }
        logger_1.logger.info(`--- TRANSACTION PAYLOAD STRUCTURE (${instructions.length} Instructions) ---`);
        instructions.forEach((ix, i) => {
            logger_1.logger.info(`[IX ${i}] Program: ${ix.programId.toBase58()}`);
        });
        logger_1.logger.info(`-----------------------------------------------------`);
        // Calculate baseline priority gas securely instead of relying on MEV auction padding
        // We are operating sub-10ms via Geyser, removing the need to fight block wars heavily.
        const dynamicMicroLamports = 250000; // Extremely high strictly prioritized fee!
        const { ComputeBudgetProgram } = require("@solana/web3.js");
        instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: dynamicMicroLamports }));
        instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }));
        logger_1.logger.info(`🔥 Attached Strict Baseline Gas Priority: ${dynamicMicroLamports} microLamports (Bypassing Priority Auctions!)`);
        if (jitoTipLamports > 0) {
            let jitoTipAccounts = [
                "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
                "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
                "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
                "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
                "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
                "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
                "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
                "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL"
            ];
            try {
                const fetch = require('node-fetch');
                const res = await fetch("https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] })
                });
                const data = await res.json();
                if (data && data.result && data.result.length > 0) {
                    jitoTipAccounts = data.result;
                }
            }
            catch (err) {
                logger_1.logger.error(`Failed to fetch dynamic Tip Accounts natively: ${err.message}`);
            }
            const randomTipAccount = jitoTipAccounts[Math.floor(Math.random() * jitoTipAccounts.length)];
            const tipIx = web3_js_1.SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: new web3_js_1.PublicKey(randomTipAccount),
                lamports: Math.floor(jitoTipLamports),
            });
            // Add the Jito Tip correctly as the LAST execution step
            instructions.push(tipIx);
            logger_1.logger.info(`💰 Appended DYNAMIC Jito Tip Execution successfully: ${jitoTipLamports / 1e9} SOL to ${randomTipAccount.substring(0, 6)}...`);
        }
        const messageV0 = new web3_js_1.TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash,
            instructions,
        }).compileToV0Message(alts);
        const transaction = new web3_js_1.VersionedTransaction(messageV0);
        transaction.sign([wallet]);
        return transaction;
    }
    catch (error) {
        logger_1.logger.error('Failed to build versioned transaction:', error);
        return null;
    }
}
