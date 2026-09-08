#!/usr/bin/env python3
"""
Model provider module for report generation.

Provides a consistent interface for different LLM backends (Ollama and Anthropic)
allowing for easy configuration and switching between model providers.
"""

import os
import json
import logging
import time
import requests
from typing import Dict, List, Optional, Any, Callable

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Claude Fable 5 runs safety classifiers that can decline a request
# (stop_reason: "refusal", HTTP 200 - not an error). When it's the active
# model, we opt into server-side fallback so a refusal is transparently
# retried on another model within the same call, rather than silently
# producing an empty/missing report. Not supported on the Batch API, so
# this only applies to the direct (non-batch) HTTP calls below.
# See: https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback
FABLE_FALLBACK_MODEL = "claude-opus-4-8"
FABLE_FALLBACK_BETA_HEADER = "server-side-fallback-2026-06-01"


def _anthropic_request_extras(model_name: Optional[str]) -> Dict[str, Any]:
    """
    Build the extra headers/body fields needed for a direct (non-batch)
    Anthropic request, given the active model.

    Returns a dict with "headers" and "body" sub-dicts to merge into the
    request.
    """
    extras: Dict[str, Any] = {"headers": {}, "body": {}}
    if model_name == "claude-fable-5":
        extras["headers"]["anthropic-beta"] = FABLE_FALLBACK_BETA_HEADER
        extras["body"]["fallbacks"] = [{"model": FABLE_FALLBACK_MODEL}]
    return extras


def _narrative_error_json(title: str, text: str) -> str:
    """Build a report_data JSON blob matching the schema the client UI expects."""
    return json.dumps({
        "id": "polis_narrative_error_message",
        "title": title,
        "paragraphs": [
            {
                "id": "polis_narrative_error_message",
                "title": title,
                "sentences": [
                    {
                        "clauses": [
                            {
                                "text": text,
                                "citations": []
                            }
                        ]
                    }
                ]
            }
        ]
    })


def _check_response_for_issues(response_json: dict, model_name: Optional[str]) -> Optional[str]:
    """
    Inspect a completed (non-refused-via-fallback) Anthropic response for
    known problem stop reasons. Logs a warning either way, and returns a
    user-facing error message string if the response should not be treated
    as usable content (e.g. every model in the fallback chain refused).
    """
    stop_reason = response_json.get("stop_reason")
    if stop_reason == "max_tokens":
        logger.warning(
            f"Anthropic response for model {model_name} was truncated by max_tokens; "
            "output may be incomplete/invalid JSON."
        )
    elif stop_reason == "refusal":
        stop_details = response_json.get("stop_details") or {}
        category = stop_details.get("category")
        explanation = stop_details.get("explanation")
        logger.warning(
            f"Anthropic model {model_name} declined the request (stop_reason=refusal, "
            f"category={category}): {explanation}"
        )
        return (
            "This section could not be generated because the request was declined "
            "by the model's safety classifier"
            + (f" (category: {category})" if category else "")
            + ". Try regenerating, or switch to a different model."
        )
    return None


class ModelProvider:
    """Base class for model providers."""

    # Whether this provider can process many prompts in a single asynchronous
    # batch call. Subclasses that support the Anthropic Message Batches API set
    # this to True; the default (e.g. Ollama) processes prompts one-by-one.
    supports_batching: bool = False

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
    
    def list_available_models(self) -> List[str]:
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
            import ollama
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
                    messages=[
                        {"role": "system", "content": system_message},
                        {"role": "user", "content": user_message}
                    ]
                )
                result = response['message']['content'].strip()
            else:
                # Use direct HTTP request as fallback
                response = requests.post(
                    f"{self.endpoint}/api/chat",
                    json={
                        "model": self.model_name,
                        "messages": [
                            {"role": "system", "content": system_message},
                            {"role": "user", "content": user_message}
                        ],
                        "stream": False
                    }
                )
                response.raise_for_status()
                result = response.json()["message"]["content"].strip()
            
            return result
        
        except Exception as e:
            logger.error(f"Error using Ollama: {str(e)}")
            # Return a JSON error response
            return json.dumps({
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
                                        "citations": []
                                    }
                                ]
                            }
                        ]
                    }
                ]
            })
    
    def list_available_models(self) -> List[str]:
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
                if hasattr(models_response, 'models') and isinstance(models_response.models, list):
                    available_models = [m.model for m in models_response.models if m.model is not None]
                else:
                    # Fallback for older API versions or different response format
                    available_models = [n for model in models_response.get('models', []) if (n := model.get('name')) is not None]
            else:
                # Use direct HTTP request as fallback
                response = requests.get(f"{self.endpoint}/api/tags")
                response.raise_for_status()
                available_models = [n for model in response.json().get('models', []) if (n := model.get('name')) is not None]
            
            logger.info(f"Available Ollama models: {available_models}")
            return available_models
        
        except Exception as e:
            logger.error(f"Error listing Ollama models: {str(e)}")
            return []

