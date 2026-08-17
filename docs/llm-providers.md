# Console LLM providers

Catence Console talks to a model through [LiteLLM](https://docs.litellm.ai/).
There are exactly three provider shapes: **OpenAI**, **Anthropic**, and a
generic **OpenAI-compatible** profile. Azure is not a special case in the code:
it is reached through the OpenAI-compatible profile. OpenCode Go can be reached
the same way through a local gateway, or directly at its own OpenAI-compatible
endpoint with native `openai/…` and `anthropic/…` model names; the steps for
each are documented below.

## How configuration is split

Catence never stores a credential value in `config.json`. A Console profile
records only a LiteLLM model name and the *names* of the environment variables
that hold the key, base URL, and (optionally) API version. The values
themselves stay in the Console process environment.

```jsonc
// ~/.catence/config.json (or /data/config.json inside the Docker image)
{
  "console": {
    "defaultProfile": "openai",
    "profiles": {
      "openai": {
        "label": "OpenAI",
        "model": "openai/gpt-5-mini",
        "apiKeyEnv": "OPENAI_API_KEY"
      },
      "anthropic": {
        "label": "Anthropic",
        "model": "anthropic/claude-sonnet-4-5",
        "apiKeyEnv": "ANTHROPIC_API_KEY"
      },
      "openai-compatible": {
        "label": "OpenAI-compatible",
        "model": "openai/your-model-name",
        "apiKeyEnv": "OPENAI_API_KEY",
        "apiBaseEnv": "OPENAI_API_BASE"
      }
    }
  }
}
```

The supported profile fields are `label`, `model` (or `models` + `defaultModel`
for multiple deployments), `defaultReasoningEffort`, `apiKeyEnv`, `apiBaseEnv`,
and `apiVersionEnv`. Every `*Env` value must be an uppercase environment
variable name; a raw secret there is rejected.

| Profile field | Environment variable it reads |
| --- | --- |
| `apiKeyEnv` | API key |
| `apiBaseEnv` | Base URL (OpenAI-compatible endpoints) |
| `apiVersionEnv` | Optional API version, only for endpoints that require one |

## OpenAI

Point the profile at the public OpenAI API. Only a key is required.

```sh
export OPENAI_API_KEY='sk-…'
```

```jsonc
{
  "console": {
    "defaultProfile": "openai",
    "profiles": {
      "openai": {
        "label": "OpenAI",
        "model": "openai/gpt-5-mini",
        "apiKeyEnv": "OPENAI_API_KEY"
      }
    }
  }
}
```

## Anthropic

Only a key is required.

```sh
export ANTHROPIC_API_KEY='sk-ant-…'
```

```jsonc
{
  "console": {
    "defaultProfile": "anthropic",
    "profiles": {
      "anthropic": {
        "label": "Anthropic",
        "model": "anthropic/claude-sonnet-4-5",
        "apiKeyEnv": "ANTHROPIC_API_KEY"
      }
    }
  }
}
```

## OpenAI-compatible

Use this one profile for any endpoint that speaks the OpenAI Chat Completions
API: Azure, Opencode, Ollama, LM Studio, a LiteLLM proxy, and so on. Set the
key and the base URL; the model name is whatever the endpoint expects.

```sh
export OPENAI_API_KEY='…'
export OPENAI_API_BASE='https://host.example/v1'
```

```jsonc
{
  "console": {
    "defaultProfile": "openai-compatible",
    "profiles": {
      "openai-compatible": {
        "label": "OpenAI-compatible",
        "model": "openai/your-model-name",
        "apiKeyEnv": "OPENAI_API_KEY",
        "apiBaseEnv": "OPENAI_API_BASE"
      }
    }
  }
}
```

LiteLLM appends `/chat/completions` to `OPENAI_API_BASE`, so point it at the
`…/v1` root of the endpoint, not the full completions path.

### Azure

Azure OpenAI's unified v1 API is OpenAI-compatible, so it uses the same
`openai-compatible` profile. Use the **Azure deployment name** as the model.

```sh
export OPENAI_API_KEY='your-azure-openai-api-key'
export OPENAI_API_BASE='https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1/'
```

```jsonc
{
  "console": {
    "defaultProfile": "openai-compatible",
    "profiles": {
      "openai-compatible": {
        "label": "Azure OpenAI",
        "model": "openai/gpt-4.1-nano",   // your deployment name
        "apiKeyEnv": "OPENAI_API_KEY",
        "apiBaseEnv": "OPENAI_API_BASE"
      }
    }
  }
}
```

Notes:

- `OPENAI_API_BASE` also accepts the Foundry models form
  `https://YOUR-RESOURCE-NAME.services.ai.azure.com/openai/v1/`.
- With the v1 API the `api-version` query parameter is no longer required, so
  `apiVersionEnv` stays unset. If an older endpoint still needs one, add
  `"apiVersionEnv": "OPENAI_API_VERSION"` and export
  `OPENAI_API_VERSION='2024-06-01'` (or your API version).
- `OPENAI_API_KEY` holds the Azure OpenAI API key. If you use Microsoft Entra
  ID instead, a keyless token provider can be passed in the same variable.

### Opencode

[OpenCode Go](https://opencode.ai) publishes an OpenAI-compatible API at
`https://opencode.ai/zen/go/v1`; its `GET /v1/models` listing is public and does
not require a key. The Console can use it directly, so most setups do not need a
local gateway.

The repository includes a discovery script that fetches the live model list and
merges ready-made Console profiles into `config.json`. From a Catence checkout:

```sh
npm run discover:opencode-go -- --write ~/.catence/config.json
```

The script adds two profiles, because OpenCode Go routes model families through
different API shapes:

- `opencode-go` — chat and responses models, base
  `https://opencode.ai/zen/go/v1` (LiteLLM `openai/…` names).
- `opencode-go-messages` — messages models, base `https://opencode.ai/zen/go`
  (LiteLLM `anthropic/…` names).

| Family | Profile prefix | Example |
| --- | --- | --- |
| Chat | `openai/<id>` | `openai/deepseek-v4-flash` |
| Responses | `openai/responses/<id>` | `openai/responses/grok-4.5` |
| Messages | `anthropic/<id>` | `anthropic/minimax-m2.5` |

The script warns on stderr and skips any model that does not fit one of these
families. Rerun it to refresh the model lists; existing profiles, limits, and
`defaultProfile` are preserved unless `--set-default` is passed.

```sh
export OPENCODE_GO_API_KEY='…'                      # any non-empty value satisfies the key check
export OPENCODE_GO_API_BASE='https://opencode.ai/zen/go/v1'
export OPENCODE_GO_MESSAGES_API_BASE='https://opencode.ai/zen/go'
```

```jsonc
{
  "console": {
    "defaultProfile": "opencode-go",
    "profiles": {
      "opencode-go": {
        "label": "OpenCode Go",
        "defaultModel": "flash",
        "models": {
          "flash": { "label": "DeepSeek V4 flash", "model": "openai/deepseek-v4-flash" },
          "grok": { "label": "Grok 4.5", "model": "openai/responses/grok-4.5" }
        },
        "apiKeyEnv": "OPENCODE_GO_API_KEY",
        "apiBaseEnv": "OPENCODE_GO_API_BASE"
      },
      "opencode-go-messages": {
        "label": "OpenCode Go messages",
        "defaultModel": "minimax",
        "models": {
          "minimax": { "label": "MiniMax M2.5", "model": "anthropic/minimax-m2.5" }
        },
        "apiKeyEnv": "OPENCODE_GO_API_KEY",
        "apiBaseEnv": "OPENCODE_GO_MESSAGES_API_BASE"
      }
    }
  }
}
```

Verify with `catence-console doctor`. The `responses` models
(`openai/responses/…`) go through LiteLLM's responses bridge and are the least
battle-tested path; smoke-test one chat turn before relying on them.

If you instead want to reuse the providers already configured in your local
Opencode CLI, run an OpenAI-compatible gateway such as the
[`opencode-llm-proxy`](https://github.com/KochC/opencode-llm-proxy) plugin, which
serves Chat Completions at `http://127.0.0.1:4010/v1` and lists every configured
model as `provider/model`.

```sh
export OPENAI_API_KEY='unused'           # or your OPENCODE_LLM_PROXY_TOKEN
export OPENAI_API_BASE='http://127.0.0.1:4010/v1'
```

```jsonc
{
  "console": {
    "defaultProfile": "openai-compatible",
    "profiles": {
      "openai-compatible": {
        "label": "Opencode",
        "model": "openai/github-copilot/claude-sonnet-4.6",  // provider/model
        "apiKeyEnv": "OPENAI_API_KEY",
        "apiBaseEnv": "OPENAI_API_BASE"
      }
    }
  }
}
```

Notes:

- Use the fully qualified `provider/model` id from the gateway's
  `GET /v1/models` listing.
- If the gateway requires a bearer token, set `OPENAI_API_KEY` to the
  `OPENCODE_LLM_PROXY_TOKEN`; otherwise any non-empty value satisfies the
  profile's required-environment check.

## Multiple deployments per provider

A profile can list several models under one set of credentials; the Console
settings then offer a per-deployment choice.

```jsonc
{
  "console": {
    "profiles": {
      "openai-compatible": {
        "label": "Azure OpenAI",
        "defaultModel": "nano",
        "models": {
          "nano": { "label": "GPT-4.1 nano", "model": "openai/gpt-4.1-nano" },
          "mini": { "label": "GPT-5 mini", "model": "openai/gpt-5-mini" }
        },
        "apiKeyEnv": "OPENAI_API_KEY",
        "apiBaseEnv": "OPENAI_API_BASE"
      }
    }
  }
}
```

## Verifying a profile

`catence-console doctor` reports, for each profile, which environment variables
are still missing and whether the local Catence runtime is reachable. It never
prints credential values.

```sh
catence-console doctor --home "$HOME/.catence" --mcp-url http://127.0.0.1:8787/mcp
```

On Docker, the deploy scaffold includes a helper that runs it inside the
running container (`exec`, not `run` — the container's loopback hosts the live
MCP server and the `.env` provider keys are in its environment):

```sh
./catence-deploy/doctor.sh
```

## Docker: generating the Console login hash

`deploy-console.sh` writes a small helper into the deployment directory. Run it
once after the script to generate the bcrypt hash for
`CATENCE_CONSOLE_PASSWORD_HASH` — it prompts for the password on the terminal,
never echoes it, and uses the compose project so it works no matter what image
tag the script built:

```sh
./catence-deploy/hash-password.sh
```

Paste the output into `CATENCE_CONSOLE_PASSWORD_HASH` in `catence-deploy/.env`,
then start the stack (`./deploy-console.sh beta` again, or
`docker compose -f catence-deploy/docker-compose.yml --env-file catence-deploy/.env up -d`).

If you prefer, re-run the deploy script with `--generate-secrets` instead and
answer the interactive password prompt; it saves the hash to `.env` for you.
Without the helper (for example an older deployment), the equivalent command
is `docker run --rm -it --entrypoint /opt/catence-console/bin/catence-console
<image-tag> auth hash-password`, where `<image-tag>` is the tag printed by the
script.
