use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct VirtualTrade {
    pub timestamp: u64,
    pub path: String,
    pub trade_size_sol: f64,
    pub entry_price_usdc: f64,
    pub exit_price_usdc: f64,
    pub profit_usdc: f64,
}

pub struct TenantSandbox {
    pub tenant_id: String,
    pub initial_balance_usdc: f64,
    pub current_balance_usdc: f64,
    pub trade_history: Vec<VirtualTrade>,
}

pub struct SandboxManager {
    tenants: HashMap<String, TenantSandbox>,
}

impl SandboxManager {
    pub fn new() -> Self {
        SandboxManager {
            tenants: HashMap::new(),
        }
    }

    pub fn register_tenant(&mut self, tenant_id: String, start_balance: f64) {
        let sandbox = TenantSandbox {
            tenant_id: tenant_id.clone(),
            initial_balance_usdc: start_balance,
            current_balance_usdc: start_balance,
            trade_history: Vec::new(),
        };
        self.tenants.insert(tenant_id, sandbox);
    }

    pub fn execute_virtual_trade(
        &mut self,
        tenant_id: &str,
        path: String,
        size_sol: f64,
        entry_price: f64,
        exit_price: f64,
    ) -> Result<f64, String> {
        let tenant = self.tenants.get_mut(tenant_id).ok_or("Tenant not registered in SandboxManager")?;

        let cost_usdc = size_sol * entry_price;
        if cost_usdc > tenant.current_balance_usdc {
            return Err(format!("Insufficient virtual balance: required {}, available {}", cost_usdc, tenant.current_balance_usdc));
        }

        let revenue_usdc = size_sol * exit_price;
        // In a real system, subtract gas/fees here
        let profit_usdc = revenue_usdc - cost_usdc;

        tenant.current_balance_usdc += profit_usdc;

        // Mock timestamp
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        tenant.trade_history.push(VirtualTrade {
            timestamp,
            path,
            trade_size_sol: size_sol,
            entry_price_usdc: entry_price,
            exit_price_usdc: exit_price,
            profit_usdc,
        });

        Ok(profit_usdc)
    }

    pub fn get_tenant_pnl(&self, tenant_id: &str) -> Option<(f64, f64)> {
        if let Some(tenant) = self.tenants.get(tenant_id) {
            let total_profit = tenant.current_balance_usdc - tenant.initial_balance_usdc;
            Some((tenant.current_balance_usdc, total_profit))
        } else {
            None
        }
    }
}
