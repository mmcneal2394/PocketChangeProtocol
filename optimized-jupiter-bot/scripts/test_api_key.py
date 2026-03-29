import os
import json
from google import genai

api_key = "AIzaSyBTY3pgSZ0uVNEiRJsJ7n954N4-FewySno"

prompt = """You are a quantitative trading bot optimization expert specializing in Solana memecoin momentum strategies.

You will receive:
1. Performance findings from the bot's live trade journal (structured JSON)
2. Current bot strategy parameters

Your job: Propose exactly 3 concrete, actionable parameter changes.

Rules:
- Each proposal must include specific parameter names and numeric values

Output ONLY valid JSON in this exact format:
{
  "proposals": [
    {
      "rank": 1,
      "title": "Short title of change",
      "rationale": "1-2 sentence explanation citing specific finding",
      "param_changes": [
        {"param": "min_buy_ratio", "value": 3.0}
      ],
      "expected_impact": "Estimated win rate improvement"
    }
  ]
}

Findings:
[{"severity": "HIGH", "category": "win_rate", "suggestion": "Decrease tp_pct", "data": {"win_rate": 30}}]
Current params:
{"tp_pct": 20, "sl_pct": 15}
"""

try:
    print("Initializing client...")
    client = genai.Client(api_key=api_key)
    print("Calling generate_content...")
    response = client.models.generate_content(
        model='gemini-2.5-flash',
        contents=prompt,
        config=genai.types.GenerateContentConfig(
            temperature=0.3, max_output_tokens=1024
        )
    )
    print("\n--- RAW TEXT ---")
    print(response.text)
    print("--- END TEXT ---\n")
except Exception as e:
    print(f"Error: {e}")
