# Admin Operators Manual

This document is for platform operators administering the SaaS framework.

## Operational Monitoring
The system uses `timescaledb` for PNL aggregations and Prometheus for internal metrics.
To supervise the `arbitrasaas-engine` pods, ensure that horizontal scaling triggers perfectly when the NATS queue latency climbs over 250ms per transaction.

1. **System Toggles / Kill switch**
   - Access the `/admin` dash and hit "Emergency Global Halt". This dispatches a flag via NATS, pausing all workers instantaneously to protect users from sudden RPC disconnections or major MEV systemic risks.
   - You can also "Freeze specific user accounts" if terms of service are violated.

2. **KMS Policy & Upgrades**
   - Rotating the Master AES Key requires downtime for all active instances. You must decrypt and re-encrypt the stored credentials and flush the worker memory. Schedule this at minimum volatility hours.

3. **Billing Dispute & Audit**
   - Find exact traces via the `TradeLogs` in Postgres, indexed by `TxHash`, which guarantees transparency to users arguing execution failure or lost funds via Slippage.
   
4. **Health Endpoints**
   - `/health`: DB, NATS, and RPC. Returning 200 implies readiness. 
   - Internal RPCs cost money: if limit exceeds, you must fall back or add providers.
