import os

CRITIC_FILE = "/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/swarm/critic_agent.py"
ARB_CRITIC_FILE = "/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/swarm/arb_critic_agent.py"

def p(filepath):
    if not os.path.exists(filepath):
        return
    with open(filepath, 'r') as fp: c = fp.read()
    c = c.replace('OPENAI_API_KEY', 'GEMINI_API_KEY')
    c = c.replace('OPENAI_MODEL', 'GEMINI_MODEL')
    with open(filepath, 'w') as fp: fp.write(c)

p(CRITIC_FILE)
p(ARB_CRITIC_FILE)
print("Restored GLOBAL Gemini Vars")
