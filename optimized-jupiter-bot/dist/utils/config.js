"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const zod_1 = require("zod");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const envSchema = zod_1.z.object({
    GEYSER_ENDPOINT: zod_1.z.string().url().or(zod_1.z.string()),
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
    RESTRICT_INTERMEDIATE_TOKENS: zod_1.z.union([zod_1.z.boolean(), zod_1.z.string().transform((s) => s === 'true')]).default(true),
    BAGS_API_KEY: zod_1.z.string().optional(),
});
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
    console.error("Invalid environment variables");
    console.error(parsed.error.format());
    process.exit(1);
}
exports.config = parsed.data;
