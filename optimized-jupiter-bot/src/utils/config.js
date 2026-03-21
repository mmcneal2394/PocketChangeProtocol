"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
var zod_1 = require("zod");
var dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
var envSchema = zod_1.z.object({
    GEYSER_RPC: zod_1.z.string().url().or(zod_1.z.string()),
    GEYSER_API_TOKEN: zod_1.z.string(),
    RPC_ENDPOINT: zod_1.z.string().url(),
    RPC_WEBSOCKET: zod_1.z.string().url(),
    JITO_AUTH: zod_1.z.string().optional(),
    JITO_BLOCK_ENGINE: zod_1.z.string().url(),
    JITO_TIP_AMOUNT: zod_1.z.string().transform(Number),
    JUPITER_ENDPOINT: zod_1.z.string().url(),
    JUPITER_API_KEY: zod_1.z.string(),
    WALLET_KEYPAIR_PATH: zod_1.z.string(),
    WALLET_PUBLIC_KEY: zod_1.z.string(),
    SLIPPAGE_BPS: zod_1.z.string().transform(Number),
    MIN_PROFIT_BPS: zod_1.z.string().transform(Number),
    MAX_TRADE_SIZE_SOL: zod_1.z.string().transform(Number),
    RESTRICT_INTERMEDIATE_TOKENS: zod_1.z.union([zod_1.z.boolean(), zod_1.z.string().transform(function (s) { return s === 'true'; })]).default(true),
    BAGS_API_KEY: zod_1.z.string().optional(),
    // Local Engine Constants
    MIN_PROFIT_SOL: zod_1.z.string().default("0.05").transform(Number),
    TIP_PERCENTAGE: zod_1.z.string().default("0.5").transform(Number),
    MAX_SLIPPAGE_BPS: zod_1.z.string().default("50").transform(Number),
    SCAN_INTERVAL_MS: zod_1.z.string().default("100").transform(Number),
    TOKENS_TO_SCAN: zod_1.z.string().default("So11111111111111111111111111111111111111112"),
    // Storage System Mappings
    LOG_DB_PATH: zod_1.z.string().default("./trades.db")
});
var parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
    console.error("Invalid environment variables");
    console.error(parsed.error.format());
    process.exit(1);
}
exports.config = parsed.data;
