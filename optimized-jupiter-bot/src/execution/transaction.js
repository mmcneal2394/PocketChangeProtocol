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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildVersionedTransaction = buildVersionedTransaction;
var web3_js_1 = require("@solana/web3.js");
var fs = __importStar(require("fs"));
var cache_1 = require("../jupiter/cache");
var config_1 = require("../utils/config");
var logger_1 = require("../utils/logger");
var connection = new web3_js_1.Connection(config_1.config.RPC_ENDPOINT, { commitment: 'processed' });
function buildVersionedTransaction(ix1Response_1, ix2Response_1) {
    return __awaiter(this, arguments, void 0, function (ix1Response, ix2Response, jitoTipLamports) {
        var rawKeypair, wallet, blockhash, instructions_1, deserializeInstruction_1, altsToFetch, altsRaw, alts, validInstructions, dynamicMicroLamports, ComputeBudgetProgram, jitoTipAccounts, fetch_1, res, data, err_1, randomTipAccount, tipIx, messageV0, transaction, error_1;
        if (jitoTipLamports === void 0) { jitoTipLamports = 0; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 10, , 11]);
                    rawKeypair = JSON.parse(fs.readFileSync(config_1.config.WALLET_KEYPAIR_PATH, 'utf-8'));
                    wallet = web3_js_1.Keypair.fromSecretKey(new Uint8Array(rawKeypair));
                    blockhash = (0, cache_1.getCachedBlockhash)();
                    if (!!blockhash) return [3 /*break*/, 2];
                    return [4 /*yield*/, connection.getLatestBlockhash('processed')];
                case 1:
                    blockhash = (_a.sent()).blockhash;
                    _a.label = 2;
                case 2:
                    instructions_1 = [];
                    deserializeInstruction_1 = function (ix) {
                        if (!ix)
                            return null;
                        try {
                            return new web3_js_1.TransactionInstruction({
                                programId: new web3_js_1.PublicKey(ix.programId),
                                keys: ix.accounts.map(function (key) { return ({
                                    pubkey: new web3_js_1.PublicKey(key.pubkey),
                                    isSigner: key.isSigner,
                                    isWritable: key.isWritable,
                                }); }),
                                data: Buffer.from(ix.data, "base64"),
                            });
                        }
                        catch (err) {
                            console.error("DEBUG PUBKEY ERROR on IX:", ix);
                            throw err;
                        }
                    };
                    altsToFetch = __spreadArray(__spreadArray([], (ix1Response.addressLookupTableAddresses || []), true), (ix2Response.addressLookupTableAddresses || []), true);
                    return [4 /*yield*/, Promise.all(Array.from(new Set(altsToFetch)).map(function (addr) { return (0, cache_1.getAddressLookupTable)(addr); }))];
                case 3:
                    altsRaw = _a.sent();
                    alts = altsRaw.filter(function (alt) { return alt !== null; });
                    // Add Ix1 instructions
                    if (ix1Response.setupInstructions) {
                        ix1Response.setupInstructions.forEach(function (ix) { return instructions_1.push(deserializeInstruction_1(ix)); });
                    }
                    instructions_1.push(deserializeInstruction_1(ix1Response.swapInstruction));
                    if (ix1Response.cleanupInstruction) {
                        instructions_1.push(deserializeInstruction_1(ix1Response.cleanupInstruction));
                    }
                    // Add Ix2 instructions
                    if (ix2Response.setupInstructions) {
                        ix2Response.setupInstructions.forEach(function (ix) { return instructions_1.push(deserializeInstruction_1(ix)); });
                    }
                    instructions_1.push(deserializeInstruction_1(ix2Response.swapInstruction));
                    if (ix2Response.cleanupInstruction) {
                        instructions_1.push(deserializeInstruction_1(ix2Response.cleanupInstruction));
                    }
                    validInstructions = instructions_1.filter(function (ix) { return ix !== null; });
                    logger_1.logger.info("--- TRANSACTION PAYLOAD STRUCTURE (".concat(validInstructions.length, " Instructions) ---"));
                    validInstructions.forEach(function (ix, i) {
                        logger_1.logger.info("[IX ".concat(i, "] Program: ").concat(ix.programId.toBase58()));
                    });
                    logger_1.logger.info("-----------------------------------------------------");
                    dynamicMicroLamports = 250000;
                    ComputeBudgetProgram = require("@solana/web3.js").ComputeBudgetProgram;
                    validInstructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: dynamicMicroLamports }));
                    validInstructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }));
                    logger_1.logger.info("\uD83D\uDD25 Attached Strict Baseline Gas Priority: ".concat(dynamicMicroLamports, " microLamports (Bypassing Priority Auctions!)"));
                    if (!(jitoTipLamports > 0)) return [3 /*break*/, 9];
                    jitoTipAccounts = [
                        "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
                        "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
                        "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
                        "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
                        "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
                        "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
                        "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
                        "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL"
                    ];
                    _a.label = 4;
                case 4:
                    _a.trys.push([4, 7, , 8]);
                    fetch_1 = require('node-fetch');
                    return [4 /*yield*/, fetch_1("https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles", {
                            method: "POST", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] })
                        })];
                case 5:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 6:
                    data = _a.sent();
                    if (data && data.result && data.result.length > 0) {
                        jitoTipAccounts = data.result;
                    }
                    return [3 /*break*/, 8];
                case 7:
                    err_1 = _a.sent();
                    logger_1.logger.error("Failed to fetch dynamic Tip Accounts natively: ".concat(err_1.message));
                    return [3 /*break*/, 8];
                case 8:
                    randomTipAccount = jitoTipAccounts[Math.floor(Math.random() * jitoTipAccounts.length)];
                    tipIx = web3_js_1.SystemProgram.transfer({
                        fromPubkey: wallet.publicKey,
                        toPubkey: new web3_js_1.PublicKey(randomTipAccount),
                        lamports: Math.floor(jitoTipLamports),
                    });
                    // Add the Jito Tip correctly as the LAST execution step
                    validInstructions.push(tipIx);
                    logger_1.logger.info("\uD83D\uDCB0 Appended DYNAMIC Jito Tip Execution successfully: ".concat(jitoTipLamports / 1e9, " SOL to ").concat(randomTipAccount.substring(0, 6), "..."));
                    _a.label = 9;
                case 9:
                    messageV0 = new web3_js_1.TransactionMessage({
                        payerKey: wallet.publicKey,
                        recentBlockhash: blockhash,
                        instructions: validInstructions,
                    }).compileToV0Message(alts);
                    transaction = new web3_js_1.VersionedTransaction(messageV0);
                    transaction.sign([wallet]);
                    return [2 /*return*/, transaction];
                case 10:
                    error_1 = _a.sent();
                    logger_1.logger.error('Failed to build versioned transaction:', error_1);
                    return [2 /*return*/, null];
                case 11: return [2 /*return*/];
            }
        });
    });
}
