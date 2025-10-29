#!/usr/bin/env python3
"""
Model provider module for report generation.

Provides a consistent interface for different LLM backends (Ollama and Anthropic)
allowing for easy configuration and switching between model providers.
"""

import json
import logging
import os
from typing import Any

import ollama
import requests

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


class ModelProvider:
    """Base class for model providers."""

    def get_response(self, system_message: str, user_message: str) -> str:
        """
        Get a response from the model.

        Args:
            system_message: System message/instructions
            user_message: User message/prompt

        Returns:
            Model response as string
        """
        raise NotImplementedError("Subclasses must implement get_response")

    def list_available_models(self) -> list[str]:
        """
        List available models from this provider.

        Returns:
            List of available model identifiers
        """
        raise NotImplementedError("Subclasses must implement list_available_models")


class OllamaProvider(ModelProvider):
    """Provider for Ollama models."""

    def __init__(self, model_name: str = "llama3", endpoint: str = "http://localhost:11434"):
        """
        Initialize the Ollama provider.

        Args:
            model_name: Name of the model to use
            endpoint: Ollama API endpoint
        """
        self.model_name = model_name
        self.endpoint = endpoint

        # Import ollama here to allow for optional dependency
        try:
            self.ollama = ollama
            # Configure endpoint if specified
            if endpoint != "http://localhost:11434":
                self.ollama.client.api_base = endpoint
        except ImportError:
            logger.warning("Ollama package not installed. Using direct HTTP requests instead.")
            self.ollama = None

    def get_response(self, system_message: str, user_message: str) -> str:
        """
        Get a response from an Ollama model.

        Args:
            system_message: System message/instructions
            user_message: User message/prompt

        Returns:
            Model response as string
        """
        try:
            logger.info(f"Using Ollama model: {self.model_name}")

            if self.ollama:
                # Use the Ollama package if available
                response = self.ollama.chat(
                    model=self.model_name,
                    messages=[{"role": "system", "content": system_message}, {"role": "user", "content": user_message}],
                )
                result = response["message"]["content"].strip()
            else:
                # Use direct HTTP request as fallback
                response = requests.post(
                    f"{self.endpoint}/api/chat",
                    json={
                        "model": self.model_name,
                        "messages": [
                            {"role": "system", "content": system_message},
                            {"role": "user", "content": user_message},
                        ],
                        "stream": False,
                    },
                )
                response.raise_for_status()
                result = response.json()["message"]["content"].strip()

            return result

        except Exception as e:
            logger.error(f"Error using Ollama: {str(e)}")
            # Return a JSON error response
            return json.dumps(
                {
                    "id": "polis_narrative_error_message",
                    "title": "Model Error",
                    "paragraphs": [
                        {
                            "id": "polis_narrative_error_message",
                            "title": "Error Processing With Model",
                            "sentences": [
                                {
                                    "clauses": [
                                        {
                                            "text": f"There was an error using the Ollama model: {str(e)}",
                                            "citations": [],
                                        }
                                    ]
                                }
                            ],
                        }
                    ],
                }
            )

    def list_available_models(self) -> list[str]:
        """
        List available Ollama models.

        Returns:
            List of available model identifiers
        """
        try:
            if self.ollama:
                # Use the Ollama package if available
                models_response = self.ollama.list()
                # Handle new Ollama API response format which has a 'models' list of Model objects
                if hasattr(models_response, "models") and isinstance(models_response.models, list):
                    available_models = [m.model for m in models_response.models]
                else:
                    # Fallback for older API versions or different response format
                    available_models = [model.get("name") for model in models_response.get("models", [])]
            else:
                # Use direct HTTP request as fallback
                response = requests.get(f"{self.endpoint}/api/tags")
                response.raise_for_status()
                available_models = [model.get("name") for model in response.json().get("models", [])]

            logger.info(f"Available Ollama models: {available_models}")
            return available_models

        except Exception as e:
            logger.error(f"Error listing Ollama models: {str(e)}")
            return []


