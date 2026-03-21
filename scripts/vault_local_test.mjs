import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, TransactionInstruction } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, setAuthority, AuthorityType, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createHash } from 'crypto';
import fs from 'fs';

const connection = new Connection("http://127.0.0.1:8899", "confirmed");

// Get or generate payer
const authFile = fs.readFileSync('C:/Users/admin/.config/solana/id.json', 'utf8');
const keypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(authFile)));

const PROGRAM_ID = new PublicKey("FSRUKKMxfWNDiVKKVyxiaaweZR8HZEMnsyHmb8caPjAy");

function getDiscriminator(name) {
    return createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

async function runTest() {
    console.log("Payer address:", keypair.publicKey.toBase58());
    
    // Request airdrop
    try {
        const airdropSig = await connection.requestAirdrop(keypair.publicKey, 10 * 1e9);
        await connection.confirmTransaction(airdropSig);
        console.log("Airdropped 10 SOL");
    } catch(e) {
        console.log("Airdrop failed, maybe already funded.");
    }

    const usdcMint = await createMint(connection, keypair, keypair.publicKey, null, 6);
    console.log("Created Mock USDC Mint:", usdcMint.toBase58());

    const pcpMint = await createMint(connection, keypair, keypair.publicKey, null, 9);
    console.log("Created PCP Mint:", pcpMint.toBase58());

    // Vault PDAs
    const [vaultState, vaultBump] = PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID);
    console.log("Vault PDA:", vaultState.toBase58());

    // Transfer pcpMint authority to the vault PDA
    await setAuthority(
        connection,
        keypair,
        pcpMint,
        keypair.publicKey,
        AuthorityType.MintTokens,
        vaultState
    );
    console.log("Transferred $PCP mint authority to Vault");

    // Associated Token Accounts for Vault
    const vaultUsdcAccount = await getOrCreateAssociatedTokenAccount(connection, keypair, usdcMint, vaultState, true);
    console.log("Vault USDC Account:", vaultUsdcAccount.address.toBase58());

    const treasuryUsdcAccount = await getOrCreateAssociatedTokenAccount(connection, keypair, usdcMint, keypair.publicKey); // fake treasury

    // Initialize Vault Instruction
    const initData = Buffer.alloc(8 + 2 + 2);
    getDiscriminator("initialize").copy(initData, 0);
    initData.writeUInt16LE(50, 8); // 0.5% unstaking
    initData.writeUInt16LE(2000, 10); // 20% treasury share

    const initIx = new TransactionInstruction({
        programId: PROGRAM_ID,
        data: initData,
        keys: [
            { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
            { pubkey: vaultState, isSigner: false, isWritable: true },
            { pubkey: pcpMint, isSigner: false, isWritable: false },
            { pubkey: vaultUsdcAccount.address, isSigner: false, isWritable: false },
            { pubkey: treasuryUsdcAccount.address, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
        ]
    });

    const tx = new Transaction().add(initIx);
    
    console.log("Sending Initialize...");
    try {
        const initSig = await sendAndConfirmTransaction(connection, tx, [keypair]);
        console.log("Vault successfully Initialized! Signature:", initSig);
    } catch (e) {
        console.error("Initialization failed:", e);
        if (e.logs) console.error("Logs:", e.logs);
        process.exit(1);
    }
    
    console.log("Deploy test logic succeeded!");
    process.exit(0);
}

runTest();
