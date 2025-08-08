# Docker Configuration for Delphi

## Docker Compose Setup

As of April 2025, the Delphi system no longer uses a separate docker-compose.yml file.
Instead, it's fully integrated with the main project docker-compose.yml in the root directory.

To run Delphi:

```bash
# From the project root directory
cd /Users/colinmegill/polis/
docker-compose up -d
```

## Ollama Model Configuration

Delphi uses Ollama for LLM processing. The model can be configured using environment variables:

```bash
# To use a specific Ollama model
OLLAMA_MODEL=gemma:7b docker-compose up -d
```

See the [Ollama Model Configuration](./docs/OLLAMA_MODEL_CONFIG.md) documentation for more details.

## Development Mode

For development:

1. Ensure the Docker containers are running
2. Make changes to the Delphi Python code
3. Use `docker-compose build delphi` to rebuild the container
4. Run `docker-compose up -d delphi` to restart the service

For more detailed information on Delphi development and deployment, see the [README.md](./README.md) file.