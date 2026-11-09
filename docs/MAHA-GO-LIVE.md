# Maha go-live checklist

Maha is the AI chat assistant. She is built on branch `feature/maha`, which is never deployed to staging or prod until the owner approves (owner, 2026-11-09). She was tested on the local rehearsal stack with the scripted test AI:

- `scripts/maha-e2e.mjs`: 36 of 36 checks pass.
- Browser check of the agent and admin screens: 10 of 10 pass.
- Unit tests pass.

## Before the approval (no cost, no customer impact)

| #   | Step                                                                                                                                                          | Who             | Status      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------- |
| 1   | Operations answer the 9 questions (cashback, points, Play & Win, 7 km, driver number, refund days, phone, jobs email)                                         | Owner, with ops | waiting     |
| 2   | Turn the answers and `D:\emad\ai-kb\knowledge-base-draft.md` into knowledge-base entries                                                                      | Claude          | after 1     |
| 3   | Optional, to make go-live take under an hour: release the code to prod with Maha **Off** (below, steps 6 to 9), so approval only needs the key and the switch | Owner decides   | not started |

## On approval

| #   | Step                                                                                                                                                     | Who                                          | Notes                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | Company Google AI account with billing. One key for staging, one for prod                                                                                | Ayman's side / owner                         | The personal free key is retired on both environments                                                                                           |
| 5   | Put the keys in the task definitions (`GEMINI_API_KEY`), and set `GEMINI_MODEL=gemini-3.8-flash`                                                         | IT / owner                                   | AWS change. Claude does not enter keys                                                                                                          |
| 6   | **Load-balancer rule `/auto-reply` → ai-gateway**, on staging and prod                                                                                   | Owner approves; then IT or Claude            | Without it, every Maha answer fails through the load balancer and is handed to an agent. This is also why the old staging drafts never appeared |
| 7   | Merge main into `feature/maha`, run the full `pnpm verify`, then merge into main                                                                         | Claude                                       | The full check runs before every push                                                                                                           |
| 8   | Staging: database fields, deploy, then `scripts/maha-e2e.mjs` against staging with the scripted test AI; then turn the scripted AI off                   | Claude                                       | Staging already has the `conversations.ai_*` fields                                                                                             |
| 9   | Prod database: `scripts/add-maha-fields.mjs --write`, the `ai_draft` field, and the `ai_knowledge` collection with read permission for agents and admins | Claude, with the owner's OK                  | Additive only. Everything reads these fields defensively                                                                                        |
| 10  | Prod release, services and portals, with Maha **Off**                                                                                                    | Claude, with the owner's double confirmation | Normal release checklist. The owner presses Update now                                                                                          |
| 11  | Knowledge base loaded on prod                                                                                                                            | Claude                                       | From step 2                                                                                                                                     |
| 12  | The 50-chat test: `MAHA_EVAL_PAID_KEY=yes GEMINI_API_KEY=… npx tsx services/ai-gateway/scripts/maha-eval.ts D:/emad/ai-kb/data/pairs.json`               | Claude                                       | Review sheet for the owner and ops. Fix the knowledge base or the prompt where Maha is wrong                                                    |
| 13  | AI settings → Maha **Assist** (drafts only) for a day, then **Auto**                                                                                     | Owner                                        | Admin portal → AI settings. Budget 250 SAR/month, all day, 3 replies                                                                            |

## Rollback

Admin portal → AI settings → Maha **Off**. This takes effect at once, with no deploy. Chats Maha has open finish with her; new chats go to agents.
