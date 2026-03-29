// src/shared/redis_config.ts

export const CHANNELS = {
    OPTIMIZER_UPDATE: 'optimizer:update',
    TRADE_SIGNAL: 'trade:signal',
    WALLET_STATE: 'wallet:state',
    CONFIG_UPDATE: 'config:update',
    VELOCITY_SPIKE: 'velocity:spike',
    ENGINE_FORCE_SELL: 'engine:force_sell',
    NEW_TOKEN: 'new:token',
};

export const STREAMS = {
    TRADES: 'stream:trades',
};

export const REDIS_KEYS = {
    // Dynamic accessors
    price: (mint: string) => `price:${mint}`,
    momentum: (mint: string) => `momentum:${mint}`,
    position: (mint: string) => `position:${mint}`,
    tradeParams: (mint: string) => `trade:params:${mint}`,
    cooldown: (mint: string) => `cooldown:${mint}`,
    apexAnalysis: (mint: string) => `apex:analysis:${mint}`,
    tempBlacklist: (mint: string) => `temp_blacklist:${mint}`,
    
    // Static globals
    WALLET_TOTAL_USD: 'wallet:totalValueUSD',
    WALLET_CURRENT: 'wallet:current',
    MARKET_REGIME: 'market:regime',
    CONFIG_PERFORMANCE: 'config:performance',
    apexCandidates: 'apex:candidates',
};

export const PARAM_NAMES = {
    POSITION_SIZE_TOKENS: 'positionSizeTokens',
    POSITION_SIZE_USD: 'positionSizeUSD',
    MAX_BUY_PRICE: 'maxBuyPrice',
    EXPECTED_VALUE: 'expectedValue',
    TP1_PCT: 'tp1Pct',
    TP2_PCT: 'tp2Pct',
    TRAILING_STOP_PCT: 'trailingStopPct',
    STOP_LOSS_PCT: 'stopLossPct',
    BE_PCT: 'bePct',
    MAX_TP_PCT: 'maxTPpct',
    MAX_HOLD_MINUTES: 'maxHoldMinutes',
};
