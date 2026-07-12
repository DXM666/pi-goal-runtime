import json
import os
import shlex
from pathlib import Path
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, CliFlag, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class PiGoalAgent(BaseInstalledAgent):
    """Harbor installed-agent adapter for Pi plus this goal extension."""

    _OUTPUT_FILENAME = "pi-goal.jsonl"

    CLI_FLAGS = [
        CliFlag(
            "thinking",
            cli="--thinking",
            type="enum",
            choices=["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        ),
    ]

    @staticmethod
    @override
    def name() -> str:
        return "pi-goal-runtime"

    @override
    def get_version_command(self) -> str | None:
        return ". ~/.nvm/nvm.sh; pi --version"

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        repo = Path(__file__).resolve().parents[1]
        await environment.upload_dir(repo, "/opt/pi-goal-runtime")
        await self.exec_as_root(
            environment,
            command="apt-get update && apt-get install -y curl",
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                "npm install -g --ignore-scripts @earendil-works/pi-coding-agent && "
                "cd /opt/pi-goal-runtime && npm ci && "
                "pi install /opt/pi-goal-runtime --approve && "
                "pi --version"
            ),
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must use provider/model format")
        provider, model = self.model_name.split("/", 1)
        if provider != "longcat":
            raise ValueError("This local adapter currently supports longcat/LongCat-2.0")

        api_key = os.environ.get("LONGCAT_API_KEY")
        if not api_key:
            raise ValueError("LONGCAT_API_KEY is not set in the Harbor host process")

        config_script = shlex.quote(
            "const fs=require('fs');fs.mkdirSync(process.env.HOME+'/.pi/agent',{recursive:true});"
            "fs.writeFileSync(process.env.HOME+'/.pi/agent/models.json',JSON.stringify({providers:{longcat:{"
            "baseUrl:'https://api.longcat.chat/openai',api:'openai-completions',apiKey:process.env.LONGCAT_API_KEY,"
            "models:[{id:" + json.dumps(model) + ",name:" + json.dumps(model) + "}]}}},null,2))"
        )
        await self.exec_as_agent(
            environment,
            command=f". ~/.nvm/nvm.sh; node -e {config_script}",
            env={"LONGCAT_API_KEY": api_key},
        )

        condition = (
            f"Complete the benchmark task below. Work in the current directory, perform the actual changes, "
            f"and verify them as far as the environment permits. Do not stop at a plan.\n\n{instruction}"
        )
        flags = self.build_cli_flags()
        flag_text = f"{flags} " if flags else ""
        command = (
            ". ~/.nvm/nvm.sh; "
            "pi --print --mode json --no-session "
            f"--provider longcat --model {shlex.quote(model)} {flag_text}"
            f"--goal-condition {shlex.quote(condition)} --goal-max-turns 12 --goal-max-minutes 60 "
            f"{shlex.quote(instruction)} "
            f"2>&1 </dev/null | grep -v '\"type\":\"message_update\"' | "
            f"stdbuf -oL tee /logs/agent/{self._OUTPUT_FILENAME}"
        )
        await self.exec_as_agent(
            environment,
            command=command,
            env={"LONGCAT_API_KEY": api_key},
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        output_file = self.logs_dir / self._OUTPUT_FILENAME
        if not output_file.exists():
            return
        input_tokens = output_tokens = cache_tokens = 0
        total_cost = 0.0
        for line in output_file.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") != "message_end":
                continue
            message = event.get("message") or {}
            if message.get("role") != "assistant":
                continue
            usage = message.get("usage") or {}
            input_tokens += usage.get("input", 0)
            output_tokens += usage.get("output", 0)
            cache_tokens += usage.get("cacheRead", 0)
            total_cost += (usage.get("cost") or {}).get("total", 0.0)
        context.n_input_tokens = input_tokens + cache_tokens
        context.n_output_tokens = output_tokens
        context.n_cache_tokens = cache_tokens
        context.cost_usd = total_cost or None
