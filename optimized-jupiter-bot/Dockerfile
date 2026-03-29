FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install native compilation tools if node-gyp is required by any dependency
RUN apk add --no-cache python3 make g++ 

# Install dependencies exclusively
COPY package*.json tsconfig.json ./
RUN npm install
RUN npm install -g typescript pm2 ts-node

# Copy local application code
COPY . .

# Run the typescript orchestrator directly via PM2
CMD ["pm2-runtime", "start", "ecosystem.config.js"]
