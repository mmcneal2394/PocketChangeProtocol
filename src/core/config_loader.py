import yaml
import asyncio

class ConfigLoader:
    def __init__(self, filename="config.yaml"):
        self.filename = filename
        self.config = {}

    def load(self):
        try:
            with open(self.filename, 'r') as f:
                self.config = yaml.safe_load(f)
        except Exception as e:
            print(f"[ERROR] Failed to load config: {e}")
        return self.config

    def get_strategy_config(self, strategy_name):
        return self.config.get("strategies", {}).get(strategy_name, {})

    def is_strategy_enabled(self, strategy_name):
        return self.get_strategy_config(strategy_name).get("enabled", False)
