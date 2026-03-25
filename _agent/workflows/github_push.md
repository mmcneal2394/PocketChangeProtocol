---
description: how to push updates to GitHub safely
---

# Secure GitHub Push Workflow

This workflow runs automatically via the git pre-push hook.
Every `git push` triggers `scripts/pre_push_security.js` first.

// turbo-all

1. Stage your changes normally
```
git add -A
```

2. Commit your changes
```
git commit -m "your message"
```

3. Push — the pre-push hook runs AUTOMATICALLY before the push goes through
```
git push origin HEAD:main
```
The hook will:
- Scrub any hardcoded Helius/Chainstack/Bags credentials from source files
- Block the push if any secret patterns remain after scrubbing
- Report exactly which files have issues

4. If blocked, fix the flagged files and retry from step 1

> To bypass in an emergency (NOT recommended): `git push --no-verify`
