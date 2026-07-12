# Harbor benchmark

The adapter runs this repository as a Harbor installed agent against official datasets such as Terminal-Bench 2.0.

```powershell
# LONGCAT_API_KEY must already contain the real API credential.
harbor run -d terminal-bench@2.0 -a benchmarks.harbor_pi_goal:PiGoalAgent `
  -m longcat/LongCat-2.0 -l 1 -n 1 -k 1 --thinking high
```

The API key is passed to the trial environment without being written to this repository or Harbor job configuration.

## Verified smoke result

On 2026-07-12, the adapter completed the official Terminal-Bench 2.0 easy task `terminal-bench/fix-git`:

| Agent | Model | Task | Reward | Exceptions | Agent time |
|---|---|---|---:|---:|---:|
| Pi Goal Runtime 0.2.0 | LongCat-2.0 | `terminal-bench/fix-git` | 1.0 | 0 | 96 seconds |

The raw Harbor job is intentionally excluded from Git because it contains rollout logs. It is stored locally under `benchmark-results/pi-goal-fix-git/`.

Reproduce that exact task with:

```powershell
$env:PYTHONPATH = (Get-Location).Path
harbor run -d terminal-bench/terminal-bench-2 `
  -a benchmarks.harbor_pi_goal:PiGoalAgent `
  -m longcat/LongCat-2.0 `
  -i terminal-bench/fix-git -n 1 -k 1 `
  --ak thinking=high --jobs-dir benchmark-results -y
Remove-Item Env:\PYTHONPATH
```

Upload a completed job to Harbor Hub with `harbor upload benchmark-results/<job-name>`. Review rollout logs before uploading.
