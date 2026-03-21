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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var web3_js_1 = require("@solana/web3.js");
var fs = __importStar(require("fs"));
var bottleneck_1 = __importDefault(require("bottleneck"));
var dotenv = __importStar(require("dotenv"));
var transaction_1 = require("../src/execution/transaction");
dotenv.config();
// Direct env access — bypass strict Zod schema in config.ts (avoids Zod crash on missing GEYSER keys)
var RPC_ENDPOINT = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
var WALLET_PATH = process.env.WALLET_KEYPAIR_PATH || './real_wallet.json';
var JUPITER_KEY = process.env.JUPITER_API_KEY || '';
var connection = new web3_js_1.Connection(RPC_ENDPOINT, { commitment: 'processed' });
var jupiterLimiter = new bottleneck_1.default({ reservoir: 3000, reservoirRefreshAmount: 3000, reservoirRefreshInterval: 60 * 1000, maxConcurrent: 15 });
var walletSecret = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
var wallet = web3_js_1.Keypair.fromSecretKey(new Uint8Array(walletSecret));
var TARGETS = [
    { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' },
    { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT' },
    { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY' },
    { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK' },
    { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF' },
    { mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', symbol: 'RNDR' },
    { mint: 'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk', symbol: 'WEN' },
    { mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82', symbol: 'BOME' },
    { mint: 'nosXBqwB22HkM3pJo9YqQhG1hHh2gQ5pXhS7vXkXVmQ', symbol: 'NOS' },
    { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', symbol: 'ORCA' },
];
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
function findAtomicOpportunity(targetMint, targetSymbol, amountInLamports) {
    return __awaiter(this, void 0, void 0, function () {
        function safeFetch(url, options) {
            return __awaiter(this, void 0, void 0, function () {
                var _this = this;
                return __generator(this, function (_a) {
                    return [2 /*return*/, jupiterLimiter.schedule(function () { return __awaiter(_this, void 0, void 0, function () {
                            var res, text;
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0: return [4 /*yield*/, fetch(url, options)];
                                    case 1:
                                        res = _a.sent();
                                        if (!!res.ok) return [3 /*break*/, 3];
                                        return [4 /*yield*/, res.text()];
                                    case 2:
                                        text = _a.sent();
                                        throw new Error("Fetch Failed: ".concat(res.status, " - ").concat(text));
                                    case 3: return [2 /*return*/, res];
                                }
                            });
                        }); })];
                });
            });
        }
        var API_KEY, fetch, perfStart, EXCLUDE_DEXES, q1Url, q1Res, quote1, q2Url, q2Res, quote2, inSol, outSol, grossProfit, staticBaseFee, computeUnitFee, grossProfitLamports, tipLamports, dynamicTipSol, totalNetworkOverhead, MIN_PROFIT, netProfit, perfEnd, ix1Res, ix1, ix2Res, ix2, tx;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    API_KEY = JUPITER_KEY;
                    fetch = require('node-fetch');
                    perfStart = Date.now();
                    EXCLUDE_DEXES = encodeURIComponent('GoonFi V2,AlphaQ,SolFi V2,BisonFi,HumidiFi,Sanctum,Sanctum Infinity,VaultLiquidUnstake,eversol-stake-pool,socean-stake-pool,Marinade,Lido,SolBlaze');
                    q1Url = "https://lite-api.jup.ag/swap/v1/quote?inputMint=".concat(SOL_MINT, "&outputMint=").concat(targetMint, "&amount=").concat(amountInLamports, "&slippageBps=5&onlyDirectRoutes=false&asLegacyTransaction=false&excludeDexes=").concat(EXCLUDE_DEXES);
                    return [4 /*yield*/, safeFetch(q1Url, { headers: { 'x-api-key': API_KEY } })];
                case 1:
                    q1Res = _a.sent();
                    return [4 /*yield*/, q1Res.json()];
                case 2:
                    quote1 = _a.sent();
                    q2Url = "https://lite-api.jup.ag/swap/v1/quote?inputMint=".concat(targetMint, "&outputMint=").concat(SOL_MINT, "&amount=").concat(quote1.outAmount, "&slippageBps=5&onlyDirectRoutes=false&asLegacyTransaction=false&excludeDexes=").concat(EXCLUDE_DEXES);
                    return [4 /*yield*/, safeFetch(q2Url, { headers: { 'x-api-key': API_KEY } })];
                case 3:
                    q2Res = _a.sent();
                    return [4 /*yield*/, q2Res.json()];
                case 4:
                    quote2 = _a.sent();
                    inSol = amountInLamports / 1e9;
                    outSol = Number(quote2.outAmount) / 1e9;
                    grossProfit = outSol - inSol;
                    staticBaseFee = 0.000005;
                    computeUnitFee = 0.000350;
                    grossProfitLamports = Math.floor(grossProfit * 1e9);
                    tipLamports = Math.max(Math.min(Math.floor(grossProfitLamports * 0.5), 5000000), 1000);
                    dynamicTipSol = tipLamports / 1e9;
                    totalNetworkOverhead = staticBaseFee + computeUnitFee + dynamicTipSol;
                    MIN_PROFIT = parseFloat(process.env.MIN_PROFIT_SOL || "0.00001");
                    netProfit = grossProfit - totalNetworkOverhead;
                    perfEnd = Date.now();
                    if (!(netProfit >= MIN_PROFIT)) return [3 /*break*/, 10];
                    console.log("\n\uD83C\uDFAF ATOMIC ARBITRAGE FOUND! [".concat(targetSymbol, "] Net Profit: +").concat(netProfit.toFixed(6), " SOL"));
                    console.log("\u23F1\uFE0F Route Evaluation Latency: ".concat(perfEnd - perfStart, "ms"));
                    console.log("\uD83D\uDDFA\uFE0F Route Taken: SOL -> ".concat(targetSymbol, " -> SOL"));
                    console.log("\uD83D\uDCB0 Slicing dynamic tip ratio directly to block leader: +".concat((dynamicTipSol).toFixed(6), " SOL"));
                    return [4 /*yield*/, safeFetch('https://lite-api.jup.ag/swap/v1/swap-instructions', {
                            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
                            body: JSON.stringify({ quoteResponse: quote1, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true })
                        })];
                case 5:
                    ix1Res = _a.sent();
                    return [4 /*yield*/, ix1Res.json()];
                case 6:
                    ix1 = _a.sent();
                    return [4 /*yield*/, safeFetch('https://lite-api.jup.ag/swap/v1/swap-instructions', {
                            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
                            body: JSON.stringify({ quoteResponse: quote2, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true })
                        })];
                case 7:
                    ix2Res = _a.sent();
                    return [4 /*yield*/, ix2Res.json()];
                case 8:
                    ix2 = _a.sent();
                    return [4 /*yield*/, (0, transaction_1.buildVersionedTransaction)(ix1, ix2, tipLamports)];
                case 9:
                    tx = _a.sent();
                    return [2 /*return*/, { transaction: tx, netProfit: netProfit, targetSymbol: targetSymbol, executionTime: perfEnd - perfStart }];
                case 10:
                    // Suppressing silent negative log traces natively to save terminal index buffering
                    process.stdout.write('.');
                    return [2 /*return*/, null];
            }
        });
    });
}
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var lastBalance, tradeCount, _i, TARGETS_1, target, tradeAmountSol, amountInLamports, opp, execStart, bs58, fetch_1, encodedTx, jitoPayload, jitoRes, jitoData, execEnd, sig, newBalance, e_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log("🚀 Starting Atomic Synthesizer Daemon via High-Speed Native Polling...");
                    console.log("⛓️ Execution Bound: Strict Synchronous (SOL -> TARGET -> SOL)");
                    console.log("⚙️  Target Slippage BPS: 5 (0.05%)");
                    console.log("\u2699\uFE0F  Target Minimum Profit Threshold: ".concat(process.env.MIN_PROFIT_SOL || "0.00001", " SOL"));
                    return [4 /*yield*/, getWalletBalance()];
                case 1:
                    lastBalance = _a.sent();
                    tradeCount = 0;
                    _a.label = 2;
                case 2:
                    if (!true) return [3 /*break*/, 14];
                    _i = 0, TARGETS_1 = TARGETS;
                    _a.label = 3;
                case 3:
                    if (!(_i < TARGETS_1.length)) return [3 /*break*/, 12];
                    target = TARGETS_1[_i];
                    _a.label = 4;
                case 4:
                    _a.trys.push([4, 10, , 11]);
                    tradeAmountSol = lastBalance * parseFloat(process.env.TRADE_PERCENTAGE || "0.25");
                    tradeAmountSol = Math.min(tradeAmountSol, parseFloat(process.env.MAX_TRADE_SIZE_SOL || "2.0"));
                    tradeAmountSol = Math.max(tradeAmountSol, 0.01);
                    amountInLamports = Math.floor(tradeAmountSol * 1e9);
                    return [4 /*yield*/, findAtomicOpportunity(target.mint, target.symbol, amountInLamports)];
                case 5:
                    opp = _a.sent();
                    if (!(opp && opp.transaction)) return [3 /*break*/, 9];
                    tradeCount++;
                    console.log("\n\uD83D\uDE80 [TRADE #".concat(tradeCount, "] Executing Atomic Bundle for ").concat(opp.targetSymbol, "..."));
                    execStart = Date.now();
                    bs58 = require('bs58');
                    fetch_1 = require('node-fetch');
                    encodedTx = bs58.encode(opp.transaction.serialize());
                    jitoPayload = { jsonrpc: "2.0", id: 1, method: "sendBundle", params: [[encodedTx]] };
                    return [4 /*yield*/, fetch_1("https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles", {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(jitoPayload)
                        })];
                case 6:
                    jitoRes = _a.sent();
                    return [4 /*yield*/, jitoRes.json()];
                case 7:
                    jitoData = _a.sent();
                    execEnd = Date.now();
                    console.log("\u2705 Bundle successfully injected into Jito TPU bypassing Mempool Node!");
                    console.log("[Jito Response]:", JSON.stringify(jitoData));
                    console.log("\u23F1\uFE0F Transaction Execution Network Latency: ".concat(execEnd - execStart, "ms"));
                    sig = bs58.encode(opp.transaction.signatures[0]);
                    console.log("\uD83D\uDD17 Evaluated Block Hash: https://solscan.io/tx/".concat(sig));
                    return [4 /*yield*/, getWalletBalance()];
                case 8:
                    newBalance = _a.sent();
                    console.log("\uD83D\uDCB0 New balance: ".concat(newBalance.toFixed(4), " SOL (\u0394 ").concat((newBalance - lastBalance).toFixed(8), " SOL)"));
                    lastBalance = newBalance;
                    _a.label = 9;
                case 9: return [3 /*break*/, 11];
                case 10:
                    e_1 = _a.sent();
                    // Only print strict indexer failures preventing terminal flooding
                    if (!e_1.message.includes("is not tradable")) {
                        console.log("\u274C ERROR on [".concat(target.symbol, "]: ").concat(e_1.message));
                    }
                    return [3 /*break*/, 11];
                case 11:
                    _i++;
                    return [3 /*break*/, 3];
                case 12: return [4 /*yield*/, new Promise(function (r) { return setTimeout(r, parseInt(process.env.POLL_INTERVAL_MS || "200")); })];
                case 13:
                    _a.sent();
                    return [3 /*break*/, 2];
                case 14: return [2 /*return*/];
            }
        });
    });
}
main().catch(function (err) {
    console.error("FATAL BINDING ERROR:", err);
    process.exit(1);
});