class AnthropicProvider(ModelProvider):
    """Provider for Anthropic Claude models."""

    # Anthropic supports the Message Batches API.
    supports_batching: bool = True

    # Base URL for the Message Batches API. NOTE the trailing "batches" (plural):
    # the endpoint is POST/GET /v1/messages/batches[/{id}]. An earlier version of
    # this file posted to the singular ".../batch", which does not exist (404).
    BATCH_API_URL = "https://api.anthropic.com/v1/messages/batches"

    def __init__(self, model_name: Optional[str] = None, api_key: Optional[str] = None):
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
            return json.dumps({
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
                                        "citations": []
                                    }
                                ]
                            }
                        ]
                    }
                ]
            })
        
        try:
            logger.info(f"Using Anthropic model: {self.model_name}")

            headers = {
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json"
            }
            logger.info(f"Using Anthropic model '{self.model_name}' via direct HTTP request")
            logger.info(f"API key starts with: {self.api_key[:8]}...")
            extras = _anthropic_request_extras(self.model_name)
            headers.update(extras["headers"])
            data = {
                "model": self.model_name,
                "system": system_message,
                "messages": [
                    {"role": "user", "content": user_message}
                ],
                # max_tokens is a hard cap on thinking + response text combined
                # (adaptive thinking is on by default on Sonnet 5 / Opus 4.8+),
                # so this needs real headroom beyond the visible text length.
                "max_tokens": 8000,
                "output_config": {"effort": "medium"},
                **extras["body"]
            }
            response = requests.post(
                "https://api.anthropic.com/v1/messages",
                headers=headers,
                json=data
            )
            response.raise_for_status()
            response_json = response.json()
            error_message = _check_response_for_issues(response_json, self.model_name)
            if error_message:
                return _narrative_error_json("Model Declined Request", error_message)
            content = response_json["content"]
            text_blocks = [b for b in content if b.get("type") == "text"]
            result = text_blocks[0]["text"] if text_blocks else ""

            return result

        except Exception as e:
            logger.error(f"Error using Anthropic API: {str(e)}")
            # Return a JSON error response
            return json.dumps({
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
                                        "citations": []
                                    }
                                ]
                            }
                        ]
                    }
                ]
            })
    
    def _batch_headers(self) -> Dict[str, str]:
        return {
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

    def get_batch_responses(self, batch_requests: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Create a batch on the Anthropic Message Batches API.

        Args:
            batch_requests: List of request objects already in Batch API shape,
                each a dict with:
                - "custom_id": stable string used to correlate the result back to
                  the caller (results come back in arbitrary order).
                - "params": a Messages API params dict (model, messages,
                  max_tokens, ...). If "model" is omitted, this provider's
                  model_name is injected.

        Returns:
            The created batch object as returned by the API (contains "id",
            "processing_status", and later "results_url"), or a dict with an
            "error" key on failure.

        Note: the server-side "fallbacks" param (used for claude-fable-5 refusal
        recovery in the non-batch path) is rejected by the Batch API and must not
        be added here — a refused item comes back with stop_reason "refusal".
        """
        if not self.api_key:
            logger.error("No Anthropic API key provided for batch requests")
            return {"error": "API key missing"}

        formatted_requests = []
        for req in batch_requests:
            params = dict(req.get("params", {}))
            params.setdefault("model", self.model_name)
            formatted_requests.append(
                {"custom_id": req["custom_id"], "params": params}
            )

        try:
            logger.info(
                f"Submitting batch of {len(formatted_requests)} requests to "
                f"{self.BATCH_API_URL}"
            )
            response = requests.post(
                self.BATCH_API_URL,
                headers=self._batch_headers(),
                json={"requests": formatted_requests},
            )
            response.raise_for_status()
            data = response.json()
            logger.info(
                f"Batch submitted successfully. Batch ID: {data.get('id')} "
                f"status: {data.get('processing_status')}"
            )
            return data
        except Exception as e:
            logger.error(f"Error using Anthropic Batch API: {str(e)}")
            return {"error": str(e)}

    def retrieve_batch(self, batch_id: str) -> Dict[str, Any]:
        """Fetch the current state of a batch (GET /v1/messages/batches/{id})."""
        response = requests.get(
            f"{self.BATCH_API_URL}/{batch_id}",
            headers=self._batch_headers(),
        )
        response.raise_for_status()
        return response.json()

    def poll_batch(
        self,
        batch_id: str,
        max_wait_seconds: float = 1800.0,
        initial_interval: float = 5.0,
        max_interval: float = 60.0,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], float] = time.monotonic,
    ) -> Dict[str, Any]:
        """
        Poll a batch until its processing_status is "ended", with exponential
        backoff. Raises TimeoutError if the batch does not end within
        max_wait_seconds.

        Returns the final (ended) batch object, which carries "results_url".
        """
        deadline = now() + max_wait_seconds
        interval = initial_interval
        while True:
            batch = self.retrieve_batch(batch_id)
            status = batch.get("processing_status")
            if status == "ended":
                return batch
            remaining = deadline - now()
            if remaining <= 0:
                raise TimeoutError(
                    f"Batch {batch_id} did not complete within {max_wait_seconds}s "
                    f"(last status: {status})"
                )
            counts = batch.get("request_counts", {})
            logger.info(
                f"Batch {batch_id} status={status} counts={counts}; "
                f"sleeping {min(interval, remaining):.0f}s"
            )
            sleep(min(interval, remaining))
            interval = min(interval * 2, max_interval)

    def get_batch_results(self, batch: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Download and parse the JSONL results of an ended batch.

        Args:
            batch: an ended batch object (must contain "results_url").

        Returns:
            A list of result records, each a dict with "custom_id" and "result".
        """
        results_url = batch.get("results_url")
        if not results_url:
            raise ValueError("Batch has no results_url; is it ended?")
        response = requests.get(results_url, headers=self._batch_headers())
        response.raise_for_status()
        records = []
        for line in response.text.splitlines():
            line = line.strip()
            if line:
                records.append(json.loads(line))
        return records

    @staticmethod
    def extract_text_from_result(record: Dict[str, Any]) -> Optional[str]:
        """
        Pull the assistant text out of a single batch result record.

        Returns None if the request did not succeed (errored/canceled/expired/
        refusal) or produced no text block.
        """
        result = record.get("result", {})
        if result.get("type") != "succeeded":
            return None
        message = result.get("message", {})
        if message.get("stop_reason") == "refusal":
            return None
        content = message.get("content", [])
        text_blocks = [b.get("text", "") for b in content if b.get("type") == "text"]
        return text_blocks[0] if text_blocks else None


    def list_available_models(self) -> List[str]:
        """
        List available Claude models.

        Returns:
            List of hardcoded available model identifiers
        """
        # Anthropic doesn't have a list models endpoint, so we hardcode the known models
        available_models = [
            "claude-fable-5",
            "claude-sonnet-5",
            "claude-opus-4-8",
            "claude-sonnet-4-6",
        ]
        logger.info(f"Available Anthropic models: {available_models}")
        return available_models

    async def get_completion(self, system: str, prompt: str, max_tokens: int = 8000) -> Dict[str, Any]:
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
            return {"content": json.dumps({
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
                                        "citations": []
                                    }
                                ]
                            }
                        ]
                    }
                ]
            })}

        try:
            # Use direct HTTP request for completions
            headers = {
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json"
            }

            extras = _anthropic_request_extras(self.model_name)
            headers.update(extras["headers"])
            data = {
                "model": self.model_name,
                "system": system,
                "messages": [
                    {"role": "user", "content": prompt}
                ],
                # max_tokens is a hard cap on thinking + response text combined
                # (adaptive thinking is on by default on Sonnet 5 / Opus 4.8+).
                "max_tokens": max_tokens,
                "output_config": {"effort": "medium"},
                **extras["body"]
            }

            response = requests.post(
                "https://api.anthropic.com/v1/messages",
                headers=headers,
                json=data
            )

            # Raise for HTTP errors
            response.raise_for_status()

            # Parse response — filter by type to skip thinking blocks (Sonnet 5+)
            response_data = response.json()
            error_message = _check_response_for_issues(response_data, self.model_name)
            if error_message:
                return {"content": _narrative_error_json("Model Declined Request", error_message)}
            content = response_data["content"]
            text_blocks = [b for b in content if b.get("type") == "text"]
            result = text_blocks[0]["text"] if text_blocks else ""

            return {"content": result}

        except Exception as e:
            logger.error(f"Error in get_completion: {str(e)}")
            return {"content": json.dumps({
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
                                        "citations": []
                                    }
                                ]
                            }
                        ]
                    }
                ]
            })}

def get_model_provider(provider_type: Optional[str] = None, model_name: Optional[str] = None) -> ModelProvider:
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

    if not provider_type:
        raise ValueError("provider_type must be specified or LLM_PROVIDER environment variable must be set")

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
        # Honor OLLAMA_HOST (used by the ollama client and the rest of Delphi),
        # falling back to the older OLLAMA_ENDPOINT name.
        endpoint = (
            os.environ.get("OLLAMA_HOST")
            or os.environ.get("OLLAMA_ENDPOINT")
            or "http://localhost:11434"
        )
        logger.info(f"Using Ollama provider with model: {model_name} at {endpoint}")
        return OllamaProvider(model_name=model_name, endpoint=endpoint)

if __name__ == "__main__":
    # Simple test function
    provider = get_model_provider()
    models = provider.list_available_models()
    print(f"Available models: {models}")
    
    response = provider.get_response(
        system_message="You are a helpful assistant.",
        user_message="What is the meaning of life?"
    )
    print(f"Response: {response}")