# Enhanced Model Integration

This module provides a flexible way to integrate different LLM providers into the report generation system.

## Key Features

- Support for both local Ollama models and cloud-based Anthropic Claude models
- Consistent interface for all model providers
- Environment variable configuration
- Graceful fallbacks if dependencies are missing

## Usage

### Basic Usage

```python
from llm_factory_constructor import get_model_provider

# Get default provider (checks environment variables)
provider = get_model_provider()

# Get response from model
response = provider.get_response(
    system_message="You are a helpful assistant.",
    user_message="What is the meaning of life?"
)
```

### Specifying Provider and Model

```python
# Use Ollama
provider = get_model_provider("ollama", "llama3.1:8b")

# Use Anthropic
provider = get_model_provider("anthropic", "claude-sonnet-5")
```

### Environment Variables

Configure the model provider using environment variables:

```bash
# Select provider
export LLM_PROVIDER=ollama  # or "anthropic"

# Ollama configuration
export OLLAMA_MODEL=llama3
export OLLAMA_ENDPOINT=http://localhost:11434

# Anthropic configuration
export ANTHROPIC_MODEL=claude-sonnet-5
export ANTHROPIC_API_KEY=your_api_key_here
```

## Implementation Details

The system consists of:

1. A base `ModelProvider` class that defines the interface
2. Provider-specific implementations:
   - `OllamaProvider` for local models via Ollama
   - `AnthropicProvider` for Claude models via Anthropic API
3. A factory function `get_model_provider()` to create the appropriate provider

Each provider handles:

- Model selection
- API communication
- Error handling
- Listing available models

## Dependencies

- For Ollama: `ollama` package (optional, falls back to direct HTTP requests)
- For Anthropic: `anthropic` package (optional, falls back to direct HTTP requests)

## Example Integration

```python
from llm_factory_constructor import get_model_provider

# Configuration
provider_type = "anthropic" if use_anthropic else "ollama"
model_name = args.model  # Command line argument

# Get provider
provider = get_model_provider(provider_type, model_name)

# Use in report generation
model_response = provider.get_response(
    system_message=system_lore,
    user_message=prompt_xml
)
```
