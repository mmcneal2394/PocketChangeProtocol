from typing import Optional, Any
from .base import Strategy, Opportunity
import asyncio

class CrossDexStrategy(Strategy):
    """
    Executes a standard 2-hop cross-exchange arbitrage (Buy on Dex A -> Sell on Dex B).
    """
    def __init__(self, config):
        super().__init__("CrossDexArbitrage", config)
        self.min_profit_percent = self.config.get("min_profit_percent", 0.5)
        self.pairs = self.config.get("pairs", ["SOL/USDC", "RAY/USDC"])
        self.allowed_dexes = self.config.get("allowed_dexes", ["raydium", "orca", "meteora"])
        
    async def evaluate(self, pool_cache: Any, gas_estimator: Any) -> Optional[Opportunity]:
        if not self.is_enabled:
            return None
            
        if await self.check_cooldown():
            return None
            
        for pair in self.pairs:
            base, quote = pair.split('/')
            
            # Simulated cache fetch across top DEXes
            rates = pool_cache.get_rates(base, quote, self.allowed_dexes)
            if len(rates) < 2:
                continue
                
            sorted_rates = sorted(rates.items(), key=lambda x: x[1])
            best_buy_dex, min_p = sorted_rates[0]
            best_sell_dex, max_p = sorted_rates[-1]
            
            spread_pct = ((max_p - min_p) / min_p) * 100
            
            if spread_pct >= self.min_profit_percent:
                estimated_profit_usd = (max_p - min_p) # Simplification 
                gas_cost_usd = gas_estimator.estimate_bundle_cost_usd(2)
                net_profit_usd = estimated_profit_usd - gas_cost_usd
                
                if net_profit_usd > 0:
                    route_str = f"Buy {base} on {best_buy_dex} -> Sell on {best_sell_dex}"
                    payload = {
                        "buy_leg": {"dex": best_buy_dex, "token": base, "price": min_p},
                        "sell_leg": {"dex": best_sell_dex, "token": base, "price": max_p}
                    }
                    return Opportunity(expected_profit=net_profit_usd, route=route_str, raw_payload=payload)
                    
        return None

    async def execute(self, opportunity: Opportunity, simulator: Any, jito_executor: Any) -> bool:
        """
        Executes the compiled opportunity sequence.
        """
        print(f"[{self.name}] Preparing execution for route: {opportunity.route}")
        
        sim_success = await simulator.simulate_bundle(opportunity.raw_payload)
        
        if not sim_success:
            print(f"[{self.name}] Simulation failed. Skipping execution.")
            self.mark_failure()
            return False
            
        bundle_id = await jito_executor.submit_atomic_bundle(opportunity.raw_payload)
        
        if bundle_id:
            print(f"[{self.name}] ✅ Bundle Confirmed! ID: {bundle_id}")
            return True
        else:
            print(f"[{self.name}] ❌ Bundle Rejected.")
            self.mark_failure()
            return False
