# ArbitraSaaS API Documentation

## Authentication
Authentication is supported via Bearer Tokens or OAuth. Most endpoints require the `Authorization: Bearer <token>` header.

### Endpoints
#### `POST /api/auth/register`
- Registers a new user. Returns a JWT and User Object.

#### `POST /api/wallets/connect`
- Stores a new encrypted wallet.
- **Body**: `{ "encryptedKey": "...", "publicKey": "..." }`

#### `GET /api/wallets`
- Returns a list of the user's connected wallets, balances, and configurations.

#### `PUT /api/wallets/:id/config`
- Modify trading configuration for a specific wallet (e.g. `minProfitThreshold`, `jitoEnabled`).

#### `GET /api/analytics/trades`
- Retrieves paginated trade execution logs. 
- **Query Params**: `limit=20&offset=0&status=SUCCESS`

#### `GET /api/billing`
- Returns the current tenant subscription ID, active limits, and payment methods.
