#!/usr/bin/env python3
import os, json, urllib.request, urllib.error
from dotenv import load_dotenv

# Path to the actual .env file of the bot
env_path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/.env'
load_dotenv(env_path)

key = os.getenv('GEMINI_API_KEY')
if not key:
    print('No API key found!')
    exit(1)

url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={key}'
data = json.dumps({'contents': [{'parts': [{'text': 'Hello'}]}]}).encode('utf-8')
req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='POST')

try:
    with urllib.request.urlopen(req) as resp:
        print('Success:', resp.status)
except urllib.error.HTTPError as e:
    print('HTTPError:', e.code)
    try:
        err_body = e.read().decode('utf-8')
        print('Error body:', err_body)
    except:
        print('Could not read error body')
