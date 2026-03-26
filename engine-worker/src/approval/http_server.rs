use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use tower_http::cors::CorsLayer;
use std::sync::Arc;
use tokio::sync::RwLock;
use serde_json::{json, Value};
use tracing::info;

use crate::approval::ApprovalRouter;
use crate::executor::circuit_breaker::CircuitBreaker;
use crate::config::EngineConfig;
use crate::price::PriceCache;

pub struct AppState {
    pub router: Arc<ApprovalRouter>,
    pub circuit_breaker: Arc<RwLock<CircuitBreaker>>,
    pub config: Arc<EngineConfig>,
    pub start_time: std::time::Instant,
    pub price_cache: Arc<RwLock<PriceCache>>,
}

/// Check Bearer token auth
async fn check_auth(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, StatusCode> {
    let auth_token = std::env::var("ENGINE_API_SECRET").unwrap_or_default();
    if auth_token.is_empty() {
        return Ok(next.run(req).await);
    }

    let auth_header = req.headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if auth_header == format!("Bearer {}", auth_token) {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

async fn status_handler(State(state): State<Arc<AppState>>) -> Json<Value> {
    let cb = state.circuit_breaker.read().await;
    let uptime = state.start_time.elapsed().as_secs();

    Json(json!({
        "mode": format!("{:?}", state.config.mode).to_lowercase(),
        "uptime_secs": uptime,
        "circuit_breaker": {
            "active": cb.is_tripped(),
            "reason": cb.trip_reason()
        }
    }))
}

async fn get_opportunities(State(state): State<Arc<AppState>>) -> Json<Value> {
    let pending = state.router.get_pending().await;
    Json(json!(pending))
}

async fn approve_opportunity(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    state.router.approve(&id).await
        .map(|_| Json(json!({"status": "approved", "id": id})))
        .map_err(|_| StatusCode::NOT_FOUND)
}

async fn reject_opportunity(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    state.router.reject(&id).await
        .map(|_| Json(json!({"status": "rejected", "id": id})))
        .map_err(|_| StatusCode::NOT_FOUND)
}

pub async fn start_server(state: Arc<AppState>, port: u16) {
    let app = Router::new()
        .route("/api/status", get(status_handler))
        .route("/api/opportunities", get(get_opportunities))
        .route("/api/opportunities/{id}/approve", post(approve_opportunity))
        .route("/api/opportunities/{id}/reject", post(reject_opportunity))
        .layer(axum::middleware::from_fn(check_auth))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port))
        .await
        .expect("Failed to bind HTTP server");

    info!("Engine HTTP API listening on port {}", port);
    axum::serve(listener, app).await.expect("HTTP server failed");
}
