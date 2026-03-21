import { Connection, PublicKey, TransactionInstruction, VersionedTransaction, TransactionMessage, Keypair, SystemProgram, AddressLookupTableAccount } from '@solana/web3.js';
import * as fs from 'fs';
import { getAddressLookupTable, getCachedBlockhash } from '../jupiter/cache';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

const connection = new Connection(config.RPC_ENDPOINT, { commitment: 'processed' });

export async function buildVersionedTransaction(ix1Response: any, ix2Response: any, jitoTipLamports: number = 0) {
  try {
    const rawKeypair = JSON.parse(fs.readFileSync(config.WALLET_KEYPAIR_PATH, 'utf-8'));
    const wallet = Keypair.fromSecretKey(new Uint8Array(rawKeypair));

    let blockhash = getCachedBlockhash();
    if (!blockhash) {
      blockhash = (await connection.getLatestBlockhash('processed')).blockhash;
    }

    const instructions: TransactionInstruction[] = [];

    const deserializeInstruction = (ix: any) => {
      if (!ix) return null;
      try {
          return new TransactionInstruction({
            programId: new PublicKey(ix.programId),
            keys: ix.accounts.map((key: any) => ({
              pubkey: new PublicKey(key.pubkey),
              isSigner: key.isSigner,
              isWritable: key.isWritable,
            })),
            data: Buffer.from(ix.data, "base64"),
          });
      } catch (err) {
          console.error("DEBUG PUBKEY ERROR on IX:", ix);
          throw err;
      }
    };

    // Load necessary address lookup tables
    const altsToFetch = [
      ...(ix1Response.addressLookupTableAddresses || []),
      ...(ix2Response.addressLookupTableAddresses || [])
    ];

    const altsRaw = await Promise.all(
      Array.from(new Set(altsToFetch)).map(addr => getAddressLookupTable(addr as string))
    );
    const alts: AddressLookupTableAccount[] = altsRaw.filter(alt => alt !== null) as AddressLookupTableAccount[];

    // Add Ix1 instructions
    if (ix1Response.setupInstructions) {
      ix1Response.setupInstructions.forEach((ix: any) => instructions.push(deserializeInstruction(ix)!));
    }
    instructions.push(deserializeInstruction(ix1Response.swapInstruction)!);
    if (ix1Response.cleanupInstruction) {
      instructions.push(deserializeInstruction(ix1Response.cleanupInstruction)!);
    }

    // Add Ix2 instructions
    if (ix2Response.setupInstructions) {
      ix2Response.setupInstructions.forEach((ix: any) => instructions.push(deserializeInstruction(ix)!));
    }
    instructions.push(deserializeInstruction(ix2Response.swapInstruction)!);
    if (ix2Response.cleanupInstruction) {
      instructions.push(deserializeInstruction(ix2Response.cleanupInstruction)!);
    }

    const validInstructions = instructions.filter(ix => ix !== null);

    logger.info(`--- TRANSACTION PAYLOAD STRUCTURE (${validInstructions.length} Instructions) ---`);
    validInstructions.forEach((ix, i) => {
       logger.info(`[IX ${i}] Program: ${ix.programId.toBase58()}`);
    });
    logger.info(`-----------------------------------------------------`);

    // Calculate baseline priority gas securely instead of relying on MEV auction padding
    // We are operating sub-10ms via Geyser, removing the need to fight block wars heavily.
    const dynamicMicroLamports = 250000; // Extremely high strictly prioritized fee!
    
    const { ComputeBudgetProgram } = require("@solana/web3.js");
    validInstructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: dynamicMicroLamports }));
    validInstructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }));
    
    logger.info(`🔥 Attached Strict Baseline Gas Priority: ${dynamicMicroLamports} microLamports (Bypassing Priority Auctions!)`);

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
        } catch (err: any) {
           logger.error(`Failed to fetch dynamic Tip Accounts natively: ${err.message}`);
        }
        
        const randomTipAccount = jitoTipAccounts[Math.floor(Math.random() * jitoTipAccounts.length)];
        
        const tipIx = SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: new PublicKey(randomTipAccount),
            lamports: Math.floor(jitoTipLamports),
        });
        
        // Add the Jito Tip correctly as the LAST execution step
        validInstructions.push(tipIx);
        logger.info(`💰 Appended DYNAMIC Jito Tip Execution successfully: ${jitoTipLamports / 1e9} SOL to ${randomTipAccount.substring(0, 6)}...`);
    }

    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: validInstructions as TransactionInstruction[],
    }).compileToV0Message(alts);

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet]);

    return transaction;
    } catch (error) {
    logger.error('Failed to build versioned transaction:', error);
    return null;
  }
}
