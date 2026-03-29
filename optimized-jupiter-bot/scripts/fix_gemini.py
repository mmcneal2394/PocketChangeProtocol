import os
import re

CRITIC_FILE = "/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/swarm/critic_agent.py"
ARB_CRITIC_FILE = "/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/swarm/arb_critic_agent.py"

def patch_file(filepath):
    if not os.path.exists(filepath):
        return
        
    with open(filepath, "r") as f:
        content = f.read()

    # Fix the undefined 'filepath' variable in the error logging
    content = content.replace("{os.path.basename(filepath)}", "Agent")
    
    with open(filepath, "w") as f:
        f.write(content)
    print(f"Patched syntax in {filepath}")

patch_file(CRITIC_FILE)
patch_file(ARB_CRITIC_FILE)
