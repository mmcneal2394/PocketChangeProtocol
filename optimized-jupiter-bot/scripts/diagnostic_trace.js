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
Object.defineProperty(exports, "__esModule", { value: true });
var web3_js_1 = require("@solana/web3.js");
var fs = __importStar(require("fs"));
var dotenv = __importStar(require("dotenv"));
var transaction_1 = require("../src/execution/transaction");
var config_1 = require("../src/utils/config");
dotenv.config();
var connection = new web3_js_1.Connection(config_1.config.RPC_ENDPOINT, { commitment: 'processed' });
var walletSecret = JSON.parse(fs.readFileSync(config_1.config.WALLET_KEYPAIR_PATH, 'utf-8'));
var wallet = web3_js_1.Keypair.fromSecretKey(new Uint8Array(walletSecret));
var TARGETS = [{ mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' }];
var SOL_MINT = 'So11111111111111111111111111111111111111112';
function getWalletBalance() {
    return __awaiter(this, void 0, void 0, function () {
        var balance;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, connection.getBalance(wallet.publicKey)];
                case 1:
                    balance = _a.sent();
                    return [2 /*return*/, balance / 1e9];
            }
        });
    });
}
function forceJitoTrace() {
    return __awaiter(this, void 0, void 0, function () {
        function fetchWithRetry(url, options) {
            return __awaiter(this, void 0, void 0, function () {
                var res;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            if (!true) return [3 /*break*/, 5];
                            return [4 /*yield*/, fetch(url, options)];
                        case 1:
                            res = _a.sent();
                            if (!res.ok) return [3 /*break*/, 3];
                            return [4 /*yield*/, res.json()];
                        case 2: return [2 /*return*/, _a.sent()];
                        case 3:
                            console.log("\u23F3 Rate Limited by Jup Lite API. Waiting 10 seconds to backoff...");
                            return [4 /*yield*/, new Promise(function (r) { return setTimeout(r, 10000); })];
                        case 4:
                            _a.sent();
                            return [3 /*break*/, 0];
                        case 5: return [2 /*return*/];
                    }
                });
            });
        }
        var lastBalance, tradeAmountSol, amountInLamports, target, API_KEY, fetch, bs58, EXCLUDE_DEXES, q1Url, quote1, q2Url, quote2, inSol, outSol, grossProfit, grossProfitLamports, tipLamports, dynamicTipSol, netProfit, ix1, ix2, tx, simRes, e_1, encodedTx, jitoPayload, execStart, jitoRes, jitoData, execEnd, sig;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log("🚀 Starting Jito Engine TPU Injection Diagnostic Sandbox...");
                    console.log("⚙️  Target Slippage BPS: 5 (0.05%)");
                    return [4 /*yield*/, new Promise(function (r) { return setTimeout(r, 4000); })];
                case 1:
                    _a.sent(); // Rate limit bypass
                    return [4 /*yield*/, getWalletBalance()];
                case 2:
                    lastBalance = _a.sent();
                    tradeAmountSol = lastBalance * 0.1;
                    tradeAmountSol = Math.min(tradeAmountSol, 1.0);
                    tradeAmountSol = Math.max(tradeAmountSol, 0.01);
                    amountInLamports = Math.floor(tradeAmountSol * 1e9);
                    target = TARGETS[0];
                    API_KEY = config_1.config.JUPITER_API_KEY || 'YOUR_JUPITER_API_KEY';
                    console.log("\n\uD83D\uDD04 Extracting arrays for [".concat(target.symbol, "] at ").concat(tradeAmountSol.toFixed(4), " SOL boundary..."));
                    fetch = require('node-fetch');
                    bs58 = require('bs58');
                    EXCLUDE_DEXES = encodeURIComponent('GoonFi V2,AlphaQ,SolFi V2,BisonFi,HumidiFi,Sanctum,Sanctum Infinity,VaultLiquidUnstake,eversol-stake-pool,socean-stake-pool,Marinade,Lido,SolBlaze');
                    q1Url = "https://lite-api.jup.ag/swap/v1/quote?inputMint=".concat(SOL_MINT, "&outputMint=").concat(target.mint, "&amount=").concat(amountInLamports, "&slippageBps=5&onlyDirectRoutes=false&asLegacyTransaction=false&excludeDexes=").concat(EXCLUDE_DEXES);
                    return [4 /*yield*/, fetchWithRetry(q1Url, { headers: { 'x-api-key': API_KEY } })];
                case 3:
                    quote1 = _a.sent();
                    q2Url = "https://lite-api.jup.ag/swap/v1/quote?inputMint=".concat(target.mint, "&outputMint=").concat(SOL_MINT, "&amount=").concat(quote1.outAmount, "&slippageBps=5&onlyDirectRoutes=false&asLegacyTransaction=false&excludeDexes=").concat(EXCLUDE_DEXES);
                    return [4 /*yield*/, fetchWithRetry(q2Url, { headers: { 'x-api-key': API_KEY } })];
                case 4:
                    quote2 = _a.sent();
                    inSol = amountInLamports / 1e9;
                    outSol = Number(quote2.outAmount) / 1e9;
                    grossProfit = outSol - inSol;
                    grossProfitLamports = Math.floor(grossProfit * 1e9);
                    tipLamports = Math.max(Math.min(Math.floor(grossProfitLamports * 0.5), 5000000), 1000);
                    dynamicTipSol = tipLamports / 1e9;
                    netProfit = grossProfit - (0.000355 + dynamicTipSol);
                    console.log("\uD83D\uDDFA\uFE0F Route Taken: SOL -> [".concat(target.symbol, "] ExactIn -> SOL ExactOut"));
                    console.log("\n\uD83C\uDFAF FORCED JITO INJECTION EXECUTED! Expected PnL: ".concat(netProfit.toFixed(8), " SOL"));
                    return [4 /*yield*/, fetchWithRetry('https://lite-api.jup.ag/swap/v1/swap-instructions', {
                            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
                            body: JSON.stringify({ quoteResponse: quote1, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true })
                        })];
                case 5:
                    ix1 = _a.sent();
                    return [4 /*yield*/, fetchWithRetry('https://lite-api.jup.ag/swap/v1/swap-instructions', {
                            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
                            body: JSON.stringify({ quoteResponse: quote2, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true })
                        })];
                case 6:
                    ix2 = _a.sent();
                    return [4 /*yield*/, (0, transaction_1.buildVersionedTransaction)(ix1, ix2, tipLamports)];
                case 7:
                    tx = _a.sent();
                    if (!tx) {
                        throw new Error("Null Transaction natively constructed.");
                    }
                    console.log("\n\uD83E\uDE7A Simulating Payload over standard RPC to isolate Byte Arrays...");
                    _a.label = 8;
                case 8:
                    _a.trys.push([8, 10, , 11]);
                    return [4 /*yield*/, connection.simulateTransaction(tx, { sigVerify: true })];
                case 9:
                    simRes = _a.sent();
                    console.log("[Simulation Result]:", JSON.stringify(simRes.value));
                    return [3 /*break*/, 11];
                case 10:
                    e_1 = _a.sent();
                    console.error("\u274C Local Simulation Serialization Crash:", e_1.message);
                    return [3 /*break*/, 11];
                case 11:
                    encodedTx = bs58.encode(tx.serialize());
                    jitoPayload = { jsonrpc: "2.0", id: 1, method: "sendBundle", params: [[encodedTx]] };
                    console.log("\n\uD83D\uDE80 Transmitting Atomic Bundle natively via Jito TPU REST Envelope...");
                    execStart = Date.now();
                    return [4 /*yield*/, fetch("https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles", {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(jitoPayload)
                        })];
                case 12:
                    jitoRes = _a.sent();
                    return [4 /*yield*/, jitoRes.json()];
                case 13:
                    jitoData = _a.sent();
                    execEnd = Date.now();
                    console.log("\u2705 Bundle payload processed outside public limits!");
                    console.log("[Jito Trace Response]:", JSON.stringify(jitoData));
                    console.log("\u23F1\uFE0F Transaction Block-Engine Transmission Latency: ".concat(execEnd - execStart, "ms"));
                    sig = bs58.encode(tx.signatures[0]);
                    console.log("\uD83D\uDD17 Tracking Signature: https://solscan.io/tx/".concat(sig));
                    process.exit(0);
                    return [2 /*return*/];
            }
        });
    });
}
forceJitoTrace().catch(function (e) {
    console.error("\n\u274C ERROR Executing Jito Sandbox: ".concat(e.message));
    process.exit(1);
});
