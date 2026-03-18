from abc import ABC, abstractmethod
from typing import Optional, Dict, Any
import time

class Opportunity:
    """
    Represents a profitable arbitrage opportunity.
    """
    def __init__(self, expected_profit: float, route: str, raw_payload: Any):
        self.expected_profit = expected_profit
        self.route = route
        self.raw_payload = raw_payload
        self.timestamp = time.time()

class Strategy(ABC):
    """
    Base class for all arbitrage strategies.
    Ensures that every strategy implements 'evaluate' and 'execute'.
    """
    def __init__(self, name: str, config: Dict[str, Any]):
        self.name = name
        self.config = config
        self.is_enabled = config.get("enabled", False)
        
        # Cooldown parameters
        self.cooldown_period = config.get("cooldown_seconds", 5)
        self.last_failed_execution = 0.0

    async def check_cooldown(self) -> bool:
        """
        Returns True if the strategy is currently under cooldown after a failure.
        """
        if time.time() - self.last_failed_execution < self.cooldown_period:
            return True
        return False

    def mark_failure(self):
        """
        Triggers the cooldown for the strategy after an execution failure.
        """
        print(f"[{self.name}] Execution failed. Triggering {self.cooldown_period}s cooldown...")
        self.last_failed_execution = time.time()

    @abstractmethod
    async def evaluate(self, pool_cache, gas_estimator) -> Optional[Opportunity]:
        """
        Evaluates current pool state and returns an Opportunity if profitable.
        Must be implemented by subclasses.
        """
        pass

    @abstractmethod
    async def execute(self, opportunity: Opportunity, simulator, jito_executor) -> bool:
        """
        Executes the provided opportunity.
        Must be implemented by subclasses.
        """
        pass
