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
var dotenv = __importStar(require("dotenv"));
var transaction_1 = require("../src/execution/transaction");
var config_1 = require("../src/utils/config");
dotenv.config();
function verify() {
    return __awaiter(this, void 0, void 0, function () {
        function safeFetchJSON(url, options) {
            return __awaiter(this, void 0, void 0, function () {
                var i, res, text, e_2;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0:
                            i = 0;
                            _a.label = 1;
                        case 1:
                            if (!(i < 15)) return [3 /*break*/, 9];
                            return [4 /*yield*/, fetch(url, options)];
                        case 2:
                            res = _a.sent();
                            return [4 /*yield*/, res.text()];
                        case 3:
                            text = _a.sent();
                            if (!text.startsWith("Rate limit")) return [3 /*break*/, 5];
                            console.log("\u23F3 Proxy Blocked [Status ".concat(res.status, "] - Waiting 5 seconds..."));
                            return [4 /*yield*/, new Promise(function (r) { return setTimeout(r, 5000); })];
                        case 4:
                            _a.sent();
                            return [3 /*break*/, 8];
                        case 5:
                            _a.trys.push([5, 6, , 8]);
                            return [2 /*return*/, JSON.parse(text)];
                        case 6:
                            e_2 = _a.sent();
                            console.log("\u23F3 Invalid JSON Payload - Waiting 5 seconds...");
                            return [4 /*yield*/, new Promise(function (r) { return setTimeout(r, 5000); })];
                        case 7:
                            _a.sent();
                            return [3 /*break*/, 8];
                        case 8:
                            i++;
                            return [3 /*break*/, 1];
                        case 9: throw new Error("Rate limit strictly blocked over 75s.");
                    }
                });
            });
        }
        var API_KEY, q1Url, quote1, q2Url, quote2, ix1Res, ix2Res, tx, connection, burstStart, sig, e_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log("🚦 Initiating explicit Atomic Arbitrage Bundle Structure Test...");
                    API_KEY = config_1.config.JUPITER_API_KEY || 'YOUR_JUPITER_API_KEY';
                    q1Url = "https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=nosXBqwB22HkM3pJo9YqQhG1hHh2gQ5pXhS7vXkXVmQ&amount=10000000&slippageBps=0";
                    return [4 /*yield*/, safeFetchJSON(q1Url, { headers: { 'x-api-key': API_KEY } })];
                case 1:
                    quote1 = _a.sent();
                    console.log("\uD83D\uDCCA Quote 1 [SOL -> NOS]: ".concat(Number(quote1.outAmount) / 1e6, " NOS"));
                    q2Url = "https://lite-api.jup.ag/swap/v1/quote?inputMint=nosXBqwB22HkM3pJo9YqQhG1hHh2gQ5pXhS7vXkXVmQ&outputMint=So11111111111111111111111111111111111111112&amount=".concat(quote1.outAmount, "&slippageBps=0");
                    return [4 /*yield*/, safeFetchJSON(q2Url, { headers: { 'x-api-key': API_KEY } })];
                case 2:
                    quote2 = _a.sent();
                    console.log("\uD83D\uDCCA Quote 2 [NOS -> SOL]: ".concat(Number(quote2.outAmount) / 1e9, " SOL"));
                    console.log("📦 Requesting distinct Raw Execution Instructions...");
                    return [4 /*yield*/, safeFetchJSON('https://lite-api.jup.ag/swap/v1/swap-instructions', {
                            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
                            body: JSON.stringify({ quoteResponse: quote1, userPublicKey: config_1.config.WALLET_PUBLIC_KEY, wrapAndUnwrapSol: true })
                        })];
                case 3:
                    ix1Res = _a.sent();
                    return [4 /*yield*/, safeFetchJSON('https://lite-api.jup.ag/swap/v1/swap-instructions', {
                            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
                            body: JSON.stringify({ quoteResponse: quote2, userPublicKey: config_1.config.WALLET_PUBLIC_KEY, wrapAndUnwrapSol: true })
                        })];
                case 4:
                    ix2Res = _a.sent();
                    console.log("🔗 Executing Atomic Bundle Logic natively...");
                    return [4 /*yield*/, (0, transaction_1.buildVersionedTransaction)(ix1Res, ix2Res, 10000)];
                case 5:
                    tx = _a.sent();
                    if (!tx) return [3 /*break*/, 10];
                    console.log("\n\u2705 Atomic structural merge complete! Final Payload Buffer: ".concat(tx.serialize().length, " bytes."));
                    console.log("\n🚀 FIRE IN THE HOLE! Executing Live Atomic Sandbox Bundle over ShadowLane...");
                    connection = new web3_js_1.Connection(config_1.config.RPC_ENDPOINT, { commitment: 'processed' });
                    burstStart = Date.now();
                    _a.label = 6;
                case 6:
                    _a.trys.push([6, 8, , 9]);
                    return [4 /*yield*/, connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 5 })];
                case 7:
                    sig = _a.sent();
                    console.log("\u26A1 Broadcast Complete! Network Insertion Latency: ".concat(Date.now() - burstStart, "ms"));
                    console.log("\u2705 Fully Synchronous Execution Complete! Payload Hash: https://solscan.io/tx/".concat(sig));
                    process.exit(0);
                    return [3 /*break*/, 9];
                case 8:
                    e_1 = _a.sent();
                    console.error("\u274C Execution Failed: ".concat(e_1.message));
                    process.exit(1);
                    return [3 /*break*/, 9];
                case 9: return [3 /*break*/, 11];
                case 10:
                    console.error("❌ Bundle compilation collapsed over parameters sequence mapping.");
                    process.exit(1);
                    _a.label = 11;
                case 11: return [2 /*return*/];
            }
        });
    });
}
verify().catch(console.error);
