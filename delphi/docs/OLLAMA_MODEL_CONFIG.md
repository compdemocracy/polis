# Ollama Model Configuration

This document describes how to configure Ollama models in the Delphi system.

## Overview

The Delphi system uses Ollama to run local LLMs for generating narratives and analyzing data. The system is designed to automatically install and use the specified Ollama model without requiring manual intervention.

## Configuration

### Environment Variables

The following environment variables control the Ollama configuration:

| Variable | Description | Default Value | Examples |
| --- | --- | --- | --- |
| `LLM_PROVIDER` | Which LLM provider to use | `ollama` | `ollama`, `anthropic` |
| `OLLAMA_MODEL` | The Ollama model to use | `llama3.1:8b` | `llama3`, `gemma:7b`, `mistral:7b`, `llama3.1:8b`, `mixtral` |
| `OLLAMA_HOST` | The Ollama API endpoint | `http://ollama:11434` | `http://localhost:11434` (for local dev) |

### Setting Up

1. Create a `.env` file in the Delphi directory (you can copy from `example.env`)
2. Set the desired Ollama model:
   ```
   LLM_PROVIDER=ollama
   OLLAMA_MODEL=gemma:7b
   ```

3. When running with Docker Compose, you can also set environment variables directly:
   ```bash
   OLLAMA_MODEL=gemma:7b docker-compose up -d
   ```

### Automatic Model Installation

When the Delphi container starts, it automatically:

1. Checks if the Ollama service is available
2. Pulls the specified model if needed
3. Configures the system to use that model

If the model pulling fails, the system will still attempt to use the model, which may work if the model is already downloaded in the Ollama container.

## Available Models

Common Ollama models that work well with Delphi:

- `llama3.1:8b` (default) - Meta's Llama 3.1 8B model, good balance of speed and quality
- `gemma:7b` - Google's Gemma 7B model
- `mistral:7b` - Mistral 7B model
- `mistral:latest` - Latest Mistral model
- `mixtral` - Mixtral 8x7B MoE model (larger but more capable)
- `nous-hermes2` - Nous Hermes 2 13B (based on Llama 2)

See the [Ollama model library](https://ollama.com/library) for more available models.

## Troubleshooting

If you encounter issues with the Ollama model:

1. Check if the model is available in the Ollama container:
   ```bash
   docker exec -it delphi-ollama ollama list
   ```

2. Try pulling the model manually:
   ```bash
   docker exec -it delphi-ollama ollama pull gemma:7b
   ```

3. Check the Delphi container logs for any model-related errors:
   ```bash
   docker logs polis-dev-delphi-1
   ```

4. Make sure the Ollama service is running and accessible:
   ```bash
   curl http://localhost:11434/api/tags
   ```

## Performance Considerations

Smaller models (7-8B parameters) will run faster but may produce lower quality outputs. Larger models (>13B parameters) will provide better quality but require more memory and may run slower.

For production use, consider using a container with GPU support to accelerate model inference.