class AnthropicProvider(ModelProvider):
    """Provider for Anthropic Claude models."""

    def __init__(self, model_name: str = None, api_key: str | None = None):
        """
        Initialize the Anthropic provider.

        Args:
            model_name: Name of the Claude model to use
            api_key: Anthropic API key (defaults to ANTHROPIC_API_KEY env var)
        """
        self.model_name = model_name
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")

        if not self.api_key:
            logger.warning("No Anthropic API key provided. Set ANTHROPIC_API_KEY env var or pass api_key parameter.")

        # Force using direct HTTP requests instead of the anthropic package
        # since we're having issues with the package in the container
        logger.warning("Forcing use of direct HTTP requests for Anthropic API")
        self.anthropic = None
        self.client = None

        # Log API key presence (without revealing it)
        if self.api_key:
            logger.info(f"Anthropic API key is set (starts with: {self.api_key[:8]}...)")
        else:
            logger.warning("No Anthropic API key found in environment")

    def get_response(self, system_message: str, user_message: str) -> str:
        """
        Get a response from a Claude model.

        Args:
            system_message: System message/instructions
            user_message: User message/prompt

        Returns:
            Model response as string
        """
        if not self.api_key:
            return json.dumps(
                {
                    "id": "polis_narrative_error_message",
                    "title": "API Key Missing",
                    "paragraphs": [
                        {
                            "id": "polis_narrative_error_message",
                            "title": "API Key Missing",
                            "sentences": [
                                {
                                    "clauses": [
                                        {
                                            "text": "No Anthropic API key provided. Set ANTHROPIC_API_KEY env var or pass api_key parameter.",
                                            "citations": [],
                                        }
                                    ]
                                }
                            ],
                        }
                    ],
                }
            )

        try:
            logger.info(f"Using Anthropic model: {self.model_name}")

            if self.client:
                # Use the Anthropic package if available
                message = self.client.messages.create(
                    model=self.model_name,
                    system=system_message,
                    messages=[{"role": "user", "content": user_message}],
                    max_tokens=4000,
                )
                result = message.content[0].text
            else:
                # Use direct HTTP request
                headers = {
                    "x-api-key": self.api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                }

                # Add more debugging
                logger.info(f"Using Anthropic model '{self.model_name}' via direct HTTP request")
                logger.info(f"API key starts with: {self.api_key[:8]}...")

                data = {
                    "model": self.model_name,
                    "system": system_message,
                    "messages": [{"role": "user", "content": user_message}],
                    "max_tokens": 4000,
                }

                response = requests.post("https://api.anthropic.com/v1/messages", headers=headers, json=data)
                response.raise_for_status()
                result = response.json()["content"][0]["text"]

            return result

        except Exception as e:
            logger.error(f"Error using Anthropic API: {str(e)}")
            # Return a JSON error response
            return json.dumps(
                {
                    "id": "polis_narrative_error_message",
                    "title": "Model Error",
                    "paragraphs": [
                        {
                            "id": "polis_narrative_error_message",
                            "title": "Error Processing With Model",
                            "sentences": [
                                {
                                    "clauses": [
                                        {
                                            "text": f"There was an error using the Anthropic API: {str(e)}",
                                            "citations": [],
                                        }
                                    ]
                                }
                            ],
                        }
                    ],
                }
            )

    def get_batch_responses(self, batch_requests: list[dict[str, Any]]) -> dict[str, Any]:  # noqa: PLR0911
        """
        Submit a batch of requests to the Anthropic Batch API.

        Args:
            batch_requests: List of request objects, each containing:
                - system: System message
                - messages: List of message objects
                - max_tokens: Maximum tokens for response
                - metadata: Dictionary with request metadata

        Returns:
            Dictionary with batch job metadata
        """
        if not self.api_key:
            logger.error("No Anthropic API key provided for batch requests")
            return {"error": "API key missing"}

        try:
            logger.info(f"Submitting batch of {len(batch_requests)} requests to Anthropic API")

            # Use Anthropic Batch API endpoint
            headers = {"x-api-key": self.api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"}

            # Format requests for Batch API
            formatted_requests = []
            for i, request in enumerate(batch_requests):
                req = {
                    "model": self.model_name,
                    "system": request.get("system", ""),
                    "messages": request.get("messages", []),
                    "max_tokens": request.get("max_tokens", 4000),
                }

                # Add request ID (for correlation on response)
                req["request_id"] = f"req_{i}"

                formatted_requests.append(req)

            # Check if Batch API is available
            try:
                # Make a request to the Batch API endpoint
                batch_request_data = {"requests": formatted_requests}

                response = requests.post(
                    "https://api.anthropic.com/v1/messages/batch", headers=headers, json=batch_request_data
                )

                # Check if the response indicates Batch API is not available
                if response.status_code == 404:
                    logger.warning(
                        "Anthropic Batch API endpoint not found (404). Falling back to sequential processing."
                    )
                    return {"error": "Batch API not available", "fallback": "sequential"}

                # Raise for other errors
                response.raise_for_status()

                # Get response data
                response_data = response.json()
                logger.info(f"Batch submitted successfully. Batch ID: {response_data.get('batch_id')}")

                # Add metadata mapping
                response_data["request_metadata"] = {
                    f"req_{i}": request.get("metadata", {}) for i, request in enumerate(batch_requests)
                }

                return response_data

            except requests.exceptions.HTTPError as e:
                if e.response.status_code == 404:
                    logger.warning(
                        "Anthropic Batch API endpoint not found (404). Falling back to sequential processing."
                    )
                    return {"error": "Batch API not available", "fallback": "sequential"}
                else:
                    logger.error(f"HTTP error using Anthropic Batch API: {str(e)}")
                    return {"error": f"HTTP error: {str(e)}"}

            except Exception as e:
                logger.error(f"Error using Anthropic Batch API: {str(e)}")
                return {"error": str(e)}

        except Exception as e:
            logger.error(f"Error preparing batch request: {str(e)}")
            return {"error": str(e)}

    def list_available_models(self) -> list[str]:
        """
        List available Claude models.

        Returns:
            List of hardcoded available model identifiers
        """
        # Anthropic doesn't have a list models endpoint, so we hardcode the known models
        available_models = ["claude-3-5-sonnet-20241022", "claude-3-7-sonnet-20250219", "claude-opus-4-20250514"]
        logger.info(f"Available Anthropic models: {available_models}")
        return available_models

    async def get_completion(self, system: str, prompt: str, max_tokens: int = 4000) -> dict[str, Any]:
        """
        Get a completion from the Anthropic API with the new completion format.
        This method is specifically for the batch report generator.

        Args:
            system: System message/instructions
            prompt: User message/prompt
            max_tokens: Maximum tokens for response

        Returns:
            Dictionary with model response
        """
        logger.info(f"Getting completion from Anthropic API using model: {self.model_name}")

        if not self.api_key:
            logger.error("No Anthropic API key provided for completion")
            return {
                "content": json.dumps(
                    {
                        "id": "polis_narrative_error_message",
                        "title": "API Key Missing",
                        "paragraphs": [
                            {
                                "id": "polis_narrative_error_message",
                                "title": "API Key Missing",
                                "sentences": [
                                    {
                                        "clauses": [
                                            {
                                                "text": "No Anthropic API key provided. Set ANTHROPIC_API_KEY env var or pass api_key parameter.",
                                                "citations": [],
                                            }
                                        ]
                                    }
                                ],
                            }
                        ],
                    }
                )
            }

        try:
            # Use direct HTTP request for completions
            headers = {"x-api-key": self.api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"}

            data = {
                "model": self.model_name,
                "system": system,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max_tokens,
            }

            response = requests.post("https://api.anthropic.com/v1/messages", headers=headers, json=data)

            # Raise for HTTP errors
            response.raise_for_status()

            # Parse response
            response_data = response.json()
            result = response_data["content"][0]["text"]

            return {"content": result}

        except Exception as e:
            logger.error(f"Error in get_completion: {str(e)}")
            return {
                "content": json.dumps(
                    {
                        "id": "polis_narrative_error_message",
                        "title": "Model Error",
                        "paragraphs": [
                            {
                                "id": "polis_narrative_error_message",
                                "title": "Error Processing With Model",
                                "sentences": [
                                    {
                                        "clauses": [
                                            {
                                                "text": f"There was an error using the Anthropic API: {str(e)}",
                                                "citations": [],
                                            }
                                        ]
                                    }
                                ],
                            }
                        ],
                    }
                )
            }


def get_model_provider(provider_type: str = None, model_name: str = None) -> ModelProvider:
    """
    Factory function to get the appropriate model provider.

    Args:
        provider_type: Type of provider ('ollama', 'anthropic')
        model_name: Name of the model to use

    Returns:
        Configured ModelProvider instance
    """
    # Check for environment variable configuration
    provider_type = provider_type or os.environ.get("LLM_PROVIDER")

    if provider_type.lower() == "anthropic":
        model_name = model_name or os.environ.get("ANTHROPIC_MODEL")
        if not model_name:
            raise ValueError("Model name must be specified or ANTHROPIC_MODEL environment variable must be set")
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        logger.info(f"Using Anthropic provider with model: {model_name}")
        return AnthropicProvider(model_name=model_name, api_key=api_key)
    else:
        # Default to Ollama
        model_name = model_name or os.environ.get("OLLAMA_MODEL", "llama3")
        endpoint = os.environ.get("OLLAMA_ENDPOINT", "http://localhost:11434")
        logger.info(f"Using Ollama provider with model: {model_name} at {endpoint}")
        return OllamaProvider(model_name=model_name, endpoint=endpoint)


if __name__ == "__main__":
    # Simple test function
    provider = get_model_provider()
    models = provider.list_available_models()
    print(f"Available models: {models}")

    response = provider.get_response(
        system_message="You are a helpful assistant.", user_message="What is the meaning of life?"
    )
    print(f"Response: {response}")
