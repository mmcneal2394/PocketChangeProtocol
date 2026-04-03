export const swarmTools: any[] = [
  {
    type: "function",
    function: {
      name: "evaluate_trade",
      description: "Evaluate a token for a potential trade",
      parameters: {
        type: "object",
        properties: {
          token_mint: { type: "string", description: "The token's mint address" },
          velocity_score: { type: "number", description: "The token's current velocity score" },
          volume_24h: { type: "number", description: "The token's 24-hour volume in USD" }
        },
        required: ["token_mint", "velocity_score"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_wallet_balance",
      description: "Get the current SOL balance of the trading wallet",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "execute_trade",
      description: "Execute a trade (buy or sell) on a given token",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["buy", "sell"] },
          token_mint: { type: "string" },
          amount_sol: { type: "number" }
        },
        required: ["action", "token_mint", "amount_sol"]
      }
    }
  }
];
