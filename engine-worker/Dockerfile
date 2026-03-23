# Build stage
FROM rust:1.84-slim AS builder

WORKDIR /build

# Install build deps
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

# Copy manifests first for dependency caching
COPY Cargo.toml ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release 2>/dev/null || true
RUN rm -rf src

# Copy source and build
COPY src/ src/
COPY .cargo/ .cargo/
RUN cargo build --release

# Runtime stage
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /build/target/release/arbitrasaas-engine .
COPY engine.toml .

EXPOSE 3002

ENV RUST_LOG=info

CMD ["./arbitrasaas-engine"]
