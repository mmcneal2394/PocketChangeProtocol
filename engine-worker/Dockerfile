# Build stage
FROM rust:latest AS builder

WORKDIR /build

# Install build deps
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

# Copy manifests first for dependency caching
COPY Cargo.toml ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release 2>/dev/null || true
RUN rm -rf src

# Copy source and build
COPY src/ src/

RUN mkdir -p .cargo && echo '[build]\nincremental = false' > .cargo/config.toml

RUN cargo build --release

# Runtime stage
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /build/target/release/arbitrasaas-engine .

# Embed engine config directly (avoids COPY issues with Railway build context)
RUN printf 'mode = "paper"\n\
jito_endpoint = "https://mainnet.block-engine.jito.wtf"\n\
auto_execute_threshold_default = 0.3\n\
approval_timeout_secs = 300\n\
max_loss_24h = 50.0\n\
max_trade_size = 10.0\n\
max_cex_exposure_secs = 300\n\
rpc_fallback_urls = ["https://api.mainnet-beta.solana.com"]\n\
\n\
[strategy.triangular]\n\
auto_execute_threshold = 0.1\n\
enabled = true\n\
\n\
[strategy.cex_dex]\n\
auto_execute_threshold = 0.5\n\
enabled = false\n\
\n\
[strategy.flash_loan]\n\
auto_execute_threshold = 0.1\n\
enabled = true\n\
\n\
[strategy.funding_rate]\n\
auto_execute_threshold = 0.05\n\
enabled = true\n\
\n\
[strategy.statistical]\n\
auto_execute_threshold = 3.0\n\
enabled = true\n' > engine.toml

EXPOSE 3002

ENV RUST_LOG=info

CMD ["./arbitrasaas-engine"]
