import os
import re

ENV_FILE = "/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/.env"
CRITIC_FILE = "/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/swarm/critic_agent.py"
ARB_CRITIC_FILE = "/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/swarm/arb_critic_agent.py"
NEW_API_KEY = "AIzaSyBTY3pgSZ0uVNEiRJsJ7n954N4-FewySno"

def patch_env():
    with open(ENV_FILE, "r") as f:
        env = f.read()
    if "GEMINI_API_KEY=" in env:
        env = re.sub(r"^GEMINI_API_KEY=.*$", f"GEMINI_API_KEY={NEW_API_KEY}", env, flags=re.MULTILINE)
    else:
        env += f"\nGEMINI_API_KEY={NEW_API_KEY}\n"
    with open(ENV_FILE, "w") as f:
        f.write(env)
    print("Patched .env for the fresh Gemini API Key")

def patch_file(filepath):
    if not os.path.exists(filepath):
        print(f"Skipped {filepath} - doesn't exist")
        return
        
    with open(filepath, "r") as f:
        content = f.read()

    new_call_gemini = f"""def call_gemini(prompt: str, retries: int = 3) -> Optional[str]:
    import time
    from google import genai
    from google.genai import errors
    import os
    
    # Load API Key dynamically
    api_key = os.getenv("GEMINI_API_KEY", "")
    if not api_key:
        return None
        
    try:
        # Initialize Google GenAI natively with the developer API key (no Vertex mapping)
        client = genai.Client(api_key=api_key)
    except Exception as auth_err:
        print(f"[Agent] SDK Initialization Error: {{auth_err}}")
        return None
    
    for attempt in range(retries):
        try:
            response = client.models.generate_content(
                model='gemini-2.5-flash',
                contents=prompt,
                config=genai.types.GenerateContentConfig(
                    temperature=0.3, max_output_tokens=1024
                )
            )
            return response.text
        except errors.APIError as e:
            if e.code == 429:
                wait_time = (attempt + 1) * 3
                print(f"[Agent] HTTP 429 AI Studio Rate Limit. Retrying in {{wait_time}}s...")
                time.sleep(wait_time)
            else:
                print(f"[Agent] GenAI APIErr: {{e}}")
                return None
        except Exception as e:
            print(f"[Agent] GenAI call failed: {{e}}")
            return None
    return None"""

    content = re.sub(r"def call_gemini\(prompt: str, retries: int = 3\) -> Optional\[str\]:[\s\S]*?return None\s*\n\s*\ndef", new_call_gemini + "\n\ndef", content)
    
    with open(filepath, "w") as f:
        f.write(content)
    print(f"Patched {filepath} to use the GenAI Standard SDK with an API Key")

try:
    patch_env()
    patch_file(CRITIC_FILE)
    patch_file(ARB_CRITIC_FILE)
except Exception as e:
    print(e)
