export const STREAMS = {
  TRADES: 'stream:trades',
};

export const CHANNELS = {
  VELOCITY_SPIKE: 'velocity:spike',
  CONFIG_UPDATE: 'config:update',
};

export const PARAM_NAMES = {};

export const REDIS_KEYS = {
  CONFIG_PERFORMANCE: 'config:performance',
  cooldown: (mint: string) => `cooldown:${mint}`,
  momentum: (mint: string) => `momentum:${mint}`,
  tempBlacklist: (mint: string) => `temp:blacklist:${mint}`,
  position: (mint: string) => `position:${mint}`,
};

module.exports = {
  STREAMS,
  CHANNELS,
  PARAM_NAMES,
  REDIS_KEYS,
};
