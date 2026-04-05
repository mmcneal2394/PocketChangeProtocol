import re

path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/swarm_critic_agent.py'
with open(path) as f:
    content = f.read()

# Change config:update -> critic:proposals for the main publish
content = content.replace(
    'r.publish("config:update", json.dumps(output))',
    'r.publish("critic:proposals", json.dumps(output))'
)
content = content.replace(
    """print("[CriticAgent] 📡 Published AI proposals to Redis ('config:update')")""",
    """print("[CriticAgent] 📡 Published AI proposals to Redis ('critic:proposals')")"""
)

with open(path, 'w') as f:
    f.write(content)
print('OK - critic now publishes to critic:proposals only')
