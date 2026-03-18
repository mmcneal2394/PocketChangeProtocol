import asyncio
from strategies.triangular import TriangularStrategy
from strategies.cross_dex import CrossDexStrategy
from strategies.statistical import StatisticalStrategy
from strategies.funding_rate import FundingRateStrategy
from core.config_loader import ConfigLoader

class DummyPoolCache:
    def get_rate(self, base, target, dexes):
        return 1.05
    def get_price(self, token):
        return 150.0 if token == 'SOL' else 1.0
    def get_rates(self, base, quote, dexes):
        # Fake divergence data
        return {"raydium": 140.0, "orca": 145.0, "meteora": 150.0}

class DummyGasEstimator:
    def estimate_bundle_cost_usd(self, legs):
        return legs * 0.005

class DummySimulator:
    async def simulate_bundle(self, payload):
        return True
        
class DummyJitoExecutor:
    async def submit_atomic_bundle(self, payload):
        return "txn_sig_xxx123456"

async def main():
    print("[START] Loading Arbitrage Core Engine...")
    config_loader = ConfigLoader()
    config_loader.load()
    
    strategies = []
    
    if config_loader.is_strategy_enabled("triangular"):
        strategies.append(TriangularStrategy(config_loader.get_strategy_config("triangular")))
        
    if config_loader.is_strategy_enabled("cross_dex"):
        strategies.append(CrossDexStrategy(config_loader.get_strategy_config("cross_dex")))
        
    if config_loader.is_strategy_enabled("statistical"):
        strategies.append(StatisticalStrategy(config_loader.get_strategy_config("statistical")))
        
    if config_loader.is_strategy_enabled("funding_rate"):
        strategies.append(FundingRateStrategy(config_loader.get_strategy_config("funding_rate")))
        
    pool_cache = DummyPoolCache()
    gas_estimator = DummyGasEstimator()
    simulator = DummySimulator()
    jito_executor = DummyJitoExecutor()
    
    print(f"[OK] Initialized {len(strategies)} parallel modular strategies.")
    
    while True:
        opportunities = []
        for strategy in strategies:
            opp = await strategy.evaluate(pool_cache, gas_estimator)
            if opp:
                opportunities.append((strategy, opp))
                
        # Rank by absolute dollar profitability
        opportunities.sort(key=lambda x: x[1].expected_profit, reverse=True)
        
        if opportunities:
            best_strategy, best_opp = opportunities[0]
            print(f"[EXEC] Best Opportunity Found: {best_opp.route} | Expected ROI: ${best_opp.expected_profit:.2f}")
            
            # Execute top opportunity sequentially to avoid RPC spam
            await best_strategy.execute(best_opp, simulator, jito_executor)
            
        await asyncio.sleep(2) # Refresh polling heartbeat

if __name__ == "__main__":
    asyncio.run(main())
