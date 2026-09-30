# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report privately through GitHub Security Advisories:

**https://github.com/Nikire/cvparse/security/advisories/new**

Include what you found, how to reproduce it, the cvparse version, and, if relevant, the provider and model you were using. You will get an acknowledgement within a few days. If the report is confirmed, a fix will be released and you will be credited in the advisory and the changelog unless you prefer otherwise.

## Supported versions

While the project is pre-1.0, only the latest published minor version receives security fixes.

| Version | Supported |
| --- | --- |
| latest 0.x | yes |
| older 0.x | no |

## What cvparse does with your data

A CV is personal data (PII) in essentially every jurisdiction: name, contact details, employment history, education, sometimes nationality, date of birth or a photo. Treat every input to this library accordingly.

cvparse's data handling is deliberately simple:

- **The only network call cvparse makes is to the model provider you configure.** The resume text is sent, together with the extraction prompt and schema, to whatever `LanguageModel` you pass to `parseResume` or whatever `--provider` / `--base-url` you give the CLI. Nothing else is contacted. There is no telemetry, no analytics, no update check, no crash reporting.
- **With Ollama (the CLI default) the data stays on your machine.** `http://localhost:11434/v1` is a local endpoint; nothing leaves the host unless you point `--base-url` elsewhere.
- **With a hosted provider (OpenAI or any `openai-compatible` endpoint) the data goes to that provider**, under that provider's terms, retention policy and jurisdiction. That is your decision and your responsibility as the data controller. Check whether the provider trains on API inputs and whether you need a data processing agreement before sending candidates' CVs there.
- **cvparse does not persist anything.** It does not write cache files, logs or temporary copies of the input or the output. The CLI writes the result to stdout and nothing else.
- **API keys** are read from the `--api-key` flag, the `CVPARSE_API_KEY` environment variable (any provider) or the `OPENAI_API_KEY` environment variable (only when `--provider openai`), and are only used in the `Authorization` header of requests to the configured base URL. `OPENAI_API_KEY` is never sent to Ollama or to an `openai-compatible` endpoint, so an exported OpenAI key cannot leak to a third-party host by accident. Prefer the environment variables over the flag so the key does not end up in your shell history.

If you find behaviour that contradicts any of the points above, that is a security issue: please report it.

## Scope notes

- **Prompt injection.** A CV is untrusted input handed to an LLM. A malicious document could contain text that tries to steer the model. cvparse constrains the output to a Zod schema, which limits the blast radius to wrong field values, but it cannot guarantee the model ignores such instructions. Do not feed cvparse output into anything that takes actions without validation.
- **Model output is not trusted.** Validate the parsed `Resume` before using it for decisions about a person. The schema guarantees shape, not truth.
- **Dependencies.** cvparse has three runtime dependencies (`ai`, `zod`, `@ai-sdk/openai-compatible`). Vulnerabilities in those should be reported upstream; if they affect cvparse in a specific way, report here as well.
