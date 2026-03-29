import os
import re

CRITIC_FILE = "/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/swarm/critic_agent.py"
ARB_CRITIC_FILE = "/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/swarm/arb_critic_agent.py"

def patch_file(filepath):
    if not os.path.exists(filepath):
        print(f"Skipped {filepath} - doesn't exist")
        return
        
    with open(filepath, "r") as f:
        content = f.read()

    # Change keys
    content = content.replace('os.getenv("GEMINI_API_KEY", "")', 'os.getenv("OPENAI_API_KEY", "")')
    content = content.replace('GEMINI_API_KEY', 'OPENAI_API_KEY')
    content = content.replace('GEMINI_MODEL   = "gemini-2.5-flash"', 'OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")')
    content = content.replace('GEMINI_MODEL', 'OPENAI_MODEL')

    new_call_gemini = """def call_gemini(prompt: str, retries: int = 3) -> Optional[str]:
    if not OPENAI_API_KEY:
        return None
    import time
    from openai import OpenAI
    client = OpenAI(api_key=OPENAI_API_KEY)
    
    for attempt in range(retries):
        try:
            response = client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.3,
                max_tokens=1024
            )
            return response.choices[0].message.content
        except Exception as e:
            err_str = str(e).lower()
            if "429" in err_str or "rate limit" in err_str:
                wait_time = (attempt + 1) * 3
                print(f"[Agent] HTTP 429 Rate Limit. Retrying in {wait_time}s...")
                time.sleep(wait_time)
            else:
                print(f"[Agent] OpenAI call failed: {e}")
                return None
    return None"""

    # Delete the current call_gemini to avoiding messy replacements
    content = re.sub(r"def call_gemini\(prompt: str, retries: int = 3\) -> Optional\[str\]:[\s\S]*?return None\s*\n\s*\ndef", new_call_gemini + "\n\ndef", content)
    
    with open(filepath, "w") as f:
        f.write(content)
    print(f"Patched {filepath} to use openai SDK")

try:
    patch_file(CRITIC_FILE)
    patch_file(ARB_CRITIC_FILE)
except Exception as e:
    print(e)
