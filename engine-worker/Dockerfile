# Minimal Runtime Environment for pre-compiled Droplet host binary
FROM debian:bookworm-slim

# Install runtime dependencies (OpenSSL is commonly needed)
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the compiled binary from the host context
COPY pcprotocol-engine ./pcprotocol-engine
COPY .env .env
COPY telemetry.jsonl ./telemetry.jsonl

# Run the engine
CMD ["./pcprotocol-engine"]
