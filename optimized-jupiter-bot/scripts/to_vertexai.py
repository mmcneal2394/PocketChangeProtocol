import os
import re

ENV_FILE = "/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/.env"
CRITIC_FILE = "/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/swarm/critic_agent.py"
ARB_CRITIC_FILE = "/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/swarm/arb_critic_agent.py"
GCP_JSON_PATH = "/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/swarm/gcp_key.json"
PROJECT_ID = "gen-lang-client-0028232191"

def patch_env():
    with open(ENV_FILE, "r") as f:
        env = f.read()
    if "GOOGLE_APPLICATION_CREDENTIALS=" in env:
        env = re.sub(r"^GOOGLE_APPLICATION_CREDENTIALS=.*$", f"GOOGLE_APPLICATION_CREDENTIALS={GCP_JSON_PATH}", env, flags=re.MULTILINE)
    else:
        env += f"\nGOOGLE_APPLICATION_CREDENTIALS={GCP_JSON_PATH}\n"
    with open(ENV_FILE, "w") as f:
        f.write(env)
    print("Patched .env for Vertex AI Credentials")

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
    import google.auth
    
    try:
        # Initialize Google GenAI explicitly for Vertex AI maps to the provided project
        client = genai.Client(
            vertexai=True, 
            project="{PROJECT_ID}", 
            location="us-central1"
        )
    except Exception as auth_err:
        print(f"[Agent] GCP Auth Error: {{auth_err}} - Missing GOOGLE_APPLICATION_CREDENTIALS.")
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
                print(f"[Agent] HTTP 429 Vertex AI Rate Limit. Retrying in {{wait_time}}s...")
                time.sleep(wait_time)
            else:
                print(f"[Agent] Vertex APIErr: {{e}}")
                return None
        except Exception as e:
            print(f"[Agent] Vertex call failed: {{e}}")
            return None
    return None"""

    content = re.sub(r"def call_gemini\(prompt: str, retries: int = 3\) -> Optional\[str\]:[\s\S]*?return None\s*\n\s*\ndef", new_call_gemini + "\n\ndef", content)
    
    with open(filepath, "w") as f:
        f.write(content)
    print(f"Patched {filepath} to use Vertex AI GenAI SDK")

try:
    patch_env()
    patch_file(CRITIC_FILE)
    patch_file(ARB_CRITIC_FILE)
except Exception as e:
    print(e)
