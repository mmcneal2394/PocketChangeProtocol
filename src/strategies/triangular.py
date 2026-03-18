from typing import Optional, Any
from .base import Strategy, Opportunity
import asyncio

class TriangularStrategy(Strategy):
    """
    Executes a 3-hop triangular arbitrage (e.g., SOL -> RAY -> USDC -> SOL).
    Reuses the core PoolCache to prevent duplicate network calls.
    """
    def __init__(self, config):
        super().__init__("TriangularArbitrage", config)
        self.min_profit_usd = self.config.get("min_profit_usd", 2.0)
        self.allowed_dexes = self.config.get("allowed_dexes", ["raydium", "orca"])
        
        # Example defined triangles (Base Token -> Target -> Stable -> Base)
        self.triangles = [
            ("SOL", "RAY", "USDC"),
            ("SOL", "BONK", "USDC"),
            ("SOL", "WIF", "USDC")
        ]

    async def evaluate(self, pool_cache: Any, gas_estimator: Any) -> Optional[Opportunity]:
        if not self.is_enabled:
            return None
            
        if await self.check_cooldown():
            return None
            
        # Simulating fetching pool state from cache
        # print(f"[{self.name}] Scanning {len(self.triangles)} triangles in {self.allowed_dexes}...")
        
        for t in self.triangles:
            base, target, stable = t
            # 1. Fetch live pool routes
            leg1_rate = pool_cache.get_rate(base, target, self.allowed_dexes)
            leg2_rate = pool_cache.get_rate(target, stable, self.allowed_dexes)
            leg3_rate = pool_cache.get_rate(stable, base, self.allowed_dexes)
            
            if not leg1_rate or not leg2_rate or not leg3_rate:
                continue
                
            # 2. Estimate 1 SOL round-trip yield
            initial_capital = 1.0  # Assumes 1 SOL
            output = initial_capital * leg1_rate * leg2_rate * leg3_rate
            
            estimated_profit_sol = output - initial_capital
            estimated_profit_usd = estimated_profit_sol * pool_cache.get_price("SOL")
            
            # 3. Gas Estimation
            gas_cost_usd = gas_estimator.estimate_bundle_cost_usd(3)
            net_profit_usd = estimated_profit_usd - gas_cost_usd
            
            if net_profit_usd >= self.min_profit_usd:
                route_str = f"{base} -> {target} -> {stable} -> {base}"
                payload = {
                    "legs": [t[0], t[1], t[2]],
                    "estimated_yield": output
                }
                return Opportunity(expected_profit=net_profit_usd, route=route_str, raw_payload=payload)
                
        return None

    async def execute(self, opportunity: Opportunity, simulator: Any, jito_executor: Any) -> bool:
        """
        Executes the compiled opportunity sequence.
        """
        print(f"[{self.name}] Preparing execution for route: {opportunity.route}")
        
        # 1. Pre-trade Simulation
        sim_success = await simulator.simulate_bundle(opportunity.raw_payload)
        
        if not sim_success:
            print(f"[{self.name}] Simulation failed. Skipping execution.")
            self.mark_failure()
            return False
            
        # 2. Submit Bundle
        print(f"[{self.name}] Simulation passed! Submitting to Jito Executor...")
        bundle_id = await jito_executor.submit_atomic_bundle(opportunity.raw_payload)
        
        if bundle_id:
            print(f"[{self.name}] ✅ Bundle Confirmed! ID: {bundle_id}")
            return True
        else:
            print(f"[{self.name}] ❌ Bundle Rejected or Landed Failed.")
            self.mark_failure()
            return False
