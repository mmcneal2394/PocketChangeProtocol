FROM node:18-alpine

WORKDIR /app

# The AI agent only needs these specific production dependencies to function.
# We skip copying the root package.json to avoid the massive test-suite bloat.
RUN npm init -y && \
    npm install dotenv twitter-api-v2 node-telegram-bot-api axios

# Copy the agent scripts
COPY scripts/ ./scripts/
COPY .env .env
# Telemetry file is mounted via volume, but we create the directory
RUN mkdir -p engine-worker

# The AI agent runs persistently
CMD ["node", "scripts/ai_agent.js"]
