# TeamReel

A week of merged pull requests, turned into a one-minute video your team will actually watch.

teamreel reads what your team merged, picks the change that mattered most, and renders a short narrated video: the headline, the week in numbers, the big change and who built it, what else shipped, and shout-outs. Post it to Slack on Friday afternoon instead of another "here's the scoop" thread.

- **Runs on your infrastructure.** A CLI and a GitHub Action. Your code and tickets never touch a server we run, because there isn't one.
- **Bring your own key.** Claude, OpenAI or Gemini writes the script; Gemini or OpenAI reads it aloud. A video costs a few cents. No key at all still works: you get a plain script and captions.
- **It can't make things up.** Every number on screen is counted from GitHub, every PR and person the script names is checked against the data, and any narration that states a number we didn't count is thrown out.

## Quick start

```bash
npx playwright install chromium            # once
export ANTHROPIC_API_KEY=...               # or OPENAI_API_KEY / GEMINI_API_KEY
export GEMINI_API_KEY=...                  # optional, for the voice-over (or OPENAI_API_KEY)
npx teamreel --repo your-org/api --repo your-org/web --team "Platform"
open teamreel-out/teamreel.mp4
```

GitHub access comes from `GITHUB_TOKEN`, or from `gh auth login` if you have the GitHub CLI.

## Every Friday, in Slack

Copy [`examples/weekly.yml`](examples/weekly.yml) to `.github/workflows/teamreel.yml`, add your keys as repository secrets, and set `slack-channel` to a channel ID. The Slack app needs the `files:write` scope and has to be invited to the channel.

To cover several repos, pass `repos: "acme/api acme/web"` or `org: acme`, and give the workflow a token that can read them (`GITHUB_TOKEN: ${{ secrets.TEAMREEL_GH_TOKEN }}` in `env`).

## Edit before you post

```bash
teamreel --repo acme/api --dry              # collect + write the script only
$EDITOR teamreel-out/story.json             # fix a title, cut a scene, change a line
teamreel --story teamreel-out/story.json    # render exactly that
teamreel --story teamreel-out/story.json --stills   # one frame per scene, for a quick look
```

## Options

| Flag | Default | |
|---|---|---|
| `--repo owner/name` | | repeat for several repos |
| `--org name` | | every repo in an org |
| `--since` | `7d` | `7d`, `2w`, or a date |
| `--team` | repo names | shown in the video |
| `--llm` | auto | `anthropic`, `openai`, `gemini`, `none` |
| `--voice` | auto | `gemini`, `openai`, `none` |
| `--vertical` | off | 1080×1920 for phones |
| `--accent` | `#ff7a45` | accent colour |
| `--music file.mp3` | none | a music bed you supply |
| `--no-captions`, `--no-mark` | | hide captions / the end credit |
| `--slack CHANNEL_ID` | | post when done (`SLACK_BOT_TOKEN`) |

Model and voice can be set with `TEAMREEL_MODEL`, `TEAMREEL_VOICE` and `TEAMREEL_TTS_MODEL`.

## How it works

1. **Collect.** One GitHub GraphQL search for merged PRs and closed issues in the window. Bots are dropped. Avatars are inlined so rendering needs no network.
2. **Write.** The model gets titles, sizes, labels and the first part of each PR description, and returns a script with one main story. Code checks every pick against the data.
3. **Voice.** Each scene's line is read separately and trimmed, and scene lengths follow the voice.
4. **Render.** An HTML template is stepped frame by frame in headless Chromium and piped to ffmpeg, so the output is identical every run. About two minutes for a one-minute video on a laptop.

## Requirements

Node 20+, ffmpeg on the PATH, and Chromium from Playwright (or set `TEAMREEL_CHROME` to any Chrome).

## License

MIT
