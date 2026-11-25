# TeamReel

**What every team shipped this week, in one fast video your whole company will watch.**

![TeamReel preview](docs/preview.gif)

Nobody reads the fifth "here's the scoop" thread of the week. TeamReel reads it for them. Every Friday it goes through each team's merged pull requests, finished Jira tickets and public Slack channels, picks out what the rest of the company should know, and posts a 40-second reel to Slack:

- **What launched**, in plain words: "Customers can now pay with Apple Pay in 12 countries", not "feat(checkout): add PKPaymentButton".
- **The numbers that moved**: conversion up, a deal signed, quota hit.
- **Progress on goals**: "81% of the way to the Q4 target."
- **Who made it happen**, with their faces from Slack.
- **What's next** for each team.

An AI editor reads the code and the conversation the way a good chief of staff would. It turns a dozen PRs into one feature, skips refactors and dependency bumps, and credits everyone who worked on it.

## Nothing made up

Every number on screen has to appear, as written, in a PR, ticket or Slack post. Every person credited has to appear in the work behind that item. Anything that fails a check is dropped, not reworded. The Slack post links each item to its source.

## Runs on your infrastructure

TeamReel is a command-line tool and a GitHub Action. It runs where you run it, with your own API keys. Your code, tickets and messages go to GitHub, Jira, Slack and the AI provider you choose, and nowhere else. There's no TeamReel server.

A reel costs a few cents in API calls.

## Set up (10 minutes)

**1. Describe your teams** in `teamreel.json`:

```json
{
  "company": "Northwind",
  "post_to": "#company-updates",
  "teams": [
    { "name": "Payments", "about": "9 people", "jira": { "projects": ["PAY"] }, "slack": ["#payments"], "github": ["northwind/payments-api"] },
    { "name": "Sales", "about": "14 people", "slack": ["#sales-wins", "#sales"] },
    { "name": "Product", "github": ["northwind/web", "northwind/ios"] }
  ]
}
```

Any team can use any mix of sources. Sales and marketing usually live in Slack, engineering in GitHub and Jira.

**2. Create a Slack app** with the bot scopes `channels:history`, `channels:read`, `users:read`, `files:read` and `files:write`, install it, and invite it to the channels it reads and the one it posts in.

**3. Add your keys:**

| | |
|---|---|
| `SLACK_BOT_TOKEN` | the Slack app's bot token |
| `GITHUB_TOKEN` | read access to the repos in your config |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | if you use Jira Cloud |
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` or `GEMINI_API_KEY` | the editor |
| `GEMINI_API_KEY` | optional, generates the music |

**4. Run it every Friday.** Copy [`examples/weekly.yml`](examples/weekly.yml) into `.github/workflows/`, or run it yourself:

```bash
npx playwright install chromium     # once
npx teamreel --config teamreel.json --post
```

## Review before it posts

```bash
teamreel --config teamreel.json --dry          # collect + edit; writes story.json
$EDITOR teamreel-out/story.json                # change a headline, cut a scene
teamreel --story teamreel-out/story.json --post
```

`--stills` writes one frame per scene for a quick look. `--vertical` renders 1080×1920 for phones.

## Options

| Flag | |
|---|---|
| `--config teamreel.json` | teams and their sources |
| `--since 7d` | the window: `7d`, `2w`, or a date |
| `--post` | post to `post_to` when done |
| `--dry` | stop after writing `story.json` |
| `--story story.json` | render an edited story |
| `--llm auto` | `anthropic`, `openai`, `gemini`, or `none` |
| `--music file.mp3`, `--no-music` | your own track, or none |
| `--vertical`, `--stills`, `--no-captions` | |
| `--fixtures dir` | read sources from JSON files (for trying it without accounts) |

Try it with no accounts at all:

```bash
npx teamreel --config examples/teamreel.example.json --fixtures examples/fixtures --llm none
```

## Requirements

Node 20+, ffmpeg, and Chromium from Playwright (or any Chrome via `TEAMREEL_CHROME`).

## License

MIT
