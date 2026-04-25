import os
from google import genai

api_key = os.getenv("GOOGLE_API_KEY", "")

prompt = """You are a quantitative trading bot optimization expert specializing in Solana memecoin momentum strategies.

You will receive:
1. Performance findings from the bot's live trade journal (structured JSON)
2. Current bot strategy parameters

Your job: Propose exactly 3 concrete, actionable parameter changes.
"""

try:
    if not api_key:
        raise RuntimeError("GOOGLE_API_KEY is not set")
    print("Initializing client...")
    client = genai.Client(api_key=api_key)
    print("Calling generate_content...")
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt,
        config=genai.types.GenerateContentConfig(
            temperature=0.3, max_output_tokens=1024
        ),
    )
    print("\n--- RAW TEXT ---")
    print(response.text)
    print("--- END TEXT ---\n")
except Exception as e:
    print(f"Error: {e}")
